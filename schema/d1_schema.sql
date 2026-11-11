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

-- KaraFun's song queue, so the phone site can show how many are waiting and the rough wait.
-- One row (id = 1) replaced by sync/karaoke_sync.py whenever the queue changes; the Worker also
-- creates the table itself (site/src/worker.js). items is JSON: [{id: song id, singer, len: seconds}],
-- in queue order, with the song on the mic first once it has started.
CREATE TABLE IF NOT EXISTS live_queue (id integer primary key, updated_at integer not null, items text not null);

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
-- The Worker's cron downloads KaraFun's published CSV weekly and creates/updates these itself
-- (site/src/catalog_import.js). rowid = KaraFun song id (= plays.song_id); pop = popularity rank
-- (1 = top); h = hash of what was sent, so refreshes only rewrite changed songs.
-- k = title + artist without apostrophes, dots and slashes, so "dont stop" finds "Don't Stop Believin'".
CREATE VIRTUAL TABLE IF NOT EXISTS catalog USING fts5(title, artist, k, year UNINDEXED, duo UNINDEXED,
  explicit UNINDEXED, styles UNINDEXED, languages UNINDEXED, added UNINDEXED, pop UNINDEXED, h UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS catalog_meta (k text primary key, v text);  -- count, updated, last_attempt, last_result, last_error

-- Singer voice for the Songbook voice filters, looked up on MusicBrainz a few artists a minute by the
-- Worker cron (site/src/voice_import.js). voice: m, f, mix (man + woman duet credit), band, ? (unknown), NULL (not yet).
CREATE TABLE IF NOT EXISTS artist_voice (artist text primary key, pop integer, voice text, checked integer);
CREATE INDEX IF NOT EXISTS artist_voice_todo ON artist_voice (voice, pop);
CREATE INDEX IF NOT EXISTS artist_voice_v ON artist_voice (voice, artist);
CREATE TABLE IF NOT EXISTS mb_person (nk text primary key, kind text, gender text, checked integer);  -- MusicBrainz answer by normalized name

-- Crowd draft (POST /api/draft): the crowd drafts someone who has sung here to sing a KaraFun song,
-- and seconds the picks they like. The Worker creates these tables itself (site/src/drafts_api.js).
-- night is the karaoke night the pick is for; device_id/ip_hash are only for rate limits and never returned.
-- Blocked singers (host page) live in host_config k = 'draft_blocked' as a JSON list of lowercase names.
CREATE TABLE IF NOT EXISTS drafts (
  id integer primary key autoincrement,
  night text not null, singer text not null, singer_key text not null,
  song_id integer, title text not null, artist text,
  by_name text not null, device_id text not null, ip_hash text,
  created_at integer not null, removed_at integer);
CREATE TABLE IF NOT EXISTS draft_votes (
  draft_id integer not null, device_id text not null, ip_hash text, night text not null, created_at integer not null,
  primary key (draft_id, device_id));

-- Crowd meter (site/src/crowd_api.js; the Worker and the laptop's sync create these themselves).
-- crowd_levels: one loudness reading a second in dBFS (never audio), src = 'laptop' or 'phone'. Kept 45 days.
CREATE TABLE IF NOT EXISTS crowd_levels (ts integer not null, src text not null, db real not null, PRIMARY KEY (ts, src)) WITHOUT ROWID;
-- crowd_scores: per song, the applause peak, the room's chatter level (base) and how far above it the
-- applause went (over, dB). over is NULL when nobody was listening.
CREATE TABLE IF NOT EXISTS crowd_scores (uuid text primary key, src text, peak real, base real, over real, scored_at integer not null);

-- Song requests from the Songbook ("Request a song"): songs people want that aren't in the song list.
-- Only the host sees them (/host + ntfy push). Created by site/src/requests_api.js.
CREATE TABLE IF NOT EXISTS song_requests (
  id integer primary key autoincrement, title text not null, artist text, k text not null,
  names text, votes integer not null default 1, status text not null default 'open',  -- open | added | unavailable
  created_at integer not null, updated_at integer not null);
CREATE INDEX IF NOT EXISTS song_requests_k ON song_requests (k, status);
CREATE TABLE IF NOT EXISTS song_request_asks (
  request_id integer not null, device_id text not null, ip_hash text, day text not null, created_at integer not null,
  primary key (request_id, device_id));
CREATE INDEX IF NOT EXISTS song_request_asks_dev ON song_request_asks (device_id, day);
CREATE INDEX IF NOT EXISTS song_request_asks_ip ON song_request_asks (ip_hash, day);

-- Venues (site/src/venues.js). Each bar lives at okenight.com/<slug>/. The Worker adds
--   venue text not null default 'wbl'
-- (plus an index <table>_venue) to plays, sync_runs, live_queue, reactions, drafts, secret_songs and
-- song_requests by itself, so rows from before venues existed, and anything the laptop sync writes without a
-- venue, belong to Welcome Back Lounge ("wbl"). Per-bar settings in host_config use the plain key for "wbl" and
-- "<slug>:<key>" for other venues. crowd_levels keeps its (ts, src) key: other venues write src "<slug>:laptop".

-- "Bring Oke Night to your bar" form on okenight.com (site/src/leads_api.js). Never shown publicly.
CREATE TABLE IF NOT EXISTS leads (
  id integer primary key autoincrement, name text, bar text not null, city text, contact text not null,
  role text, note text, ip_hash text, day text not null, created_at integer not null);
CREATE INDEX IF NOT EXISTS leads_ip ON leads (ip_hash, day);

-- The host's own songbook, per venue (uploaded on /host; site/src/songbook_api.js). Same columns as catalog, ids from 1,000,000,000.
-- host_config (via cfgKey): songbook_source = catalog | mine | both (which list the Songbook tab searches), songbook_count, songbook_updated.
CREATE VIRTUAL TABLE IF NOT EXISTS songbook USING fts5(title, artist, k, year UNINDEXED, duo UNINDEXED, explicit UNINDEXED,
  styles UNINDEXED, languages UNINDEXED, added UNINDEXED, pop UNINDEXED, venue UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
