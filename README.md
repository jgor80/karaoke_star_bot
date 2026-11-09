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

Plays are deduplicated by KaraFun's play id, and a "night" runs 6am to 6am.

## Deploying the site

```
cd site
npx wrangler deploy
```

## Not in this repo

- Play history data (CSV and database files) stays out, since this repo is public
  and the data has singers' names.
- The "Karaoke Night Stats" dashboard is a Claude dashboard artifact whose
  queries live in the artifact itself, not in files.
