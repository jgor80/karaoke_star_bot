# Oke Night phone app

The iPhone and Android app (`com.okenight.app`). It is a [Capacitor](https://capacitorjs.com) shell
around the singer page from okenight.com. It is for singers only: there's no host page and no bar pitch or
billing. Tips to the host (Venmo) stay.

| Part | What it does |
|---|---|
| `shell/index.html` | The app's first screen. Pick your bar (the list comes from `okenight.com/api/venues` and is saved for offline use), or try **Demo Night**. It also has the karaoke-night reminder switch, Privacy, Terms, Contact and the 21+ line. |
| `shell/remind.js` | Reminders are **local notifications**, set on the phone three hours before the bar's next two karaoke nights. They're redone every time the app opens, so a cancelled night drops off. No push server needed. |
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

- **Android:** `npm run android` opens Android Studio. Then use Build > Generate Signed Bundle (.aab) for Google Play.
- **iPhone:** you need a Mac with Xcode, or a cloud Mac. Windows can't build iOS apps. `npm run ios` opens Xcode on a Mac. Then:
  1. Choose Signing & Capabilities > Team (Synthwave Web LLC).
  2. Choose Product > Archive, then Distribute > App Store Connect.
- **Without a Mac (what we use):** the **iPhone app** GitHub workflow (`.github/workflows/ios-testflight.yml`) builds on a GitHub cloud Mac. On pull requests it does a simulator build to check that the app compiles. From Actions > iPhone app > Run workflow, it signs the app and uploads it to App Store Connect / TestFlight. The upload needs four repository secrets, listed at the top of that file.

Bump the version in Xcode (Version/Build) and in `android/app/build.gradle` (`versionName`/`versionCode`) for each upload.

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
> - **Payments:** no in-app purchases. A bar's page can show a Tip button that opens Venmo to pay the host
>   directly, for things the host does in person at the bar (for example, playing a song sooner). All of it
>   goes to the host, and nothing in the app is unlocked (3.1.3(e), 3.2.1(vii)). The bar's own $20/month
>   plan is sold only on the website and never shown in the app.
> - **Native features:** karaoke-night reminders (local notifications), the photo picker or camera for
>   your singer photo, and an offline first screen.
> - **Age:** the bars are 21+ and the app is rated 17+.

**App Privacy label** (draft from the round-4 review; it's not legal advice):

| Data | Collected? | Linked to the person? | Used for tracking? |
|---|---|---|---|
| Name | Yes | Yes | No |
| Photos | Yes | Yes | No |
| User ID (the random phone ID) | Yes | Yes | No |
| Other user content (requests, reactions) | Yes | — | — |
| Diagnostics (salted IP hash, kept 90 days) | Yes | No | No |
| Location | No (it stays on the phone) | — | — |
| Contact info | No | — | — |

There is no tracking.

**Age rating:** 17+ (frequent or intense alcohol references because of the bar setting; user-generated
content).
