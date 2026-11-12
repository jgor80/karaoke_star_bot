"""Copy KaraFun play history into a permanent karaoke stats database.

KaraFun keeps only recent history in %APPDATA%\\KaraFun\\user_database.db,
so this script runs daily and adds any new plays and sessions to
karaoke_stats.db. Rows are keyed by KaraFun's own ids, so running it
again never creates duplicates.

If karaoke_sync_config.json sits next to this script, new plays are also
uploaded to the Cloudflare D1 database it names.

With --watch it keeps running and syncs within seconds whenever KaraFun
writes a new song, so the public stats site stays live during a session.

It also uploads KaraFun's song queue (singer and song length only), so the
site can show how many people are waiting and roughly how long the wait is.

Crowd meter: with --watch and the sounddevice package installed (pip install sounddevice),
it also reads the laptop's mic once a second while karaoke is on (a song in the last
45 minutes, or people in the queue) and uploads the loudness level only, never audio.
The site scores the applause after each song from it (site/src/crowd_api.js).
Turn audio enhancements off for the mic in Windows so cheers aren't flattened (see README).
Config keys (optional): "crowd_mic": false turns it off; "crowd_mic_device": "part of the mic's name".

Song requests: with --watch it also files karaoke tracks you download. Every 30 seconds it looks
in your Downloads folder for new karaoke files (.cdg/.kfn, an .mp3 with a matching .cdg, a zip of
those, or a video or audio file with "karaoke" in its name), moves them into your karaoke songs folder,
and marks any open song request (from the site's "Request a song") whose title is in the file name
as added, so the person who asked sees it on their phone.
Config keys (optional): "venue" (the bar's slug on okenight.com, default "wbl": plays, the queue, the heartbeat,
the crowd mic and requests are all filed under it); "auto_file": false turns it off; "downloads_dir" (default ~/Downloads);
"karaoke_dir" (default ~/Music/Karaoke Songs), the folder your karaoke player reads local songs from.

Usage: python karaoke_sync.py [--watch] [--source PATH] [--target PATH] [--config PATH]
"""
import argparse
import json
import re
import unicodedata
import zipfile
import zlib
import math
import datetime as dt
import os
import shutil
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

APPDATA = os.environ.get("APPDATA", os.path.expanduser("~"))
DEFAULT_SOURCE = os.path.join(APPDATA, "KaraFun", "user_database.db")
DEFAULT_TARGET = os.path.join(os.path.expanduser("~"), "Documents", "KaraokeStats", "karaoke_stats.db")
DEFAULT_CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "karaoke_sync_config.json")
NIGHT_CUTOFF_HOURS = 6  # songs before 6am count toward the previous night
WATCH_POLL_S = 5          # how often --watch looks at KaraFun's database files
WATCH_HEARTBEAT_S = 600   # with no changes, still sync this often so the site knows we're alive
WATCH_LOCK_PORT = 47913   # a local port held while --watch runs, so only one copy runs

# Crowd meter (see crowd_meter below). Keep CROWD_TABLE in sync with site/src/crowd_api.js.
CROWD_TABLE = ("create table if not exists crowd_levels (ts integer not null, src text not null,"
               " db real not null, primary key (ts, src)) without rowid")
CROWD_ACTIVE_S = 45 * 60  # listen while a song was sung in the last 45 minutes, or the queue has people
CROWD_UPLOAD_S = 10       # send the levels every 10 seconds
CROWD_KEEP = 1800         # keep up to 30 minutes of levels while offline

