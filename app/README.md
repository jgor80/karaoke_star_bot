# Oke Night phone app

The iPhone and Android app (`com.okenight.app`). It is a [Capacitor](https://capacitorjs.com) shell
around the singer page from okenight.com. It is for singers only: there's no host page and no bar pitch or
billing. Tips to the host (Venmo) stay.

| Part | What it does |
|---|---|
| `shell/index.html` | The app's first screen. Pick your bar (the list comes from `okenight.com/api/venues` and is saved for offline use), or try **Demo Night**. It also has the karaoke-night reminder switch, Privacy, Terms, Contact and the 21+ line. |
| `shell/remind.js` | Reminders are **local notifications**, set on the phone three hours before the bar's next two karaoke nights. They're redone every time the app opens, so a cancelled night drops off. The same switch turns on **push** (Firebase): the phone's token is registered with the bar at `okenight.com/<bar>/api/push` (`site/src/push_api.js`) on every open. A host who enters the bar's host key on the first screen also gets the host alerts. |
| `build.mjs` | Builds `www/`. `venue.html` is made from `site/src/index.html`: the site's scripts are inlined, and a head script adds `<base href="https://okenight.com/<bar>/">`, `OKE_VENUE`, `OKE_SITE` and app mode. The page's API calls go to the site, which allows the app's origins (`site/src/origins.js`). |
| `ios/`, `android/` | Native projects made by `cap add`. Icons and splash screens come from `assets/` via `@capacitor/assets`. |

The app includes everything the site's singer page has: the live show, reactions, photos with Report and
Hide, song search, requests, bingo, drafts and duets. So **build it after the site PRs it depends on are
merged**:
- #107: Report, Hide and photo approval;
- #109: Demo Night;
- #110: CORS and app mode;
- #111: the page's own dialogs.

## Build

```sh
cd app
npm install
npm run build        # www/ from site/src (npm run check also parses every script)
npx cap sync         # copy www/ and plugins into ios/ and android/
```

- **Android (what we use):** the **Android app** GitHub workflow (`.github/workflows/android-release.yml`). On pull requests it does a debug build. From Actions > Android app > Run workflow, it makes a signed `.aab` for Google Play, saved on the run page under Artifacts. Signing needs the secrets `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD` (the upload key; Play App Signing holds the real key). Or locally: `npm run android` opens Android Studio, then Build > Generate Signed Bundle.
- **iPhone:** you need a Mac with Xcode, or a cloud Mac. Windows can't build iOS apps. `npm run ios` opens Xcode on a Mac. Then:
  1. Choose Signing & Capabilities > Team (Synthwave Web LLC).
  2. Choose Product > Archive, then Distribute > App Store Connect.
- **Without a Mac (what we use):** the **iPhone app** GitHub workflow (`.github/workflows/ios-testflight.yml`) builds on a GitHub cloud Mac. On pull requests it does a simulator build to check that the app compiles. From Actions > iPhone app > Run workflow, it signs the app and uploads it to App Store Connect / TestFlight. The upload needs four repository secrets, listed at the top of that file.

Build numbers come from the GitHub run number, so each upload is new. Change the version (1.0) in Xcode (Version) and in the Android workflow (`ANDROID_VERSION_NAME`) for a new release.

## Push notifications (Firebase)

What each phone can get:

| Notification | Who | When |
|---|---|---|
| Karaoke tonight 🎤 | Anyone with Remind me on | 3 hours before the bar's next two nights (local, no server) |
| Karaoke is live 🎤 | Anyone with Remind me on, for their bar | The first song of the night (Worker cron, `pushLive`) |
| Your song request is in 🎶 | The phone(s) that asked | The host marks the request Added on /host |
| Host alerts | Phones that entered the host key | Secret song found, song request, photo to check, photo/name reported, new bar lead, laptop offline/back, karaoke app not open, crowd meter can't hear, line runs past close, last call, morning report, /host test push |

Host alerts still go to the host's ntfy topic too, as a backup.

One-time setup:
1. **Firebase:** create a project at console.firebase.google.com, add an iOS app and an Android app, both
   `com.okenight.app`. Download `GoogleService-Info.plist` and `google-services.json` into `app/firebase/`
   (kept out of git) or set them as GitHub secrets `FIREBASE_IOS_PLIST_B64` and `FIREBASE_ANDROID_JSON_B64`.
2. **Apple push key:** developer.apple.com > Certificates, IDs & Profiles > Keys > + > Apple Push
   Notifications service (APNs). Download the .p8, then in Firebase > Project settings > Cloud Messaging >
   Apple app configuration, upload it with the Key ID and Team ID. The app already has the Push
   Notifications entitlement (`ios/App/App/App.entitlements`).
3. **Worker secret:** Firebase > Project settings > Service accounts > Generate new private key, then
   `npx wrangler secret put FCM_SERVICE_ACCOUNT` in `site/` and paste the whole JSON file. Until it's set
   the site sends no app pushes (ntfy keeps working).

## App Review notes (paste into App Store Connect)

> Oke Night shows a live karaoke night at a participating bar: who's singing, the line, reactions and
> awards. No account or sign-in is needed. Karaoke is usually once a week, so to see a live show at any time,
> open the app and tap **Demo Night** on the first screen. It's a sample show that is always on, and nothing
> is saved there.
>
> - **User content:** singers can add a photo and a name. Photos need the host's approval before anyone
>   sees them. Anyone can tap a singer's name to **Report** a photo or name (two reports hide it right
>   away and alert the host) or **Hide** a photo on their own phone. Names go through a word filter.
>   Objectionable content is removed by the host, or by us at info@synthwaveweb.com.
> - **Accounts:** there are none, so there's no account to delete. A singer can remove their photo in the
>   app, or ask the host or info@synthwaveweb.com to remove their name.
> - **Payments:** no in-app purchases. A bar's page can show a Tip button that opens the host's own payment
>   app (Venmo, Cash App, PayPal or Zelle) to thank the host for running the night in person at the bar. In the
>   app the only choices are thank-you tips ("Thanks for hosting", "Buy the host a drink", any amount). All of
>   it goes to the host, and nothing in the app is unlocked (3.1.3(e), 3.2.1(vii)). The bar's own $20/month
>   plan is sold only on the website and never shown in the app.
> - **Native features:** notifications (karaoke-night reminders, "karaoke is live", "your song request is
>   in", and for a bar's host only, host alerts after entering their host key), the photo picker or camera
>   for your singer photo, and an offline first screen. To see one right away: turn on **Remind me** on the
>   first screen, then tap **Send a test notification**.
> - **Age:** the bars are 21+ and the app is rated 17+.

**App Privacy label** (draft from the round-4 review; it's not legal advice):

| Data | Collected? | Linked to the person? | Used for tracking? |
|---|---|---|---|
| Name | Yes | Yes | No |
| Photos | Yes | Yes | No |
| User ID (the random phone ID) | Yes | Yes | No |
| Device ID (the notification address from Firebase) | Yes | Yes | No |
| Other user content (requests, reactions) | Yes | — | — |
| Diagnostics (salted IP hash, kept 90 days) | Yes | No | No |
| Location | No (it stays on the phone) | — | — |
| Contact info | No | — | — |

There is no tracking.

**Age rating:** 17+ (frequent or intense alcohol references because of the bar setting; user-generated
content).
