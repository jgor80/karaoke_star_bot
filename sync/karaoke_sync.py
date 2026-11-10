"""Copy KaraFun play history into a permanent karaoke stats database.

KaraFun keeps only recent history in %APPDATA%\\KaraFun\\user_database.db,
so this script runs daily and adds any new plays and sessions to
karaoke_stats.db. Rows are keyed by KaraFun's own ids, so running it
again never creates duplicates.

If karaoke_sync_config.json sits next to this script, new plays are also
uploaded to the Cloudflare D1 database it names.

Once a week the daily run also refreshes KaraFun's song catalog for the site's
Songbook (see karaoke_catalog.py; needs that file next to this one).

With --watch it keeps running and syncs within seconds whenever KaraFun
writes a new song, so the public stats site stays live during a session.

Usage: python karaoke_sync.py [--watch] [--source PATH] [--target PATH] [--config PATH]
"""
import argparse
import json
import datetime as dt
import os
import shutil
import socket
import sqlite3
import sys
import tempfile
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
    return len(plays), total - before, total, gap


D1_PLAY_COLS = ["uuid", "played_at", "played_at_local", "night", "session_start", "singer",
                "type_id", "song_id", "artist", "title", "release_year", "length_s", "pitch",
                "tempo", "lead_vocal_a", "lead_vocal_b", "backing", "first_seen"]
D1_MAX_PARAMS = 90  # D1 allows 100 bound parameters per statement


def local_times(ts):
    t = dt.datetime.fromtimestamp(ts)
    night = (t - dt.timedelta(hours=NIGHT_CUTOFF_HOURS)).date().isoformat()
    return t.isoformat(sep=" ", timespec="seconds"), night


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
    upsert_rows(cfg, "plays", D1_PLAY_COLS, "uuid", D1_PLAY_COLS[2:], rows)
    now = dt.datetime.now().isoformat(timespec="seconds")
    with db:
        db.executemany("insert or replace into d1_uploaded values (?,?)", [(r[0], now) for r in rows])
    d1_query(cfg, "insert or replace into sync_runs values (?,?,?,?)",
             [now, os.environ.get("COMPUTERNAME", ""), len(plays), len(rows)])
    db.close()
    return len(rows)


def run_once(a):
    """One sync (and upload, when configured). Returns (ok, message)."""
    try:
        rows, new, total, gap = sync(a.source, a.target)
        msg = f"ok: read {rows} plays from KaraFun, {new} new, {total} total"
        if gap:
            msg += (" WARNING: KaraFun's oldest saved song is newer than our newest, so some songs"
                    " were lost before this sync could copy them (KaraFun keeps only 200)")
        if os.path.exists(a.config):
            with open(a.config, encoding="utf-8") as f:
                cfg = json.load(f)
            msg += f", uploaded {upload(a.target, cfg)} to Cloudflare"
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


def watch(a, log):
    """Sync whenever KaraFun's database changes. Runs until the computer logs off."""
    lock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        lock.bind(("127.0.0.1", WATCH_LOCK_PORT))
    except OSError:
        write_log(log, "watch: already running, exiting")
        return 0
    write_log(log, "watch: started")
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


def refresh_catalog(a):
    """Weekly: send changes in KaraFun's song catalog to D1 for the site's Songbook (karaoke_catalog.py)."""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import karaoke_catalog
        with open(a.config, encoding="utf-8") as f:
            cfg = json.load(f)
        return karaoke_catalog.refresh(a.target, cfg, d1_query)
    except Exception as e:  # the catalog never stops the play sync
        return f"catalog error: {e}"


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
    if ok and os.path.exists(a.config):
        catalog_msg = refresh_catalog(a)
        if catalog_msg:
            write_log(log, catalog_msg)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