SCHEMA = """
create table if not exists sessions (
  session_start integer primary key,  -- unix seconds
  session_end   integer,
  name          text
);
create table if not exists plays (
  uuid          text primary key,     -- KaraFun's id for this play
  played_at     integer not null,     -- unix seconds
  session_start integer,
  singer        text,
  type_id       integer,              -- 1 = catalog song
  song_id       integer,
  artist        text,
  title         text,
  release_year  integer,
  length_s      integer,
  pitch         integer,
  tempo         integer,
  lead_vocal_a  real,
  lead_vocal_b  real,
  backing       real,
  game_stats    blob,
  first_seen    text not null         -- when this script first saved it
);
create index if not exists plays_played_at on plays(played_at);
create index if not exists plays_singer on plays(singer);
create table if not exists d1_uploaded (
  uuid        text primary key,
  uploaded_at text not null
);
-- When a play that already went to Cloudflare changes (a singer name fixed in KaraFun,
-- a title filled in), forget that it was uploaded so the next upload re-sends it.
create trigger if not exists plays_resend after update on plays
when old.singer is not new.singer or old.artist is not new.artist or old.title is not new.title
  or old.release_year is not new.release_year or old.length_s is not new.length_s
  or old.session_start is not new.session_start
begin
  delete from d1_uploaded where uuid = new.uuid;
end;
create table if not exists sync_runs (
  ran_at      text primary key,
  source_rows integer,
  new_plays   integer,
  total_plays integer
);

create view if not exists v_plays as
  select datetime(played_at, 'unixepoch', 'localtime') as played_at_local,
         datetime(session_start, 'unixepoch', 'localtime') as session_start_local,
         singer, artist, title, release_year, length_s
  from plays order by played_at;
create view if not exists v_singer_stats as
  select singer, count(*) as songs, count(distinct date(played_at - 6*3600, 'unixepoch', 'localtime')) as nights,
         datetime(min(played_at), 'unixepoch', 'localtime') as first_song,
         datetime(max(played_at), 'unixepoch', 'localtime') as last_song
  from plays group by singer order by songs desc;
create view if not exists v_song_stats as
  select artist, title, count(*) as times_sung, count(distinct singer) as singers
  from plays where title is not null group by song_id order by times_sung desc;
create view if not exists v_artist_stats as
  select artist, count(*) as times_sung from plays
  where artist is not null group by artist order by times_sung desc;
create view if not exists v_night_stats as
  -- a night runs 6am to 6am, so songs after midnight count toward the evening before
  select date(played_at - 6*3600, 'unixepoch', 'localtime') as night, count(*) as songs,
         count(distinct singer) as singers,
         time(min(played_at), 'unixepoch', 'localtime') as first_song,
         time(max(played_at), 'unixepoch', 'localtime') as last_song
  from plays group by night order by night;
"""

READ_PLAYS = """
select h.uuid, h.timestamp, h.session_timestamp, h.singer_name, h.type_id, h.ref_id,
       s.artist, s.title, s.release_year, s.len,
       h.song_pitch, h.song_tempo, h.song_lead_a, h.song_lead_b, h.song_backing, h.game_stats
from history_item h left join song s on s.song_id = h.ref_id and h.type_id = 1
"""

# type_id 2 = a KaraFun "community" song (user-made karaoke). Its title lives in the
# community table, not in song. Older KaraFun versions may lack that table.
READ_COMMUNITY = "select community_id, artist, title, len from community"
FILL_COMMUNITY = """
update plays set artist = coalesce(artist, ?), title = coalesce(title, ?), length_s = coalesce(length_s, ?)
where type_id = 2 and song_id = ? and title is null
"""

# KaraFun saves its queue in queue_item, rewritten in order (item_id 1, 2, ...) on every change.
# The first item is the song on the mic once it starts. Only singer, song id and length leave the laptop.
READ_QUEUE = """
select q.item_ref_id, q.singer_name, coalesce(s.len, c.len)
from queue_item q
left join song s on q.item_type_id = 1 and s.song_id = q.item_ref_id
left join community c on q.item_type_id = 2 and c.community_id = q.item_ref_id
order by q.item_id
"""
READ_QUEUE_NO_COMMUNITY = """
select q.item_ref_id, q.singer_name, s.len
from queue_item q left join song s on q.item_type_id = 1 and s.song_id = q.item_ref_id
order by q.item_id
"""
QUEUE_MAX = 100

UPSERT_PLAY = """
insert into plays (uuid, played_at, session_start, singer, type_id, song_id, artist, title,
                   release_year, length_s, pitch, tempo, lead_vocal_a, lead_vocal_b, backing,
                   game_stats, first_seen)
values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
on conflict(uuid) do update set
  session_start = coalesce(excluded.session_start, plays.session_start),
  singer        = excluded.singer,
  artist        = coalesce(excluded.artist, plays.artist),
  title         = coalesce(excluded.title, plays.title),
  release_year  = coalesce(excluded.release_year, plays.release_year),
  length_s      = coalesce(excluded.length_s, plays.length_s),
  game_stats    = coalesce(excluded.game_stats, plays.game_stats)
"""

UPSERT_SESSION = """
insert into sessions (session_start, session_end, name) values (?,?,?)
on conflict(session_start) do update set
  session_end = coalesce(excluded.session_end, sessions.session_end),
  name        = coalesce(excluded.name, sessions.name)
"""


