# Dart Recording Collector

Browser page for collecting 3-camera dart throw/removal sessions.

## What It Does

- opens 3 selected cameras
- requests `1280x720` at about `30fps`
- records all 3 streams for 80 seconds
- creates one ZIP containing:
  - `camera_0.webm`
  - `camera_1.webm`
  - `camera_2.webm`
  - `session.json`
- uploads the ZIP to Firebase Storage when `firebase-config.js` is filled in
- downloads the ZIP locally if Firebase config is not filled in

## Run Locally

From the main detection folder:

```powershell
python -m http.server 8000
```

Open:

```text
http://localhost:8000/collection_site/
```

Browsers allow camera access on `localhost`.

## Firebase Setup

1. Open Firebase Console.
2. Create or choose a project.
3. Add a Web App.
4. Copy the Firebase config into `firebase-config.js`.
5. Enable Firebase Storage.
6. Make sure your Storage rules allow the upload path you use.

Default upload folder:

```text
dart-recording-sessions/
```

For early testing only, permissive Storage rules may look like:

```text
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /dart-recording-sessions/{fileName} {
      allow write: if true;
      allow read: if true;
    }
  }
}
```

Do not use public write rules permanently.
