import { firebaseConfig, storageFolder } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDownloadURL,
  getStorage,
  ref,
  uploadBytesResumable,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
import {
  getAuth,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

const RECORD_SECONDS = 60;
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const SYNC_FLASH_MS = 180;
const RECORDER_START_SETTLE_MS = 250;
const MAX_FPS_DRIFT = 2.5;

const els = {
  loadCamerasBtn: document.querySelector("#loadCamerasBtn"),
  previewBtn: document.querySelector("#previewBtn"),
  recordBtn: document.querySelector("#recordBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  selects: [
    document.querySelector("#camera0"),
    document.querySelector("#camera1"),
    document.querySelector("#camera2"),
  ],
  videos: [
    document.querySelector("#video0"),
    document.querySelector("#video1"),
    document.querySelector("#video2"),
  ],
  metas: [
    document.querySelector("#meta0"),
    document.querySelector("#meta1"),
    document.querySelector("#meta2"),
  ],
  timer: document.querySelector("#timer"),
  recordState: document.querySelector("#recordState"),
  uploadStatus: document.querySelector("#uploadStatus"),
  uploadProgress: document.querySelector("#uploadProgress"),
  downloadLink: document.querySelector("#downloadLink"),
  log: document.querySelector("#log"),
};

let streams = [];
let recorders = [];
let chunksByCamera = [[], [], []];
let recordingTimer = null;
let stopRecordingResolve = null;
let secondsLeft = RECORD_SECONDS;
let firebaseApp = null;
let firebaseStorage = null;
let firebaseAuth = null;
let firebaseReady = false;
let captureSessions = [];
let recorderDiagnostics = [];
let syncMarker = null;
let lastSyncFlash = null;
let currentMimeType = "";
let recordCanvases = [];
let recordContexts = [];
let recordStreams = [];
let recordDrawLoopId = null;
let recordFrameNumber = 0;
let recordLoopStartMs = null;

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  els.log.textContent += `${line}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function stopRecordDrawLoop() {
  if (recordDrawLoopId !== null) {
    window.cancelAnimationFrame(recordDrawLoopId);
    recordDrawLoopId = null;
  }
}

function stopRecordStreams() {
  recordStreams.forEach((stream) => {
    stream.getTracks().forEach((track) => track.stop());
  });
  recordStreams = [];
}

function resetRecordPipeline() {
  stopRecordDrawLoop();
  stopRecordStreams();
  recordCanvases = [];
  recordContexts = [];
  recordFrameNumber = 0;
  recordLoopStartMs = null;
}

function ensureRecordCanvases() {
  if (recordCanvases.length === 3 && recordContexts.length === 3) {
    return;
  }

  recordCanvases = [0, 1, 2].map(() => {
    const c = document.createElement("canvas");
    c.width = WIDTH;
    c.height = HEIGHT;
    return c;
  });
  recordContexts = recordCanvases.map((canvas) =>
    canvas.getContext("2d", { alpha: false, willReadFrequently: false }),
  );
}

function startRecordDrawLoop() {
  stopRecordDrawLoop();
  recordFrameNumber = 0;
  recordLoopStartMs = performance.now();

  const draw = () => {
    recordFrameNumber += 1;
    const nowMs = performance.now();
    const elapsedMs = nowMs - (recordLoopStartMs || nowMs);

    for (let i = 0; i < 3; i += 1) {
      const video = els.videos[i];
      const ctx = recordContexts[i];
      if (!video || !ctx) {
        continue;
      }

      ctx.drawImage(video, 0, 0, WIDTH, HEIGHT);

      // Overlay a tiny shared clock for post-alignment diagnostics.
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.fillRect(8, 8, 290, 30);
      ctx.fillStyle = "#ffffff";
      ctx.font = "16px monospace";
      ctx.fillText(`f=${recordFrameNumber} t=${elapsedMs.toFixed(1)}ms`, 14, 28);
    }

    recordDrawLoopId = window.requestAnimationFrame(draw);
  };

  recordDrawLoopId = window.requestAnimationFrame(draw);
}

function buildVideoConstraints(deviceId, useExact) {
  const sizeMode = useExact ? "exact" : "ideal";
  return {
    deviceId: { exact: deviceId },
    width: { [sizeMode]: WIDTH },
    height: { [sizeMode]: HEIGHT },
    frameRate: { [sizeMode]: FPS },
  };
}

function getTrackCapabilities(track) {
  if (typeof track.getCapabilities !== "function") {
    return null;
  }
  try {
    return track.getCapabilities();
  } catch {
    return null;
  }
}

function getTrackConstraints(track) {
  if (typeof track.getConstraints !== "function") {
    return null;
  }
  try {
    return track.getConstraints();
  } catch {
    return null;
  }
}

function buildQualityWarnings(settings) {
  const warnings = [];
  if (settings.width && settings.width < WIDTH) {
    warnings.push(`width ${settings.width} < ${WIDTH}`);
  }
  if (settings.height && settings.height < HEIGHT) {
    warnings.push(`height ${settings.height} < ${HEIGHT}`);
  }
  if (settings.frameRate && Math.abs(settings.frameRate - FPS) > MAX_FPS_DRIFT) {
    warnings.push(`fps ${settings.frameRate} far from ${FPS}`);
  }
  return warnings;
}

function formatSettings(settings, modeLabel) {
  return `${settings.width || "?"}x${settings.height || "?"} @ ${settings.frameRate || "?"}fps (${modeLabel})`;
}

async function openPreferredStream(deviceId, index) {
  const attempts = [
    { mode: "exact", constraints: buildVideoConstraints(deviceId, true) },
    { mode: "fallback", constraints: buildVideoConstraints(deviceId, false) },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: attempt.constraints,
      });
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings() || {};
      const warnings = buildQualityWarnings(settings);
      return {
        stream,
        mode: attempt.mode,
        settings,
        constraints: getTrackConstraints(track),
        capabilities: getTrackCapabilities(track),
        warnings,
        openedAtMs: performance.now(),
        cameraIndex: index,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Camera ${index + 1} could not open at ${WIDTH}x${HEIGHT} ${FPS}fps: ${lastError?.message || "unknown error"}`);
}

