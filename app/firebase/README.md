# Firebase config for push (kept out of git)

Put the two files from the Firebase console here (Project settings > Your apps):

- `GoogleService-Info.plist` (the iOS app, bundle ID `com.okenight.app`)
- `google-services.json` (the Android app, package `com.okenight.app`)

`npm run build` copies them where the iPhone and Android projects need them. On GitHub Actions, set them as
secrets instead: `FIREBASE_IOS_PLIST_B64` and `FIREBASE_ANDROID_JSON_B64` (each file base64-encoded) and pass
them to the build step's environment. Without them the app still builds and runs, just without push.
