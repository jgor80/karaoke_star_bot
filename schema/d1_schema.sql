-- Cloudflare D1 database "karaoke-stats" (binding DB in site/wrangler.toml).
-- Dumped from the live database on 2026-11-08. The sync script
-- (sync/karaoke_sync.py) uploads plays here; the site reads from it.

CREATE TABLE plays (
  uuid text primary key,          -- KaraFun's id for this play
  played_at integer not null,     -- unix seconds (UTC)
  played_at_local text,
  night text,                     -- karaoke night, 6am to 6am local
  session_start integer,
  singer text,
  type_id integer,                -- 1 = catalog song
  song_id integer,
  artist text,
  title text,
  release_year integer,
  length_s integer,
  pitch integer,
  tempo integer,
  lead_vocal_a real,
  lead_vocal_b real,
  backing real,
  first_seen text
);
CREATE INDEX plays_night on plays(night);
CREATE INDEX plays_played_at on plays(played_at);
CREATE INDEX plays_singer on plays(singer);

CREATE TABLE sessions (session_start integer primary key, session_end integer, name text);

CREATE TABLE sync_runs (ran_at text primary key, device text, source_rows integer, uploaded integer);

CREATE VIEW v_night_stats as select night, count(*) as songs, count(distinct singer) as singers, min(played_at_local) as first_song, max(played_at_local) as last_song from plays group by night order by night;
CREATE VIEW v_singer_stats as select singer, count(*) as songs, count(distinct night) as nights, min(played_at_local) as first_song, max(played_at_local) as last_song from plays group by singer order by songs desc;
CREATE VIEW v_song_stats as select artist, title, count(*) as times_sung, count(distinct singer) as singers from plays where title is not null group by song_id order by times_sung desc;
CREATE VIEW v_artist_stats as select artist, count(*) as times_sung from plays where artist is not null group by artist order by times_sung desc;

-- Live emoji reactions from the phone site (POST /api/react). The Worker creates this table itself
-- (CREATE TABLE IF NOT EXISTS in site/src/reactions_api.js), so there's no manual migration.
-- device_id is a random id kept on the phone and ip_hash a daily-salted hash; both are only for rate
-- limiting and are never returned by the API. `who` is the name the person typed, or "Anon XXXX".
CREATE TABLE IF NOT EXISTS reactions (
  id integer primary key autoincrement,
  play_uuid text not null,        -- plays.uuid of the song on the mic
  night text, singer text,        -- copied from plays when the reaction comes in
  reaction text not null,         -- fire, micdrop, encore, chills, dance, keychange, cringe, offkey, tomato, snooze
  who text not null,
  device_id text not null,
  ip_hash text,
  created_at integer not null     -- unix seconds (UTC)
);
CREATE INDEX IF NOT EXISTS reactions_play on reactions(play_uuid);
CREATE INDEX IF NOT EXISTS reactions_device on reactions(device_id, created_at);
CREATE INDEX IF NOT EXISTS reactions_ip on reactions(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS reactions_night on reactions(night);

-- Secret songs hidden by the host on okenight.com/host. The Worker creates these tables itself
-- (site/src/secrets_api.js). Unfound titles and rewards are only returned with the host key.
CREATE TABLE IF NOT EXISTS secret_songs (
  id integer primary key autoincrement,
  title text not null, artist text, reward text,
  created_at integer not null,     -- unix seconds; only songs sung after this count
  found_uuid text,                 -- plays.uuid of the first matching song
  found_at integer,
  notified_at integer              -- when the ntfy push went out (once per secret)
);
-- key_salt + key_hash (sha256 of the host key), ntfy_topic (random, for push alerts)
CREATE TABLE IF NOT EXISTS host_config (k text primary key, v text not null);

-- KaraFun's song catalog for the site's Songbook (GET /api/catalog, site/src/catalog_api.js).
-- Loaded weekly from KaraFun's published CSV by sync/karaoke_catalog.py (run from the daily sync),
-- which creates these itself. rowid = KaraFun song id (= plays.song_id); pop = popularity rank (1 = top).
-- k = title + artist without apostrophes, dots and slashes, so "dont stop" finds "Don't Stop Believin'".
CREATE VIRTUAL TABLE IF NOT EXISTS catalog USING fts5(title, artist, k, year UNINDEXED, duo UNINDEXED,
  explicit UNINDEXED, styles UNINDEXED, languages UNINDEXED, added UNINDEXED, pop UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS catalog_meta (k text primary key, v text);  -- count, updated