async function ensureVideoPlaying(video) {
  video.playsInline = true;
  video.muted = true;
  await video.play();
}

function getOrCreateSyncMarker() {
  if (syncMarker) {
    return syncMarker;
  }
  syncMarker = document.createElement("div");
  syncMarker.id = "syncMarker";
  Object.assign(syncMarker.style, {
    position: "fixed",
    inset: "0",
    background: "#ffffff",
    opacity: "0",
    pointerEvents: "none",
    zIndex: "9999",
    transition: "opacity 24ms linear",
  });
  document.body.appendChild(syncMarker);
  return syncMarker;
}

async function showSyncFlash() {
  const marker = getOrCreateSyncMarker();
  const startedAtMs = performance.now();
  marker.style.opacity = "1";
  await sleep(SYNC_FLASH_MS);
  marker.style.opacity = "0";
  await sleep(40);
  return {
    startedAtMs,
    endedAtMs: performance.now(),
    durationMs: SYNC_FLASH_MS,
  };
}

function collectPreviewStats() {
  return els.videos.map((video, index) => {
    const quality =
      typeof video.getVideoPlaybackQuality === "function"
        ? video.getVideoPlaybackQuality()
        : null;
    return {
      index,
      currentTime: video.currentTime || 0,
      width: video.videoWidth || 0,
      height: video.videoHeight || 0,
      totalVideoFrames: quality?.totalVideoFrames ?? null,
      droppedVideoFrames: quality?.droppedVideoFrames ?? null,
    };
  });
}

function hasFirebaseConfig() {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.projectId &&
      firebaseConfig.storageBucket &&
      firebaseConfig.appId
  );
}

async function initFirebase() {
  if (firebaseReady) {
    return true;
  }
  if (!hasFirebaseConfig()) {
    return false;
  }

  firebaseApp = firebaseApp || initializeApp(firebaseConfig);
  firebaseStorage = firebaseStorage || getStorage(firebaseApp);
  firebaseAuth = firebaseAuth || getAuth(firebaseApp);

  await signInAnonymously(firebaseAuth);
  firebaseReady = true;
  return true;
}

async function loadCameras() {
  log("Requesting camera permission...");
  const permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  permissionStream.getTracks().forEach((track) => track.stop());

  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === "videoinput");
  if (cameras.length < 3) {
    throw new Error(`Need at least 3 cameras, found ${cameras.length}.`);
  }

  els.selects.forEach((select, selectIndex) => {
    select.innerHTML = "";
    cameras.forEach((camera, cameraIndex) => {
      const option = document.createElement("option");
      option.value = camera.deviceId;
      option.textContent = camera.label || `Camera ${cameraIndex + 1}`;
      select.appendChild(option);
    });
    select.selectedIndex = Math.min(selectIndex, cameras.length - 1);
  });

  els.previewBtn.disabled = false;
  log(`Loaded ${cameras.length} camera devices.`);
}

