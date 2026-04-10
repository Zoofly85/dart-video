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

function log(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  els.log.textContent += `${line}\n`;
  els.log.scrollTop = els.log.scrollHeight;
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

  streams = await Promise.all(
    deviceIds.map((deviceId) =>
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: WIDTH },
          height: { ideal: HEIGHT },
          frameRate: { ideal: FPS },
        },
      })
    )
  );

  streams.forEach((stream, index) => {
    els.videos[index].srcObject = stream;
    const settings = stream.getVideoTracks()[0]?.getSettings() || {};
    els.metas[index].textContent = `${settings.width || "?"}x${settings.height || "?"} @ ${
      settings.frameRate || "?"
    }fps`;
  });

  els.recordBtn.disabled = false;
  log("Preview started.");
}

function stopStreams() {
  streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  streams = [];
  els.videos.forEach((video) => {
    video.srcObject = null;
  });
}

function getMimeType() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
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
  streams.forEach((stream, index) => {
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunksByCamera[index].push(event.data);
      }
    };
    recorders.push(recorder);
  });

  const stopped = new Promise((resolve) => {
    stopRecordingResolve = resolve;
  });

  let stoppedCount = 0;
  recorders.forEach((recorder) => {
    recorder.onstop = () => {
      stoppedCount += 1;
      if (stoppedCount === recorders.length && stopRecordingResolve) {
        stopRecordingResolve();
      }
    };
    recorder.start(1000);
  });

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
  els.stopBtn.disabled = true;
  els.recordState.textContent = "Processing";
  log("Recording stopped.");
}

async function packageAndUpload() {
  const sessionId = `dart_session_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const zip = new JSZip();
  const manifest = {
    sessionId,
    createdAt: new Date().toISOString(),
    durationSeconds: RECORD_SECONDS - secondsLeft,
    requestedWidth: WIDTH,
    requestedHeight: HEIGHT,
    requestedFps: FPS,
    cameras: streams.map((stream, index) => ({
      index,
      label: els.selects[index].selectedOptions[0]?.textContent || `Camera ${index + 1}`,
      settings: stream.getVideoTracks()[0]?.getSettings() || {},
    })),
  };

  chunksByCamera.forEach((chunks, index) => {
    const blob = new Blob(chunks, { type: chunks[0]?.type || "video/webm" });
    zip.file(`camera_${index}.webm`, blob);
  });
  zip.file("session.json", JSON.stringify(manifest, null, 2));

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
