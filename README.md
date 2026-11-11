# Karaoke Star Bot

Stats for karaoke nights run on KaraFun: who sang what, top songs and artists,
night recaps, awards and bingo, on a public phone site the crowd can open while
the night is going.

## How it fits together

```
KaraFun desktop (Windows laptop)
  %APPDATA%\KaraFun\user_database.db   (KaraFun keeps only the last 200 songs)
        |
        |  sync/karaoke_sync.py  (daily task, or --watch during a night)
        v
  local backup: Documents\KaraokeStats\karaoke_stats.db
        |
        |  uploads new plays
        v
  Cloudflare D1 "karaoke-stats"   (schema/d1_schema.sql)
        |
        v
  site/  Cloudflare Worker: public, read-only, mobile-first stats site
```

## Venues

okenight.com is an intro page for Oke Night with a bar picker (closest bar first when the phone shares its
location) and a "Bring Oke Night to your bar" form (saved to D1 `leads`, pushed to the first venue's host ntfy topic).
Each bar has its own pages under its slug: `/wbl/` (phone page), `/wbl/tv`, `/wbl/host`, `/wbl/sunday.ics` and
its API at `/wbl/api/...`. The list of bars is `site/src/venues.js`; `/api/venues` returns it as JSON (with
whether each one is on tonight) for the picker and the app. Old links (`/tv`, `/host`) redirect to `/wbl/...`,
`/sunday.ics` and `/api/...` without a venue still mean Welcome Back Lounge.

Each bar's data is kept apart by a `venue` column (see the end of `schema/d1_schema.sql`). To add a bar: add an
entry to `venues.js` (the slug never changes once it's on a QR code), deploy, set its host key on `/<slug>/host`,
and put its slug in that laptop's `karaoke_sync_config.json` as `"venue": "<slug>"`. The sync files that bar's plays, queue,
heartbeat and crowd mic under its slug; a laptop with no `venue` is Welcome Back Lounge (`wbl`).

## Folders

| Folder | What it is |
| --- | --- |
| `sync/` | Python sync script and the Windows installers for the daily and live (during the night) scheduled tasks. |
| `schema/` | The D1 database schema (tables, indexes, views). |
| `site/` | The public phone site: a Cloudflare Worker (`src/worker.js`) serving `src/index.html` and reading D1. `/tv` (`src/tv.html`) is a TV screen that scrolls the latest night's awards, top singers, badges, favorite songs and artists, decade and hour charts and dares (press F, double-click, or use the button that appears when the mouse moves for full screen); `?night=YYYY-MM-DD` pins a night, `?speed=2` scrolls faster. Night awards live in `src/awards.js`, shared by both pages. Live emoji reactions (`src/reactions_api.js`): anyone can tap 🔥 🎤 🍅 😴 and friends on the song on the mic; they feed crowd awards, badges and the TV. |
| `site/` Songbook | The Songbook tab (`src/songs.js`) searches and filters (genre, decade, language, duets, top hits, sort) KaraFun's whole catalog (`/api/catalog`, `src/catalog_api.js`). The Worker's every-minute cron downloads KaraFun's published song list (the CSV on karafun.com/karaoke-song-list.html, about 90,000 songs) once a week and writes only what changed (`src/catalog_import.js`); no laptop needed and lets each person keep a list of songs they want to sing. The list is saved on their phone (no accounts) and songs tick off by themselves once that person sings them. |
| `awards/` | "The Mics" night awards and recap card page. |
| `bingo/` | Karaoke bingo cards. The site uses its own copy in `site/src/bingo.js`. |

## Setting up the sync on the laptop

1. Install Python 3.
2. Put the files from `sync/` in one folder.
3. Copy `karaoke_sync_config.sample.json` to `karaoke_sync_config.json` and fill
   in your Cloudflare account ID and an API token with D1 edit access.
   **Never commit `karaoke_sync_config.json`.** It is in `.gitignore`.
4. Run `install_daily_sync.bat` (daily at noon) and, if you want stats updating
   during the night, `install_live_sync.bat`.

Plays are deduplicated by KaraFun's play id, and a "night" runs 6am to 6am. A play that
changes in KaraFun after it was uploaded (a singer name fixed, say) is sent again. If
KaraFun's 200-song history rolled over before a sync could copy it, `sync_log.txt` says so.
During the night, the phone site shows a "stats paused" note when the laptop hasn't
synced for 15 minutes.

## Deploying the site

```
cd site
npx wrangler deploy
```

## The host page

`/host` is the host's page: hide secret songs, get alerts when one is sung, and set the
host's singer name. The site and the TV show that name with a 🎤 Host tag (it starts as
Bleacher Jeff).

The Tips card on `/host` sets the host's Venmo handle and the tip menu. Once a handle is
saved, phones get a 💸 Tip button in the header; each menu item opens Venmo with the amount
and a note filled in. Leave the handle empty to hide the button.

Setting up the host key, or resetting a forgotten one, needs a setup code that only the
owner of the Cloudflare account can set. Set it once:

```
cd site
npx wrangler secret put HOST_SETUP_CODE
```

Then open `/host`, tap "Forgot the key? Reset it with the setup code", and enter the setup
code and a new host key. Without the secret, nobody can set or reset the key.

## Crowd meter

The crowd meter scores the applause after each song (the PA drowns out the crowd during
the song, so only the cheering right after it counts). Each song gets 0-10: how far the
loudest 3 seconds of applause rose above the room's normal chatter, 2.5 dB per point.
The scores show next to songs on the phone site, as a banner on `/tv` about a minute after
each song, and as the "Loudest Crowd" award (and "Biggest Ovation of the Season").
Mics aren't calibrated, so it's a relative score: keep the mic in the same spot each week.

Two mics can feed it. Only loudness numbers (one per second) are sent, never sound.

- **The KaraFun laptop** (main one). `karaoke_sync.py --watch` reads the laptop's mic while
  karaoke is on (a song in the last 45 minutes, or people in the queue) and closes it after.
  It needs `python -m pip install sounddevice` (`install_live_sync.bat` does this).
  Turn off anything that evens out loudness, or loud cheers get squashed:
  - Windows 11: Settings > System > Sound > your mic > **Audio enhancements: Off**, and keep the
    input volume fixed (around 70-80%). Windows 10: Control Panel > Sound > Recording > mic >
    Properties > Enhancements/Advanced > disable all enhancements.
  - Any mic app from the laptop maker (Realtek Audio Console, Dolby, MaxxAudio, Teams/Zoom
    "automatically adjust mic"): turn off noise suppression, echo cancellation and auto gain.
  - Settings > Privacy > Microphone > "Let desktop apps access your microphone" must be on.
  - To use a USB mic instead of the built-in one, add `"crowd_mic_device": "part of its name"`
    to `karaoke_sync_config.json`. `"crowd_mic": false` turns the meter off.
  - `sync_log.txt` says "crowd meter: listening on ..." when it starts.
- **A phone at the host table** (backup or second spot). Open `/host`, tap
  **Start listening** under "Crowd meter mic" and leave the page open and the phone plugged
  in. The browser's auto gain, noise suppression and echo cancelling are turned off.

### Song requests and auto-filing

People can tap **Request a song** in the Songbook for songs that aren't in the list. Requests show
on `/host` (with search links for Karaoke Version and YouTube) and push to the host's ntfy topic.

While `karaoke_sync.py --watch` runs on the karaoke laptop, it checks the Downloads folder every
30 seconds. It moves karaoke tracks you bought (`.cdg`/`.kfn`, an `.mp3` with a matching `.cdg`,
a zip of those, or a video/audio file with "karaoke" in the name) into your karaoke songs folder.
If the file name contains an open request's title (and artist, when given), it marks that request
added. Add that folder to the karaoke player's local library once. Config keys in
`karaoke_sync_config.json`: `"karaoke_dir"` (default `~/Music/Karaoke Songs`), `"downloads_dir"`
(default `~/Downloads`), and `"auto_file": false` to turn it off. Each move is logged in `sync_log.txt`.

When both are listening, the laptop's readings are used. The Worker's every-minute cron
scores each song once its applause window has closed (`site/src/crowd_api.js`), and the
raw levels are kept 45 days.

## Not in this repo

- Play history data (CSV and database files) stays out, since this repo is public
  and the data has singers' names.
- The "Karaoke Night Stats" dashboard is a Claude dashboard artifact whose
  queries live in the artifact itself, not in files.
