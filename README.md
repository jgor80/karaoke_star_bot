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

## Folders

| Folder | What it is |
| --- | --- |
| `sync/` | Python sync script and the Windows installers for the daily and live (during the night) scheduled tasks. |
| `schema/` | The D1 database schema (tables, indexes, views). |
| `site/` | The public phone site: a Cloudflare Worker (`src/worker.js`) serving `src/index.html` and reading D1. `/tv` (`src/tv.html`) is a TV screen that scrolls the latest night's awards, top singers, badges, favorite songs and artists, decade and hour charts and dares (press F, double-click, or use the button that appears when the mouse moves for full screen); `?night=YYYY-MM-DD` pins a night, `?speed=2` scrolls faster. Night awards live in `src/awards.js`, shared by both pages. Live emoji reactions (`src/reactions_api.js`): anyone can tap 🔥 🎤 🍅 😴 and friends on the song on the mic; they feed crowd awards, badges and the TV. |
| `site/` Songbook | The Songbook tab (`src/songs.js`) searches KaraFun's whole catalog (`/api/catalog`, `src/catalog_api.js`). The Worker's every-minute cron downloads KaraFun's published song list (the CSV on karafun.com/karaoke-song-list.html, about 90,000 songs) once a week and writes only what changed (`src/catalog_import.js`); no laptop needed and lets each person keep a list of songs they want to sing. The list is saved on their phone (no accounts) and songs tick off by themselves once that person sings them. |
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

## Not in this repo

- Play history data (CSV and database files) stays out, since this repo is public
  and the data has singers' names.
- The "Karaoke Night Stats" dashboard is a Claude dashboard artifact whose
  queries live in the artifact itself, not in files.
