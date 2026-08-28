# Premium 3D Timer — Android

This project packages the Premium 3D Timer React app as an Android APK using Capacitor.

## GitHub build

The repository includes a GitHub Actions workflow at:

`.github/workflows/build-apk.yml`

It builds a debug APK automatically when you push the project.

## Local build

```bash
npm install
npm run build
npx cap add android
npx cap sync android
cd android
./gradlew assembleDebug
```

APK output:

`android/app/build/outputs/apk/debug/app-debug.apk`