async function startPreview() {
  stopStreams();
  const deviceIds = els.selects.map((select) => select.value);
  if (new Set(deviceIds).size !== 3) {
    throw new Error("Please select three different cameras.");
  }

  captureSessions = await Promise.all(deviceIds.map((deviceId, index) => openPreferredStream(deviceId, index)));
  streams = captureSessions.map((entry) => entry.stream);

  captureSessions.forEach((entry, index) => {
    const { stream, settings, mode, warnings } = entry;
    els.videos[index].srcObject = stream;
    els.metas[index].textContent = formatSettings(settings, mode);
    if (warnings.length > 0) {
      log(`Camera ${index + 1} warning: ${warnings.join(", ")}`);
    }
  });
  await Promise.all(els.videos.map((video) => ensureVideoPlaying(video)));

  const weakStreams = captureSessions.filter((entry) => entry.warnings.length > 0);
  if (weakStreams.length > 0) {
    els.uploadStatus.textContent = "Preview ready, but one or more cameras did not negotiate ideal capture settings.";
  } else {
    els.uploadStatus.textContent = "Preview ready. All cameras negotiated close to 1280x720 @ 30fps.";
  }

  els.recordBtn.disabled = false;
  log("Preview started.");
}

function stopStreams() {
  streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  streams = [];
  captureSessions = [];
  recorderDiagnostics = [];
  resetRecordPipeline();
  els.videos.forEach((video) => {
    video.srcObject = null;
  });
}

function getMimeType() {
  const candidates = [
    "video/webm;codecs=vp8",
    "video/webm;codecs=vp9",
    "video/webm",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function startRecording() {
  if (streams.length !== 3) {
    await startPreview();
  }

  chunksByCamera = [[], [], []];
  recorders = [];
  secondsLeft = RECORD_SECONDS;
  els.timer.textContent = String(secondsLeft);
  els.recordState.textContent = "Recording";
  els.uploadStatus.textContent = "Recording in progress...";
  els.uploadProgress.value = 0;
  els.downloadLink.hidden = true;
  els.recordBtn.disabled = true;
  els.stopBtn.disabled = false;

  const mimeType = getMimeType();
  currentMimeType = mimeType;
  recorderDiagnostics = streams.map((stream, index) => ({
    index,
    mimeType,
    requestedStartMs: null,
    startedAtMs: null,
    firstChunkAtMs: null,
    stoppedAtMs: null,
    chunkCount: 0,
    bytes: 0,
    trackSettingsAtRecordStart: stream.getVideoTracks()[0]?.getSettings() || {},
  }));

  resetRecordPipeline();
  ensureRecordCanvases();
  startRecordDrawLoop();
  recordStreams = recordCanvases.map((canvas) => canvas.captureStream(FPS));

  recordStreams.forEach((stream, index) => {
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.onstart = () => {
      recorderDiagnostics[index].startedAtMs = performance.now();
    };
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunksByCamera[index].push(event.data);
        recorderDiagnostics[index].chunkCount += 1;
        recorderDiagnostics[index].bytes += event.data.size;
        if (recorderDiagnostics[index].firstChunkAtMs == null) {
          recorderDiagnostics[index].firstChunkAtMs = performance.now();
        }
      }
    };
    recorders.push(recorder);
  });

  const stopped = new Promise((resolve) => {
    stopRecordingResolve = resolve;
  });

  let stoppedCount = 0;
  recorders.forEach((recorder, index) => {
    recorder.onstop = () => {
      recorderDiagnostics[index].stoppedAtMs = performance.now();
      stoppedCount += 1;
      if (stoppedCount === recorders.length && stopRecordingResolve) {
        stopRecordingResolve();
      }
    };
  });

  recorders.forEach((recorder, index) => {
    recorderDiagnostics[index].requestedStartMs = performance.now();
    recorder.start(100);
  });

  await sleep(RECORDER_START_SETTLE_MS);
  const syncFlash = await showSyncFlash();
  lastSyncFlash = syncFlash;
  log(`Sync flash fired at ${syncFlash.startedAtMs.toFixed(1)}ms for ${SYNC_FLASH_MS}ms.`);
  els.uploadStatus.textContent = "Recording in progress with sync flash marker captured.";

  log("Recording started for 60 seconds.");
  recordingTimer = window.setInterval(() => {
    secondsLeft -= 1;
    els.timer.textContent = String(Math.max(0, secondsLeft));
    if (secondsLeft <= 0) {
      stopRecording();
    }
  }, 1000);

  await stopped;
  await packageAndUpload();
}

function stopRecording() {
  if (recordingTimer) {
    window.clearInterval(recordingTimer);
    recordingTimer = null;
  }
  recorders.forEach((recorder) => {
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
  });
  stopRecordDrawLoop();
  els.stopBtn.disabled = true;
  els.recordState.textContent = "Processing";
  log("Recording stopped.");
}

