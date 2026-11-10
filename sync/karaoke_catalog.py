"""Load KaraFun's published song catalog into Cloudflare D1, for the Songbook on the site.

KaraFun publishes its whole catalog as a CSV on https://www.karafun.com/karaoke-song-list.html
(about 90,000 songs: id, title, artist, year, duet, explicit, date added, styles, languages,
listed most popular first). This script downloads it and sends only what changed since the
last run to the D1 full-text table `catalog`, so a weekly refresh costs a few hundred writes.
What was sent is tracked in the local karaoke_stats.db (table catalog_sent), so a run that
stops halfway (offline, or D1's daily write limit) carries on next time.

karaoke_sync.py runs this at most once a week from the daily task. To run it by hand:

    python karaoke_catalog.py [--force] [--target PATH] [--config PATH]
"""
import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import math
import os
import re
import sqlite3
import sys
import urllib.request

LIST_PAGE = "https://www.karafun.com/karaoke-song-list.html"
# The CSV link on that page, as of 2026-11. The page is checked first in case it changes.
FALLBACK_CSV = "https://www.karafun.com/cl/3107312/0c8ccb4b46a410fe3c690a810796d814/"
REFRESH_DAYS = 7
MAX_SQL_BYTES = 90_000  # D1 allows 100 KB per SQL statement
UA = "OkeNight-catalog-sync/1.0 (weekly download of the public KaraFun song list)"

D1_SCHEMA = [
    # rowid = KaraFun song id (same as plays.song_id). Only title, artist and k are searchable.
    # k is title + artist without apostrophes, dots and slashes, so "dont stop" finds "Don't Stop
    # Believin'" and "acdc" finds AC/DC (site/src/catalog_api.js strips the same from searches).
    "CREATE VIRTUAL TABLE IF NOT EXISTS catalog USING fts5(title, artist, k, year UNINDEXED, duo UNINDEXED,"
    " explicit UNINDEXED, styles UNINDEXED, languages UNINDEXED, added UNINDEXED, pop UNINDEXED,"
    " tokenize = 'unicode61 remove_diacritics 2')",
    "CREATE TABLE IF NOT EXISTS catalog_meta (k text primary key, v text)",
]
LOCAL_SCHEMA = """
create table if not exists catalog_sent (
  id    integer primary key,  -- KaraFun song id
  hash  text not null,        -- of the fields last sent to D1
  pop   integer               -- popularity rank last sent (1 = most popular)
);
create table if not exists catalog_runs (
  ran_at text primary key, songs integer, sent integer, deleted integer, ok integer
);
"""