def sync(source, target):
    if not os.path.exists(source):
        raise SystemExit(f"KaraFun database not found: {source}")
    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)

    # Work from a copy so a running KaraFun is never disturbed.
    with tempfile.TemporaryDirectory() as tmp:
        snap = os.path.join(tmp, "karafun_snapshot.db")
        shutil.copy2(source, snap)
        for ext in ("-wal", "-shm"):
            if os.path.exists(source + ext):
                shutil.copy2(source + ext, snap + ext)
        src = sqlite3.connect(snap)
        plays = src.execute(READ_PLAYS).fetchall()
        sessions = src.execute("select start_time, end_time, name from history_session").fetchall()
        try:
            community = src.execute(READ_COMMUNITY).fetchall()
        except sqlite3.Error:
            community = []
        queue = read_queue(src)
        src.close()

    now = dt.datetime.now().isoformat(timespec="seconds")
    db = sqlite3.connect(target)
    with db:
        db.executescript(SCHEMA)
        before = db.execute("select count(*) from plays").fetchone()[0]
        # KaraFun keeps only its last 200 plays. If its oldest play is newer than the newest one
        # we already saved, some plays fell out of KaraFun before this script could copy them.
        newest_saved = db.execute("select max(played_at) from plays").fetchone()[0]
        oldest_source = min((p[1] for p in plays), default=None)
        gap = bool(before and newest_saved and oldest_source and oldest_source > newest_saved)
        db.executemany(UPSERT_SESSION, sessions)
        db.executemany(UPSERT_PLAY, [tuple(p) + (now,) for p in plays])
        # Fill in titles of community songs. The plays_resend trigger re-sends any play that changes.
        db.executemany(FILL_COMMUNITY, [(c[1], c[2], c[3], c[0]) for c in community])
        total = db.execute("select count(*) from plays").fetchone()[0]
        db.execute("insert or replace into sync_runs values (?,?,?,?)", (now, len(plays), total - before, total))
    db.close()
    return len(plays), total - before, total, gap, queue


def read_queue(src):
    """KaraFun's queue as a list of {id, singer, len}, or None if this KaraFun version has no queue table."""
    for sql in (READ_QUEUE, READ_QUEUE_NO_COMMUNITY):
        try:
            rows = src.execute(sql).fetchall()
            break
        except sqlite3.Error:
            rows = None
    if rows is None:
        return None
    return [{"id": r[0], "singer": (r[1] or "").strip()[:40], "len": r[2]} for r in rows[:QUEUE_MAX]]


D1_PLAY_COLS = ["uuid", "played_at", "played_at_local", "night", "session_start", "singer",
                "type_id", "song_id", "artist", "title", "release_year", "length_s", "pitch",
                "tempo", "lead_vocal_a", "lead_vocal_b", "backing", "first_seen"]
D1_MAX_PARAMS = 90  # D1 allows 100 bound parameters per statement


def local_times(ts):
    t = dt.datetime.fromtimestamp(ts)
    night = (t - dt.timedelta(hours=NIGHT_CUTOFF_HOURS)).date().isoformat()
    return t.isoformat(sep=" ", timespec="seconds"), night


DEFAULT_VENUE = "wbl"  # the first bar on okenight.com; rows written before venues existed belong to it


def venue_of(cfg):
    """The bar this laptop syncs for: "venue" in the config (its slug on okenight.com), default wbl."""
    return str(cfg.get("venue") or DEFAULT_VENUE).strip().lower()


def with_venue(send_with, send_without):
    """Write with the venue column; on a database the site hasn't given that column yet, write without it
    (the site adds it on its first request, defaulting old rows to the first bar)."""
    try:
        return send_with()
    except Exception as e:
        if "venue" not in str(e).lower():
            raise
        return send_without()