async function packageAndUpload() {
  const sessionId = `dart_session_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const zip = new JSZip();
  const previewStats = collectPreviewStats();
  const manifest = {
    sessionId,
    createdAt: new Date().toISOString(),
    durationSeconds: RECORD_SECONDS - secondsLeft,
    requestedWidth: WIDTH,
    requestedHeight: HEIGHT,
    requestedFps: FPS,
    mimeType: currentMimeType || getMimeType(),
    browser: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform || null,
    },
    syncFlash: lastSyncFlash,
    recordPipeline: {
      mode: "canvas-capture-stream",
      targetFps: FPS,
      frameCount: recordFrameNumber,
      drawLoopStartedAtMs: recordLoopStartMs,
    },
    previewStats,
    cameras: streams.map((stream, index) => ({
      index,
      label: els.selects[index].selectedOptions[0]?.textContent || `Camera ${index + 1}`,
      settings: stream.getVideoTracks()[0]?.getSettings() || {},
      constraints: captureSessions[index]?.constraints || null,
      capabilities: captureSessions[index]?.capabilities || null,
      openMode: captureSessions[index]?.mode || null,
      warnings: captureSessions[index]?.warnings || [],
      openedAtMs: captureSessions[index]?.openedAtMs || null,
      recorder: recorderDiagnostics[index] || null,
    })),
  };

  chunksByCamera.forEach((chunks, index) => {
    const blob = new Blob(chunks, { type: chunks[0]?.type || "video/webm" });
    zip.file(`camera_${index}.webm`, blob);
    manifest.cameras[index].blobSizeBytes = blob.size;
  });
  zip.file("session.json", JSON.stringify(manifest, null, 2));

  manifest.cameras.forEach((camera) => {
    const warningText = camera.warnings?.length ? ` warnings=${camera.warnings.join(", ")}` : "";
    log(
      `Camera ${camera.index + 1}: ${camera.settings.width || "?"}x${camera.settings.height || "?"} @ ${camera.settings.frameRate || "?"}fps` +
        ` blob=${camera.blobSizeBytes || 0}B mode=${camera.openMode || "unknown"}${warningText}`,
    );
  });

  stopRecordStreams();

  els.uploadStatus.textContent = "Creating ZIP...";
  const zipBlob = await zip.generateAsync(
    { type: "blob", compression: "DEFLATE", compressionOptions: { level: 5 } },
    (metadata) => {
      els.uploadProgress.value = Math.round(metadata.percent * 0.5);
    }
  );

  const localUrl = URL.createObjectURL(zipBlob);
  els.downloadLink.href = localUrl;
  els.downloadLink.download = `${sessionId}.zip`;
  els.downloadLink.textContent = `Download ${sessionId}.zip`;
  els.downloadLink.hidden = false;

  if (!(await initFirebase())) {
    els.uploadStatus.textContent = "Firebase config is empty. ZIP is ready for local download.";
    els.uploadProgress.value = 100;
    els.recordState.textContent = "Ready";
    els.recordBtn.disabled = false;
    log("ZIP created locally. Fill firebase-config.js to enable upload.");
    return;
  }

  els.uploadStatus.textContent = "Uploading ZIP to Firebase Storage...";
  const storageRef = ref(firebaseStorage, `${storageFolder}/${sessionId}.zip`);
  const uploadTask = uploadBytesResumable(storageRef, zipBlob, {
    contentType: "application/zip",
    customMetadata: {
      sessionId,
      durationSeconds: String(manifest.durationSeconds),
    },
  });

  await new Promise((resolve, reject) => {
    uploadTask.on(
      "state_changed",
      (snapshot) => {
        const pct = snapshot.totalBytes
          ? (snapshot.bytesTransferred / snapshot.totalBytes) * 100
          : 0;
        els.uploadProgress.value = 50 + Math.round(pct * 0.5);
      },
      reject,
      resolve
    );
  });

  const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
  els.uploadStatus.innerHTML = `Uploaded to Firebase Storage: <a href="${downloadUrl}" target="_blank" rel="noreferrer">open file</a>`;
  els.uploadProgress.value = 100;
  els.recordState.textContent = "Uploaded";
  els.recordBtn.disabled = false;
  log(`Upload complete: ${downloadUrl}`);
}

els.loadCamerasBtn.addEventListener("click", () => {
  loadCameras().catch((error) => {
    log(`ERROR: ${error.message}`);
    els.uploadStatus.textContent = error.message;
  });
});

els.previewBtn.addEventListener("click", () => {
  startPreview().catch((error) => {
    log(`ERROR: ${error.message}`);
    els.uploadStatus.textContent = error.message;
  });
});

els.recordBtn.addEventListener("click", () => {
  startRecording().catch((error) => {
    log(`ERROR: ${error.message}`);
    els.uploadStatus.textContent = error.message;
    els.recordState.textContent = "Error";
    els.recordBtn.disabled = false;
    els.stopBtn.disabled = true;
  });
});

els.stopBtn.addEventListener("click", stopRecording);

window.addEventListener("beforeunload", stopStreams);

log("Recorder loaded. Start with Load Cameras.");