def get(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def csv_url():
    try:
        page = get(LIST_PAGE, 30).decode("utf-8", "replace")
        m = re.search(r'href="(https://www\.karafun\.com/cl/[^"]+)"', page)
        if m:
            return m.group(1)
    except Exception:
        pass
    return FALLBACK_CSV


def to_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def parse(raw):
    """CSV bytes -> list of song dicts, most popular first."""
    text = raw.decode("utf-8-sig")
    rows = csv.DictReader(io.StringIO(text), delimiter=";")
    out, seen = [], set()
    for row in rows:
        sid = to_int(row.get("Id"))
        title = (row.get("Title") or "").strip()
        if not sid or not title or sid in seen:
            continue
        seen.add(sid)
        out.append({
            "id": sid, "title": title, "artist": (row.get("Artist") or "").strip(),
            "year": to_int(row.get("Year")), "duo": 1 if row.get("Duo") == "1" else 0,
            "explicit": 1 if row.get("Explicit") == "1" else 0,
            "styles": (row.get("Styles") or "").strip(), "languages": (row.get("Languages") or "").strip(),
            "added": (row.get("Date Added") or "").strip(), "pop": len(out) + 1,
        })
    return out


def pop_bucket(pop):
    # Ranks shift a little every week. Only re-send a song when its rank moves by about 10%,
    # so the order stays right without rewriting the whole catalog.
    return round(math.log2(pop) * 8)


def song_hash(s):
    key = [s["title"], s["artist"], s["year"], s["duo"], s["explicit"], s["styles"], s["languages"], s["added"], pop_bucket(s["pop"])]
    return hashlib.sha1(json.dumps(key, ensure_ascii=False).encode()).hexdigest()


def lit(v):
    """SQL literal. Values come from KaraFun's CSV; strings are quoted with '' escaping."""
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("\x00", "").replace("'", "''") + "'"


def search_key(s):
    return re.sub(r"['\u2018\u2019`./]", "", s["title"] + " " + s["artist"]).lower()


COLS = ["rowid", "title", "artist", "k", "year", "duo", "explicit", "styles", "languages", "added", "pop"]


def insert_batches(songs):
    head = "INSERT OR REPLACE INTO catalog (" + ",".join(COLS) + ") VALUES "
    batch, size = [], len(head.encode())
    for s in songs:
        tup = "(" + ",".join(lit(s["id"] if c == "rowid" else search_key(s) if c == "k" else s[c]) for c in COLS) + ")"
        n = len(tup.encode()) + 1
        if batch and size + n > MAX_SQL_BYTES:
            yield batch, head + ",".join(t for _, t in batch)
            batch, size = [], len(head.encode())
        batch.append((s, tup))
        size += n
    if batch:
        yield batch, head + ",".join(t for _, t in batch)


def refresh(target, cfg, d1_query, force=False, log=print):
    """Download the catalog and send changes to D1. Returns a short message, or None when not due."""
    db = sqlite3.connect(target)
    db.executescript(LOCAL_SCHEMA)
    last = db.execute("select max(ran_at) from catalog_runs where ok = 1").fetchone()[0]
    if not force and last and dt.datetime.fromisoformat(last) > dt.datetime.now() - dt.timedelta(days=REFRESH_DAYS):
        db.close()
        return None

    now = dt.datetime.now().isoformat(timespec="seconds")
    sent = deleted = 0
    songs = []
    try:
        songs = parse(get(csv_url()))
        if len(songs) < 10_000:  # a broken download must never wipe the catalog
            raise RuntimeError(f"catalog download looks wrong ({len(songs)} songs)")
        for sql in D1_SCHEMA:
            d1_query(cfg, sql, [])
        have = dict(db.execute("select id, hash from catalog_sent"))
        todo = [s for s in songs if have.get(s["id"]) != song_hash(s)]
        for batch, sql in insert_batches(todo):
            d1_query(cfg, sql, [])
            with db:
                db.executemany("insert or replace into catalog_sent values (?,?,?)",
                               [(s["id"], song_hash(s), s["pop"]) for s, _ in batch])
            sent += len(batch)
        gone = sorted(set(have) - {s["id"] for s in songs})
        for i in range(0, len(gone), 500):
            chunk = gone[i:i + 500]
            d1_query(cfg, "DELETE FROM catalog WHERE rowid IN (" + ",".join(map(str, chunk)) + ")", [])
            with db:
                db.executemany("delete from catalog_sent where id = ?", [(x,) for x in chunk])
            deleted += len(chunk)
        d1_query(cfg, "INSERT OR REPLACE INTO catalog_meta (k, v) VALUES ('count', ?), ('updated', ?)",
                 [str(len(songs)), now])
        ok = True
        msg = f"catalog ok: {len(songs)} songs, {sent} sent, {deleted} removed"
    except Exception as e:
        ok = False
        msg = f"catalog error after sending {sent} songs (carries on next run): {e}"
    with db:
        db.execute("insert or replace into catalog_runs values (?,?,?,?,?)", (now, len(songs), sent, deleted, int(ok)))
    db.close()
    return msg


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, here)
    import karaoke_sync as ks
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default=ks.DEFAULT_TARGET)
    ap.add_argument("--config", default=ks.DEFAULT_CONFIG)
    ap.add_argument("--force", action="store_true", help="refresh even if the last one was under a week ago")
    a = ap.parse_args()
    with open(a.config, encoding="utf-8") as f:
        cfg = json.load(f)
    msg = refresh(a.target, cfg, ks.d1_query, force=a.force) or "catalog: refreshed under a week ago, nothing to do (use --force)"
    log = os.path.join(os.path.dirname(os.path.abspath(a.target)), "sync_log.txt")
    ks.write_log(log, msg)
    sys.exit(0 if "error" not in msg else 1)


if __name__ == "__main__":
    main()