def d1_query(cfg, sql, params):
    url = ("https://api.cloudflare.com/client/v4/accounts/%s/d1/database/%s/query"
           % (cfg["account_id"], cfg["database_id"]))
    req = urllib.request.Request(
        url, data=json.dumps({"sql": sql, "params": params}).encode(), method="POST",
        headers={"Authorization": "Bearer " + cfg["api_token"], "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Cloudflare said {e.code}: {e.read().decode(errors='replace')[:300]}")
    if not body.get("success"):
        raise RuntimeError(f"Cloudflare error: {body.get('errors')}")
    return body


def upsert_rows(cfg, table, cols, key, update_cols, rows):
    per = max(1, D1_MAX_PARAMS // len(cols))
    for i in range(0, len(rows), per):
        chunk = rows[i:i + per]
        ph = ",".join("(" + ",".join("?" * len(cols)) + ")" for _ in chunk)
        upd = ", ".join(f"{c} = coalesce(excluded.{c}, {table}.{c})" for c in update_cols)
        sql = f"insert into {table} ({','.join(cols)}) values {ph} on conflict({key}) do update set {upd}"
        d1_query(cfg, sql, [v for row in chunk for v in row])


def upload(target, cfg):
    """Send sessions and not-yet-uploaded plays to D1. Returns plays uploaded."""
    db = sqlite3.connect(target)
    sessions = db.execute("select session_start, session_end, name from sessions").fetchall()
    plays = db.execute(
        "select uuid, played_at, session_start, singer, type_id, song_id, artist, title, release_year,"
        " length_s, pitch, tempo, lead_vocal_a, lead_vocal_b, backing, first_seen from plays"
        " where uuid not in (select uuid from d1_uploaded) order by played_at").fetchall()
    rows = []
    for p in plays:
        played_local, night = local_times(p[1])
        rows.append([p[0], p[1], played_local, night] + list(p[2:]))
    # Only send sessions around the plays being uploaded; older ones are already in D1.
    if rows:
        oldest = min(r[1] for r in rows) - 86400
        sessions = [x for x in sessions if x[0] is not None and x[0] >= oldest]
    else:
        sessions = []
    if sessions:
        upsert_rows(cfg, "sessions", ["session_start", "session_end", "name"], "session_start",
                    ["session_end", "name"], sessions)
    # Each play is filed under this laptop's bar. A play's venue never changes once uploaded.
    venue = venue_of(cfg)
    with_venue(lambda: upsert_rows(cfg, "plays", D1_PLAY_COLS + ["venue"], "uuid", D1_PLAY_COLS[2:],
                                   [r + [venue] for r in rows]),
               lambda: upsert_rows(cfg, "plays", D1_PLAY_COLS, "uuid", D1_PLAY_COLS[2:], rows))
    now = dt.datetime.now().isoformat(timespec="seconds")
    with db:
        db.executemany("insert or replace into d1_uploaded values (?,?)", [(r[0], now) for r in rows])
    # Name the columns: the Worker adds a venue column to sync_runs (site/src/venues.js), so a
    # positional insert fails on every run and the site thinks the sync has stopped.
    beat = [now, os.environ.get("COMPUTERNAME", ""), len(plays), len(rows)]
    with_venue(lambda: d1_query(cfg, "insert or replace into sync_runs (ran_at, device, source_rows, uploaded, venue)"
                                " values (?,?,?,?,?)", beat + [venue]),
               lambda: d1_query(cfg, "insert or replace into sync_runs (ran_at, device, source_rows, uploaded)"
                                " values (?,?,?,?)", beat))
    db.close()
    return len(rows)


_queue_sent = None  # last queue sent to D1 by this process, so an unchanged queue isn't re-sent


def upload_queue(cfg, queue):
    """Replace the one-row live_queue table in D1 when the queue changed. Returns True if it sent."""
    global _queue_sent
    items = json.dumps(queue, separators=(",", ":"))
    if items == _queue_sent:
        return False
    if _queue_sent is None:
        d1_query(cfg, "create table if not exists live_queue"
                 " (id integer primary key, updated_at integer not null, items text not null)", [])
    # One row per bar: the first bar keeps id 1 (written before venues existed), others get a fixed id
    # from their slug. The site reads the newest row for its venue (site/src/worker.js QUEUE_SQL).
    venue = venue_of(cfg)
    row_id = 1 if venue == DEFAULT_VENUE else 1000 + zlib.crc32(venue.encode()) % 1000000
    with_venue(lambda: d1_query(cfg, "insert or replace into live_queue (id, updated_at, items, venue) values (?, ?, ?, ?)",
                                [row_id, int(time.time()), items, venue]),
               lambda: d1_query(cfg, "insert or replace into live_queue (id, updated_at, items) values (?, ?, ?)",
                                [row_id, int(time.time()), items]))
    _queue_sent = items
    return True


# What the crowd meter needs to know from the sync: is karaoke happening right now?
karaoke_state = {"newest_play": 0, "queue_len": 0}


def run_once(a):
    """One sync (and upload, when configured). Returns (ok, message)."""
    try:
        rows, new, total, gap, queue = sync(a.source, a.target)
        try:
            db = sqlite3.connect(a.target)
            karaoke_state["newest_play"] = db.execute("select max(played_at) from plays").fetchone()[0] or 0
            db.close()
        except sqlite3.Error:
            pass
        karaoke_state["queue_len"] = len(queue or [])
        msg = f"ok: read {rows} plays from KaraFun, {new} new, {total} total"
        if gap:
            msg += (" WARNING: KaraFun's oldest saved song is newer than our newest, so some songs"
                    " were lost before this sync could copy them (KaraFun keeps only 200)")
        if os.path.exists(a.config):
            with open(a.config, encoding="utf-8") as f:
                cfg = json.load(f)
            # Send the queue even if the play upload fails, so one problem doesn't freeze "the line".
            upload_error = None
            try:
                msg += f", uploaded {upload(a.target, cfg)} to Cloudflare"
            except Exception as e:
                upload_error = e
            if queue is not None and upload_queue(cfg, queue):
                msg += f", queue now {len(queue)}"
            if upload_error is not None:
                raise upload_error
        return True, msg
    except BaseException as e:  # log every failure, including SystemExit
        if isinstance(e, KeyboardInterrupt):
            raise
        return False, f"error: {e}"


def write_log(log, msg):
    line = f"{dt.datetime.now().isoformat(timespec='seconds')} {msg}"
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def source_stamp(source):
    """Size and modified time of the KaraFun database and its WAL file; changes when a song is added."""
    out = []
    for path in (source, source + "-wal"):
        try:
            st = os.stat(path)
            out.append((st.st_size, st.st_mtime_ns))
        except OSError:
            out.append(None)
    return tuple(out)


def crowd_active():
    return (time.time() - karaoke_state["newest_play"] < CROWD_ACTIVE_S) or karaoke_state["queue_len"] > 0


def crowd_meter(a, log):
    """Background thread: read the mic's loudness once a second during karaoke and upload it to D1.

    Only one number per second (the average level in dBFS) leaves the laptop, never sound.
    The mic is only open while karaoke is on, so Windows' mic-in-use icon goes away afterwards.
    """
    try:
        with open(a.config, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return  # no Cloudflare config, nowhere to send it
    if cfg.get("crowd_mic") is False:
        write_log(log, "crowd meter: off (crowd_mic is false in the config)")
        return
    try:
        import sounddevice as sd
    except Exception:
        write_log(log, "crowd meter: off. To turn it on run:  python -m pip install sounddevice  then sign out and back in")
        return
    from array import array

    lock = threading.Lock()
    acc = {"sum": 0.0, "n": 0}

    def callback(indata, frames, t, status):
        x = array("h", bytes(indata))
        s = 0
        for v in x:
            s += v * v
        with lock:
            acc["sum"] += s
            acc["n"] += len(x)

    def pick_device():
        want = (cfg.get("crowd_mic_device") or "").lower()
        if not want:
            return None
        for i, d in enumerate(sd.query_devices()):
            if d.get("max_input_channels", 0) > 0 and want in d.get("name", "").lower():
                return i
        write_log(log, f"crowd meter: no mic matching \"{want}\", using the default mic")
        return None

    stream, out, last_up, fails, created = None, [], time.monotonic(), 0, False
    sec = int(time.time())
    while True:
        try:
            active = crowd_active()
            if active and stream is None:
                dev = pick_device()
                info = sd.query_devices(dev, "input")
                rate = int(info.get("default_samplerate") or 48000)
                stream = sd.RawInputStream(device=dev, samplerate=rate, channels=1, dtype="int16",
                                           blocksize=rate // 10, callback=callback)
                stream.start()
                with lock:
                    acc["sum"], acc["n"] = 0.0, 0
                sec = int(time.time())
                write_log(log, f"crowd meter: listening on {info.get('name')}")
            elif not active and stream is not None:
                stream.stop()
                stream.close()
                stream = None
                write_log(log, "crowd meter: karaoke's over, mic closed")
        except Exception as e:
            stream = None
            write_log(log, f"crowd meter: can't open the mic ({e}); trying again in a minute."
                           " Check Settings > Privacy > Microphone > Let desktop apps access your microphone")
            time.sleep(60)
            continue

        time.sleep(0.25)
        now = int(time.time())
        if stream is not None and now != sec:
            with lock:
                s, n = acc["sum"], acc["n"]
                acc["sum"], acc["n"] = 0.0, 0
            if n:
                ms = s / n / (32768.0 * 32768.0)
                db = max(-120.0, 10 * math.log10(ms)) if ms > 0 else -120.0
                out.append((sec, round(db, 1)))
                del out[:-CROWD_KEEP]
            sec = now

        if out and time.monotonic() - last_up >= CROWD_UPLOAD_S:
            last_up = time.monotonic()
            try:
                if not created:
                    d1_query(cfg, CROWD_TABLE, [])
                    created = True
                while out:
                    chunk = out[:30]
                    # Same src naming as site/src/crowd_api.js srcFor: "laptop" at the first bar, "<slug>:laptop" elsewhere.
                    venue = venue_of(cfg)
                    src = "laptop" if venue == DEFAULT_VENUE else venue + ":laptop"
                    sql = ("insert or ignore into crowd_levels (ts, src, db) values "
                           + ",".join(["(?,?,?)"] * len(chunk)))
                    d1_query(cfg, sql, [v for ts, db in chunk for v in (ts, src, db)])
                    del out[:len(chunk)]
                fails = 0
            except Exception as e:
                fails += 1
                if fails in (1, 10) or fails % 100 == 0:
                    write_log(log, f"crowd meter: upload failed ({e}), keeping {len(out)} seconds to retry")


# ---------- song requests: file downloaded karaoke tracks ----------
FILE_EVERY_S = 30
REQUESTS_EVERY_S = 120
FILE_RECENT_S = 3 * 86400       # only files downloaded in the last 3 days
VIDEO_AUDIO = {".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v", ".mp3", ".m4a", ".wav", ".ogg"}
PARTIAL = {".crdownload", ".part", ".tmp", ".download", ".opdownload"}


def norm_text(s):
    s = unicodedata.normalize("NFKD", str(s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "", s)


def norm_title(s):
    # "Wonderwall (Acoustic)" -> "wonderwall": brackets and "feat." bits rarely match file names.
    s = re.sub(r"\s*[(\[].*?[)\]]", " ", str(s or ""))
    s = re.sub(r"\s+(feat\.?|ft\.?|featuring)\s+.*$", "", s, flags=re.I)
    return norm_text(re.sub(r"^\s*the\s+", "", s, flags=re.I))


MEDIA = (".cdg", ".kfn", ".mp3", ".mp4")


def words(s):
    """'Don't Stop Believin' (Karaoke)' -> ['dont', 'stop', 'believin', 'karaoke']"""
    s = unicodedata.normalize("NFKD", str(s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c)).replace("'", "").replace("\u2019", "")
    return re.findall(r"[a-z0-9]+", s)


def karaoke_files(folder, now, dest_dir=None):
    """Finished, recent karaoke-looking files in the downloads folder: [(path, kind, partner)].

    An .mp3 that goes with a .cdg is filed together with it (kind "pair", partner = the .mp3), so the two
    always land under the same name. An .mp3 whose .cdg was already filed (it finished downloading first)
    is filed next to that .cdg.
    """
    try:
        names = os.listdir(folder)
    except OSError:
        return []
    by_lower = {n.lower(): n for n in names}
    out = []
    for n in names:
        path = os.path.join(folder, n)
        stem, ext = os.path.splitext(n)
        ext = ext.lower()
        if ext in PARTIAL or n.startswith(".") or not os.path.isfile(path):
            continue
        try:
            if now - os.path.getmtime(path) > FILE_RECENT_S:
                continue
        except OSError:
            continue
        has_k = "karaoke" in n.lower()
        if ext == ".cdg":
            mp3 = by_lower.get((stem + ".mp3").lower())
            out.append((path, "pair", os.path.join(folder, mp3) if mp3 else None))
        elif ext == ".kfn":
            out.append((path, "track", None))
        elif ext == ".mp3" and (stem + ".cdg").lower() in by_lower:
            continue  # filed with its .cdg
        elif ext == ".mp3" and dest_dir and os.path.exists(os.path.join(dest_dir, stem + ".cdg")):
            out.append((path, "track", None))  # its .cdg was filed already; same name lines them up
        elif ext == ".zip":
            try:
                with zipfile.ZipFile(path) as z:
                    entries = [m for m in z.namelist() if not m.endswith("/")]
                inner = [m for m in entries if os.path.splitext(m)[1].lower() in MEDIA]
                has_cdg = any(m.lower().endswith((".cdg", ".kfn")) for m in inner)
                # "karaoke" in the name alone isn't enough (this project's own code zip has it): the zip must
                # be mostly songs.
                if has_cdg or (has_k and inner and len(inner) * 2 >= len(entries)):
                    out.append((path, "zip", None))
            except (OSError, zipfile.BadZipFile):
                pass  # still downloading or not a zip
        elif ext in VIDEO_AUDIO and has_k:
            out.append((path, "track", None))
    return out


def free_name(folder, name, *also_ext):
    """A name in folder that's free, for this file and (for a .cdg) its partner extensions too."""
    stem, ext = os.path.splitext(name)
    cand, i = stem, 2
    while any(os.path.exists(os.path.join(folder, cand + e)) for e in (ext,) + also_ext):
        cand, i = f"{stem} ({i})", i + 1
    return os.path.join(folder, cand + ext)


def file_one(path, kind, dest_dir, partner=None):
    """Move (or unzip) one download into the karaoke folder. Returns the file names that landed there."""
    os.makedirs(dest_dir, exist_ok=True)
    if kind == "zip":
        landed = []
        with zipfile.ZipFile(path) as z:
            members = [m for m in z.infolist() if os.path.basename(m.filename) and os.path.splitext(m.filename)[1].lower() in MEDIA]
            # Keep .cdg/.mp3 pairs together: pick one free name per stem.
            stems = {}
            for m in members:
                st = os.path.splitext(os.path.basename(m.filename))[0]
                if st not in stems:
                    exts = [os.path.splitext(x.filename)[1].lower() for x in members if os.path.splitext(os.path.basename(x.filename))[0] == st]
                    stems[st] = os.path.splitext(os.path.basename(free_name(dest_dir, st + exts[0], *exts[1:])))[0]
            for m in members:
                base = os.path.basename(m.filename)
                st, ext = os.path.splitext(base)
                dest = os.path.join(dest_dir, stems[st] + ext)
                with z.open(m) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
                landed.append(os.path.basename(dest))
        done = os.path.join(dest_dir, "_zips")
        os.makedirs(done, exist_ok=True)
        shutil.move(path, free_name(done, os.path.basename(path)))
        return landed
    if kind == "pair":
        dest = free_name(dest_dir, os.path.basename(path), ".mp3")
        shutil.move(path, dest)
        landed = [os.path.basename(dest)]
        if partner and os.path.exists(partner):
            mp3 = os.path.splitext(dest)[0] + ".mp3"
            shutil.move(partner, mp3)
            landed.append(os.path.basename(mp3))
        return landed
    if os.path.splitext(path)[1].lower() == ".mp3" and os.path.exists(os.path.join(dest_dir, os.path.splitext(os.path.basename(path))[0] + ".cdg")) \
            and not os.path.exists(os.path.join(dest_dir, os.path.basename(path))):
        dest = os.path.join(dest_dir, os.path.basename(path))  # next to its .cdg, same name
    else:
        dest = free_name(dest_dir, os.path.basename(path))
    shutil.move(path, dest)
    return [os.path.basename(dest)]


# Words in a download's name that say nothing about which song it is.
NOISE = {"karaoke", "version", "instrumental", "lyrics", "lyric", "video", "official", "with", "backing", "vocals",
         "track", "cdg", "mp3", "mp4", "hd", "in", "the", "style", "of", "made", "famous", "by", "originally", "performed"}


def _contains(hay, needle):
    """needle's words appear in hay as a whole-word run."""
    n = len(needle)
    return n > 0 and any(hay[i:i + n] == needle for i in range(len(hay) - n + 1))


def match_requests(names, requests):
    """Open requests whose title (and artist, when given) appear as whole words in one of the file names.

    "Hello" no longer matches "Hello Goodbye", and "One" no longer matches "Someone Like You". A request
    without an artist only matches when one " - " part of the file name is just the title (apart from noise
    words like "karaoke version"), so it can't match a different song that happens to contain the title.
    """
    hits = []
    for r in requests:
        t = words(re.sub(r"\s*[(\[].*?[)\]]", " ", str(r.get("title") or "")))
        ar = [w for w in words(re.sub(r"\s+(feat\.?|ft\.?|featuring)\s+.*$", "", str(r.get("artist") or ""), flags=re.I)) if w != "the"]
        if len("".join(t)) < 3 or not [w for w in t if w not in NOISE]:
            continue  # "karaoke", "a", ...: too vague to match anything
        for n in names:
            k = words(os.path.splitext(n)[0])
            if not _contains(k, t):
                continue
            if ar:
                if _contains(k, ar):
                    hits.append(r)
                    break
            else:
                # "Adele - Hello (Karaoke Version)": one " - " part must be just the title.
                parts = re.split(r"\s+[-\u2013\u2014]\s+|_-_", os.path.splitext(n)[0])
                if any([w for w in words(p) if w not in NOISE or w in t] == t for p in parts):
                    hits.append(r)
                    break
    return hits


def request_filer(a, log):
    """Background thread: move downloaded karaoke tracks into the karaoke folder and mark requests added."""
    try:
        with open(a.config, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}
    if cfg.get("auto_file") is False:
        write_log(log, "auto-file: off (auto_file is false in the config)")
        return
    downloads = os.path.expanduser(cfg.get("downloads_dir") or os.path.join("~", "Downloads"))
    dest_dir = os.path.expanduser(cfg.get("karaoke_dir") or os.path.join("~", "Music", "Karaoke Songs"))
    write_log(log, f"auto-file: watching {downloads} -> {dest_dir}")
    sizes, requests, last_req = {}, [], 0.0
    while True:
        try:
            now = time.time()
            if cfg.get("api_token") and time.monotonic() - last_req >= REQUESTS_EVERY_S:
                try:
                    # Only this bar's requests ("venue" in the config is the bar's slug on okenight.com).
                    body = d1_query(cfg, "SELECT id, title, artist FROM song_requests WHERE status = 'open' AND venue = ?",
                                    [venue_of(cfg)])
                    requests = body["result"][0]["results"]
                except Exception:
                    pass  # offline, or nobody has requested anything yet (no table)
                last_req = time.monotonic()
            for path, kind, partner in karaoke_files(downloads, now, dest_dir):
                # Wait until the size stops changing (for a pair, both files), so a download in progress isn't moved.
                size = (os.path.getsize(path), os.path.getsize(partner) if partner else 0)
                if sizes.get(path) != size:
                    sizes[path] = size
                    continue
                sizes.pop(path, None)
                landed = file_one(path, kind, dest_dir, partner)
                msg = f"auto-file: {os.path.basename(path)} -> {dest_dir}"
                hits = match_requests(landed + [os.path.basename(path)], requests)
                for r in hits:
                    try:
                        d1_query(cfg, "UPDATE song_requests SET status = 'added', updated_at = ? WHERE id = ? AND status = 'open'",
                                 [int(now), r["id"]])
                        requests = [x for x in requests if x["id"] != r["id"]]
                        msg += f" (request “{r['title']}” marked added)"
                    except Exception as e:
                        msg += f" (couldn't mark “{r['title']}” added: {e})"
                write_log(log, msg)
        except Exception as e:  # never let a bad file stop the sync
            write_log(log, f"auto-file: {e}")
        time.sleep(FILE_EVERY_S)


def watch(a, log):
    """Sync whenever KaraFun's database changes. Runs until the computer logs off."""
    lock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        lock.bind(("127.0.0.1", WATCH_LOCK_PORT))
    except OSError:
        write_log(log, "watch: already running, exiting")
        return 0
    write_log(log, "watch: started")
    threading.Thread(target=crowd_meter, args=(a, log), daemon=True).start()
    threading.Thread(target=request_filer, args=(a, log), daemon=True).start()
    last_stamp, last_sync, failures = None, 0.0, 0
    while True:
        stamp = source_stamp(a.source)
        due = time.monotonic() - last_sync >= WATCH_HEARTBEAT_S
        if stamp != last_stamp or due or failures:
            # Let KaraFun finish writing before copying the file.
            time.sleep(2)
            ok, msg = run_once(a)
            last_sync = time.monotonic()
            if ok:
                last_stamp = stamp
                if failures or " 0 new" not in msg:
                    write_log(log, "watch " + msg)
                failures = 0
            else:
                failures += 1
                if failures in (1, 5) or failures % 60 == 0:
                    write_log(log, f"watch {msg} (try {failures})")
                time.sleep(min(60, 5 * failures))  # back off while offline
        time.sleep(WATCH_POLL_S)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=DEFAULT_SOURCE)
    ap.add_argument("--target", default=DEFAULT_TARGET)
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--watch", action="store_true", help="keep running and sync each new song within seconds")
    a = ap.parse_args()
    log = os.path.join(os.path.dirname(os.path.abspath(a.target)), "sync_log.txt")
    if a.watch:
        sys.exit(watch(a, log))
    ok, msg = run_once(a)
    write_log(log, msg)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
