"""Map tile server for the .mbtiles files in a folder (runs as the "mbtiles" service).

Same URLs and answers as mbtileserver, which it replaces in docker-compose.yml:

  /services                                list of tile sets (JSON)
  /services/<id>                           TileJSON
  /services/<id>/tiles/<z>/<x>/<y>.<ext>   one tile, XYZ numbering
  /services/<id>/map                       preview map
  /status                                  what is loaded, what is busy, what went wrong

<id> is the file's path in the folder without ".mbtiles" (data/mbtiles/custom.mbtiles -> custom).

What it does differently, so that it can't end up answering nothing:

  * No file watcher and nothing to lock. Before answering, a request looks at the file
    (at most once a second): if it was replaced (add-mbtiles, a restore, a copy) the new
    file is opened next to the old one, and only once it opens cleanly do requests move
    to it. A file that is still being copied, cut short or damaged is reported in the
    log and /status while the previous one keeps being served.
  * Every request waits at most --queue-wait seconds for one of the --slots database
    readers, and a read may take at most --read-limit seconds; otherwise the answer is
    503 with Retry-After. A slow disk or a file without an index makes some tiles fail
    fast instead of queueing requests nobody waits for any more until nothing answers.
  * Slow reads, turned-away requests, reads stuck on the disk and files it can't open
    are written to the log with the reason (--verbose also logs every request).

    python3 -m gcs_tools tileserver --dir data/mbtiles --port 8000 --missing-image-tile-404
"""

import argparse
import collections
import html
import http.server
import json
import os
import re
import signal
import sqlite3
import struct
import sys
import threading
import time
import urllib.parse
import zlib

VERSION = 1
CHECK_EVERY = 1.0          # s between looks at a tile set's file
SCAN_EVERY = 2.0           # s between looks for new / removed files in the folder
STUCK_AFTER = 30.0         # s a read may run before the watchdog reports it
RETRY_FAILED = 5.0         # s before an unchanged file that could not be opened is tried again
LEAFLET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "vendor", "leaflet")

MIME = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp", "pbf": "application/x-protobuf"}
SQLITE_MAGIC = b"SQLite format 3\x00"
# keys mbtileserver leaves out of TileJSON (set by the server, or TileMill leftovers)
TILEJSON_SKIP = {"tilejson", "id", "scheme", "format", "tiles", "map", "grids", "interactivity", "modtime",
                 "metatile", "scale", "autoscale", "_updated", "layer", "stylesheet"}


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S ") + msg, flush=True)


def fmt_bytes(n):
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0


# --------------------------------------------------------------------------
# tile bytes
# --------------------------------------------------------------------------

def tile_format(b):
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if b[:3] == b"\xff\xd8\xff":
        return "jpg"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "webp"
    if b[:2] == b"\x1f\x8b":
        return "pbf"  # gzip: vector tiles
    return None


def tile_width(fmt, b):
    """Pixel width read from the image header (as mbtileserver does), 0 if unknown."""
    try:
        if fmt == "pbf":
            return 512
        if fmt == "png" and len(b) >= 20:
            return struct.unpack(">I", b[16:20])[0]
        if fmt == "webp":
            if b[12:16] == b"VP8 " and len(b) >= 28:
                return (b[27] & 0x3F) << 8 | b[26]
            if b[12:16] == b"VP8L" and len(b) >= 23:
                return (struct.unpack("<H", b[21:23])[0] & 0x3FFF) + 1
            if b[12:16] == b"VP8X" and len(b) >= 27:
                return int.from_bytes(b[24:27], "little") + 1
        if fmt == "jpg":
            i = 2
            while i + 9 < len(b):
                if b[i] != 0xFF:
                    i += 1
                    continue
                m = b[i + 1]
                if m == 0xFF or m == 0x01 or 0xD0 <= m <= 0xD8:
                    i += 1 if m == 0xFF else 2
                    continue
                if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    return int.from_bytes(b[i + 7:i + 9], "big")
                i += 2 + int.from_bytes(b[i + 2:i + 4], "big")
    except (IndexError, struct.error):
        pass
    return 0


_BLANK = {}


def blank_png(size):
    """A transparent PNG (what mbtileserver answers for a missing image tile without --missing-image-tile-404)."""
    size = size if 1 <= size <= 4096 else 256
    if size not in _BLANK:
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        raw = (b"\x00" + b"\x00" * (4 * size)) * size
        _BLANK[size] = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
                        + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    return _BLANK[size]


# --------------------------------------------------------------------------
# tile sets
# --------------------------------------------------------------------------

class NotReady(Exception):
    """The file can't be served (yet); the message says why, in words."""


def file_key(path):
    st = os.stat(path)
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)


def header_problem(path, size):
    """Why the SQLite file can't be read as it is, judged from its header, or None."""
    if size == 0:
        return "the file is empty (0 bytes): still being copied, or the copy failed"
    with open(path, "rb") as f:
        head = f.read(100)
    if head[:16] != SQLITE_MAGIC:
        if len(head) < 100 and SQLITE_MAGIC.startswith(head[:16]):
            return "the file is only a few bytes long: still being copied?"
        return "not an SQLite file (no 'SQLite format 3' header)"
    if len(head) < 100:
        return "the file is shorter than an SQLite header: still being copied?"
    page = struct.unpack(">H", head[16:18])[0]
    page = 65536 if page == 1 else page
    pages = struct.unpack(">I", head[28:32])[0]
    # the page count in the header is valid when "version-valid-for" matches the change counter
    if head[92:96] == head[24:28] and pages and size < page * pages:
        return (f"the file is shorter than its header says ({fmt_bytes(size)} of {fmt_bytes(page * pages)}): "
                "it is still being copied, or the copy was cut short")
    return None


def open_db(path, timeout=2.0):
    """Read-only connection; the path is %-escaped ('#' or '?' in a name would open another file)."""
    uri = "file:" + urllib.parse.quote(os.path.abspath(path)) + "?mode=ro"
    db = sqlite3.connect(uri, uri=True, timeout=timeout, check_same_thread=False)
    db.execute("PRAGMA query_only = 1")
    return db


class Limit:
    """Abort an SQLite statement that runs past a deadline (checked every few thousand VM steps).
    It can't stop a read that is stuck inside the operating system; the watchdog reports those."""

    def __init__(self, db):
        self.deadline = None
        db.set_progress_handler(self._check, 2000)

    def _check(self):
        return 1 if self.deadline is not None and time.monotonic() > self.deadline else 0


class Generation:
    """One version of a tile set file, with its own readers.

    All readers are opened when the version is opened and checked, so they all read that
    same file even after it is replaced or deleted: a request is never answered from a
    file that was not checked first. They are closed once a newer version is served and
    the requests still using them are done."""

    _counter = 0
    _counter_lock = threading.Lock()

    def __init__(self, path, key, readers, read_limit):
        with Generation._counter_lock:
            Generation._counter += 1
            self.n = Generation._counter
        self.path, self.key = path, key
        self.size, self.mtime = key[2], key[3] / 1e9
        self.lock = threading.Lock()
        self.free, self.retired = [], False
        problem = header_problem(path, key[2])
        if problem:
            raise NotReady(problem)
        if os.path.exists(path + "-journal"):
            raise NotReady("a -journal file is next to it: a program is writing it, or stopped half way. "
                           "If nothing writes it any more, open the file once with the sqlite3 command, which "
                           "rolls the half-made change back (don't delete the -journal: that can damage it)")
        if os.path.exists(path + "-wal") and os.path.getsize(path + "-wal") > 0:
            raise NotReady("a -wal file is next to it: changes are still in the write-ahead log. "
                           "Checkpoint it (sqlite3 file 'PRAGMA wal_checkpoint(TRUNCATE)') before serving it")
        opened = []
        try:
            try:
                for _ in range(max(1, readers)):
                    db = open_db(path)
                    opened.append((db, Limit(db)))
            except sqlite3.Error as e:
                with open(path, "rb") as f:
                    wal = f.read(20)[18:20] == b"\x02\x02"
                raise NotReady(f"can't be opened: {e}" + (
                    " (it is in WAL mode, which needs a writable folder: switch it back with "
                    "sqlite3 file 'PRAGMA journal_mode=DELETE')" if wal else ""))
            self._check(opened[0], read_limit)
            if file_key(path) != key:
                raise NotReady("the file changed while it was being opened: still being written")
        except BaseException:
            for db, _ in opened:
                db.close()
            raise
        self.free = opened

    def _check(self, reader, read_limit):
        db, lim = reader
        lim.deadline = time.monotonic() + max(read_limit * 3, 30)
        try:
            objs = dict(db.execute("SELECT name, type FROM sqlite_master WHERE name IN ('tiles', 'metadata')"))
            if "tiles" not in objs:
                raise NotReady("no 'tiles' table: not an MBTiles file")
            meta = {}
            if "metadata" in objs:
                for k, v in db.execute("SELECT name, value FROM metadata"):
                    if k is not None and v is not None and str(v) != "":
                        meta[str(k)] = str(v)
            row = db.execute("SELECT tile_data FROM tiles LIMIT 1").fetchone()
            if row is None or row[0] is None:
                raise NotReady("the 'tiles' table is empty")
            first = bytes(row[0])
            self.format = tile_format(first)
            if self.format is None:
                raise NotReady("the first tile is not PNG, JPEG, WebP or gzip-compressed vector data")
            self.tilesize = tile_width(self.format, first)
            plan = " | ".join(r[-1] for r in db.execute(
                "EXPLAIN QUERY PLAN SELECT tile_data FROM tiles WHERE zoom_level=1 AND tile_column=1 AND tile_row=1"))
            self.indexed = not re.search(r"\bSCAN\b", plan)
            self.minzoom = self.maxzoom = None
            try:
                self.minzoom, self.maxzoom = int(meta["minzoom"]), int(meta["maxzoom"])
            except (KeyError, ValueError):
                if self.indexed:
                    self.minzoom, self.maxzoom = db.execute("SELECT MIN(zoom_level), MAX(zoom_level) FROM tiles").fetchone()
            self.meta = meta
        except sqlite3.OperationalError as e:
            if "interrupted" in str(e):
                raise NotReady("opening it took too long (the disk is very slow, or the file has no index)")
            raise
        finally:
            lim.deadline = None

    def take(self):
        """A free reader, or None once this version has been replaced."""
        with self.lock:
            if self.retired or not self.free:
                return None
            return self.free.pop()

    def give(self, reader):
        with self.lock:
            if not self.retired:
                self.free.append(reader)
                return
        reader[0].close()

    def retire(self):
        with self.lock:
            self.retired = True
            free, self.free = self.free, []
        for db, _ in free:
            db.close()

    def tilejson_base(self):
        """TileJSON fields from the metadata, typed the way mbtileserver types them."""
        out = {}
        for k, v in self.meta.items():
            lk = k.lower()
            if lk in TILEJSON_SKIP:
                continue
            if lk in ("minzoom", "maxzoom"):
                try:
                    out[lk] = int(v)
                except ValueError:
                    continue
            elif lk in ("bounds", "center"):
                try:
                    out[lk] = [int(f) if f == int(f) else f for f in (float(p) for p in v.split(","))]
                except ValueError:
                    continue
            elif lk == "json":
                try:
                    extra = json.loads(v)
                    if isinstance(extra, dict):
                        out.update(extra)
                except ValueError:
                    pass
            else:
                out[k] = v
        if "minzoom" not in out and self.minzoom is not None:
            out["minzoom"], out["maxzoom"] = self.minzoom, self.maxzoom
        return out


class Tileset:
    def __init__(self, server, tid, path):
        self.server, self.id, self.path = server, tid, path
        self.gen = None             # what requests are answered from
        self.problem = None         # why the file on disk isn't (or is no longer) what is served
        self.problem_since = None
        self.checked = 0.0
        self.failed = None          # (file key, when) of the last file that could not be opened
        self.loaded_at = None
        self.lock = threading.Lock()

    @property
    def name(self):
        g = self.gen
        return (g.meta.get("name") if g else None) or os.path.splitext(os.path.basename(self.path))[0]

    def current(self, force=False):
        """The generation to answer from, after looking at the file if it is time to."""
        if force or time.monotonic() - self.checked >= CHECK_EVERY:
            if self.lock.acquire(blocking=force):  # another request is looking: use what we have
                try:
                    if force or time.monotonic() - self.checked >= CHECK_EVERY:
                        self._look()
                finally:
                    self.checked = time.monotonic()
                    self.lock.release()
        return self.gen

    def _look(self):
        try:
            key = file_key(self.path)
        except FileNotFoundError:
            return  # the folder scan drops it
        if self.gen is not None and key == self.gen.key:
            self.problem = self.problem_since = None  # the file on disk is the one served (e.g. put back)
            return
        if self.failed and self.failed[0] == key and time.monotonic() - self.failed[1] < RETRY_FAILED:
            return  # same file as last time it failed: look again a bit later
        name = os.path.relpath(self.path, self.server.root)
        try:
            gen = Generation(self.path, key, self.server.slots, self.server.read_limit)
        except (NotReady, sqlite3.Error, OSError) as e:
            self.failed = (key, time.monotonic())
            why = str(e) if isinstance(e, NotReady) else f"can't be read: {e}"
            if why != self.problem:
                self.problem, self.problem_since = why, time.time()
                keep = "; still serving the previous version" if self.gen and "-journal" not in why else ""
                log(f"{name}: {why}{keep}")
                self.server.event("problem", f"{name}: {why}{keep}")
            return
        old = self.gen
        self.gen, self.loaded_at = gen, time.time()
        if old is not None:
            old.retire()  # readers in use are closed when their requests are done
        if self.problem:
            self.problem = self.problem_since = None
        zooms = f"zoom {gen.minzoom}-{gen.maxzoom}" if gen.minzoom is not None else "zoom range unknown"
        what = (f"{gen.format}{f' {gen.tilesize} px' if 0 < gen.tilesize <= 4096 else ''}, {zooms}, "
                f"{fmt_bytes(gen.size)}")
        log(f"{'reloaded' if old else 'loaded'} {name} as /services/{self.id} ({what})"
            + (": the file was replaced" if old else ""))
        self.server.event("reloaded" if old else "loaded", f"{name} ({what})")
        if not gen.indexed:
            msg = (f"{name} has no index on (zoom_level, tile_column, tile_row): every tile it doesn't have "
                   "means reading the whole file, which makes everything slow once a map asks for tiles outside "
                   "its area. Index it (tools page > Health, or: gcs-tools index-mbtiles data/mbtiles/"
                   f"{name}).")
            log(msg)
            self.server.event("no-index", msg)

    def info(self):
        g = self.gen
        out = {"id": self.id, "file": os.path.relpath(self.path, self.server.root), "served": g is not None,
               "problem": self.problem, "problem_since": self.problem_since}
        try:
            st = os.stat(self.path)
            out.update(size=st.st_size, mtime=st.st_mtime)
        except OSError:
            pass
        if g:
            out.update(name=self.name, format=g.format, tilesize=g.tilesize, indexed=g.indexed, minzoom=g.minzoom,
                       maxzoom=g.maxzoom, loaded_at=self.loaded_at, served_size=g.size, served_mtime=g.mtime,
                       bounds=g.tilejson_base().get("bounds"))
        return out


class TileServer:
    def __init__(self, root, slots=16, queue_wait=10.0, read_limit=8.0, missing_404=False, verbose=False):
        self.root = os.path.abspath(root)
        self.slots, self.queue_wait, self.read_limit = slots, queue_wait, read_limit
        self.missing_404, self.verbose = missing_404, verbose
        self.sem = threading.BoundedSemaphore(slots)
        self.tilesets = {}
        self.scanned = 0.0
        self.scan_lock = threading.Lock()
        self.stats_lock = threading.Lock()
        self.counts = collections.Counter()
        self.waiting = 0
        self.reads = {}             # thread id -> (start, what) of reads in progress
        self.events = collections.deque(maxlen=40)
        self.slow = collections.deque(maxlen=20)
        self.started = time.time()
        self._last_note = {}

    # ----- folder -----

    def scan(self, force=False):
        if not force and time.monotonic() - self.scanned < SCAN_EVERY:
            return
        if not self.scan_lock.acquire(blocking=force):
            return
        try:
            found = {}
            for dirpath, dirnames, filenames in os.walk(self.root):
                dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
                for fn in filenames:
                    if fn.lower().endswith(".mbtiles") and not fn.startswith("."):
                        p = os.path.join(dirpath, fn)
                        found[os.path.relpath(p, self.root)[:-len(".mbtiles")].replace(os.sep, "/")] = p
            tilesets = dict(self.tilesets)
            for tid in list(tilesets):
                if tid not in found:
                    log(f"{os.path.relpath(tilesets[tid].path, self.root)} is gone: /services/{tid} removed")
                    self.event("removed", tid)
                    del tilesets[tid]
            for tid, p in found.items():
                if tid not in tilesets:
                    tilesets[tid] = Tileset(self, tid, p)
            self.tilesets = tilesets
            for ts in list(tilesets.values()):
                if ts.gen is None:
                    ts.current(force=force)
        finally:
            self.scanned = time.monotonic()
            self.scan_lock.release()

    def find(self, rest):
        """(tile set, remaining path) for the part of a URL after /services/."""
        tilesets = self.tilesets  # the folder scan replaces the dict, never changes it
        for tid in sorted(tilesets, key=len, reverse=True):
            if rest == tid or rest.startswith(tid + "/"):
                return tilesets[tid], rest[len(tid):]
        return None, None

    # ----- bookkeeping -----

    def count(self, what, n=1):
        with self.stats_lock:
            self.counts[what] += n

    def event(self, kind, text):
        self.events.append({"t": time.time(), "kind": kind, "text": text})

    def note(self, key, every, msg):
        """Log msg at most once per `every` seconds for key."""
        now = time.monotonic()
        if now - self._last_note.get(key, -1e9) >= every:
            self._last_note[key] = now
            log(msg)
            self.event(key, msg)

    # ----- reading -----

    def read(self, ts, gen, sql, args, what):
        """Run one query with one of the readers. Raises Busy (none free in time) or Slow (read limit)."""
        with self.stats_lock:
            self.waiting += 1
        try:
            got = self.sem.acquire(timeout=self.queue_wait)
        finally:
            with self.stats_lock:
                self.waiting -= 1
        if not got:
            self.count("busy")
            self.note("busy", 10, f"busy: requests are being turned away (503) because all {self.slots} database "
                      f"readers were taken for over {self.queue_wait:g} s; {self.stuck_text()}")
            raise Busy()
        t0 = time.monotonic()
        tid = threading.get_ident()
        self.reads[tid] = (t0, what)
        try:
            reader = gen.take()
            if reader is None:  # the file was replaced since this request looked: use what is served now
                gen = ts.current()
                reader = gen.take() if gen is not None else None
                if reader is None:
                    raise Busy()
            db, lim = reader
            lim.deadline = t0 + self.read_limit
            try:
                cur = db.execute(sql, args)
                row = cur.fetchone()
                cur.close()
                return row
            except sqlite3.OperationalError as e:
                if "interrupted" in str(e):
                    self.count("slow")
                    raise Slow()
                raise
            finally:
                lim.deadline = None
                gen.give(reader)
        finally:
            del self.reads[tid]
            self.sem.release()
            dt = time.monotonic() - t0
            if dt >= 2:
                self.slow.append({"t": time.time(), "seconds": round(dt, 2), "what": what})
                self.note("slow", 10, f"slow read: {what} took {dt:.1f} s"
                          + ("" if ts.gen is None or ts.gen.indexed else " (the file has no index)"))

    def stuck_text(self):
        now = time.monotonic()
        ages = sorted((now - t0 for t0, _ in list(self.reads.values())), reverse=True)
        if not ages:
            return "no read is running (the requests came faster than they could be read)"
        return (f"{len(ages)} reads running, the oldest for {ages[0]:.0f} s"
                + (" - the disk (or the file share Docker uses) is not answering" if ages[0] >= STUCK_AFTER else ""))

    def watchdog(self):
        while True:
            time.sleep(5)
            now = time.monotonic()
            stuck = [(now - t0, what) for t0, what in list(self.reads.values()) if now - t0 >= STUCK_AFTER]
            if stuck:
                stuck.sort(reverse=True)
                self.note("stuck", 60, f"stuck: {len(stuck)} of {self.slots} database readers have waited over "
                          f"{STUCK_AFTER:.0f} s for the disk (oldest {stuck[0][0]:.0f} s: {stuck[0][1]}). "
                          "Reads can't be interrupted inside the operating system: check the disk, and "
                          "whether something else is copying large files on it right now.")

    def status(self):
        now = time.monotonic()
        ages = sorted((now - t0 for t0, _ in list(self.reads.values())), reverse=True)
        with self.stats_lock:
            counts, waiting = dict(self.counts), self.waiting
        return {
            "server": "gcs-tools tileserver", "version": VERSION, "pid": os.getpid(),
            "started": self.started, "uptime": round(time.time() - self.started, 1), "dir": self.root,
            "limits": {"slots": self.slots, "queue_wait": self.queue_wait, "read_limit": self.read_limit},
            "busy": {"reading": len(ages), "waiting": waiting, "oldest_read": round(ages[0], 1) if ages else 0,
                     "stuck": sum(1 for a in ages if a >= STUCK_AFTER)},
            "counts": counts,
            "tilesets": [ts.info() for ts in sorted(self.tilesets.values(), key=lambda t: t.id)],
            "slow": list(self.slow), "events": list(self.events),
        }


class Busy(Exception):
    pass


class Slow(Exception):
    pass


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

PREVIEW = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} preview</title>
<link rel="stylesheet" href="/_static/leaflet/leaflet.css">
<style>
html, body, #map {{ height: 100%; margin: 0; background: #1b1f24; }}
#info {{ position: absolute; z-index: 1000; left: 10px; bottom: 10px; padding: 6px 9px; border-radius: 6px;
  background: rgba(20,24,30,.85); color: #e8ecf0; font: 12px/1.4 system-ui, sans-serif; }}
#info b {{ font-weight: 600; }}
</style></head><body>
<div id="map"></div><div id="info"><b>{title}</b> &middot; {about} &middot; <span id="pos"></span></div>
<script src="/_static/leaflet/leaflet.js"></script>
<script>
const tj = {tilejson};
const map = L.map('map', {{ worldCopyJump: true, minZoom: 0, maxZoom: Math.max(22, (tj.maxzoom || 18) + 3) }});
L.tileLayer('tiles/{{z}}/{{x}}/{{y}}.' + (tj.format === 'jpg' ? 'jpg' : tj.format || 'png'), {{
  minZoom: 0, maxNativeZoom: tj.maxzoom || 18, maxZoom: Math.max(22, (tj.maxzoom || 18) + 3),
  tileSize: tj.tilesize === 512 ? 512 : 256, zoomOffset: tj.tilesize === 512 ? -1 : 0,
}}).addTo(map);
const b = tj.bounds;
if (b && b.length === 4 && b[2] > b[0] && b[3] > b[1]) map.fitBounds([[b[1], b[0]], [b[3], b[2]]]);
else map.setView([0, 0], 2);
const pos = document.getElementById('pos');
const show = (ll) => {{ pos.textContent = 'zoom ' + map.getZoom().toFixed(1) +
  (ll ? ' \\u00b7 ' + ll.lat.toFixed(5) + ', ' + ll.lng.toFixed(5) : ''); }};
map.on('zoomend', () => show()); map.on('mousemove', (e) => show(e.latlng)); show();
</script></body></html>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "gcs-tools-tileserver"
    disable_nagle_algorithm = True  # headers and body go out as two writes: don't hold the second one back
    timeout = 120  # idle keep-alive connections are closed after this

    def log_message(self, fmt, *args):
        pass

    def log_request(self, code="-", size="-"):
        if self.server.tiles.verbose:
            log(f'{self.address_string()} "{self.requestline}" {code} {size} '
                f"{time.monotonic() - getattr(self, '_t0', time.monotonic()):.3f}s")

    def handle_one_request(self):
        self._t0 = time.monotonic()
        super().handle_one_request()

    # ----- answers -----

    def _send(self, code, body=b"", ctype=None, headers=None, sort_keys=True):
        if isinstance(body, (dict, list)):
            # mbtileserver (Go) writes maps with sorted keys and structs in field order
            body = json.dumps(body, separators=(",", ":"), sort_keys=sort_keys).encode()
            ctype = ctype or "application/json"
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Vary", "Origin")
        if ctype:
            self.send_header("Content-Type", ctype)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _not_found(self):
        self._send(404, "404 page not found\n", "text/plain; charset=utf-8", {"X-Content-Type-Options": "nosniff"})

    def _base(self):
        h = self.headers
        scheme = (h.get("X-Forwarded-Proto") or h.get("X-Forwarded-Protocol") or h.get("X-Url-Scheme")
                  or ("https" if h.get("X-Forwarded-Ssl") == "on" else "http"))
        host = h.get("X-Forwarded-Host") or h.get("Host") or "%s:%s" % self.server.server_address[:2]
        return f"{scheme}://{host}"

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        if self.headers.get("Access-Control-Request-Headers"):
            self.send_header("Access-Control-Allow-Headers", self.headers["Access-Control-Request-Headers"])
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        srv = self.server.tiles
        url = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(url.path)
        if len(path) > 1:
            path = path.rstrip("/") or "/"
        try:
            if path == "/status":
                srv.scan()
                for ts in list(srv.tilesets.values()):
                    ts.current()
                return self._send(200, srv.status(), headers={"Cache-Control": "no-cache"})
            if path.startswith("/_static/leaflet/"):
                return self._static(path[len("/_static/leaflet/"):])
            srv.scan()
            if path in ("/", "/services"):
                items = []
                for ts in sorted(srv.tilesets.values(), key=lambda t: t.id):
                    g = ts.current()
                    if g:
                        items.append({"imageType": g.format, "url": f"{self._base()}/services/{ts.id}", "name": ts.name})
                if path == "/":
                    return self._index(items)
                return self._send(200, items, sort_keys=False)
            if not path.startswith("/services/"):
                return self._not_found()
            ts, rest = srv.find(path[len("/services/"):])
            gen = ts.current() if ts else None
            if gen is None:
                return self._not_found()
            if rest == "":
                return self._send(200, self._tilejson(ts, gen, url.query))
            if rest == "/map":
                return self._preview(ts, gen)
            if rest.startswith("/tiles/"):
                return self._tile(srv, ts, gen, rest[len("/tiles/"):])
            return self._not_found()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True  # the client went away
        except Exception as e:  # noqa: BLE001 - answer 500 and log rather than drop the connection
            log(f"error answering {self.path}: {e!r}")
            srv.count("error")
            srv.event("error", f"{self.path}: {e!r}")
            self._send(500, "Internal Server Error\n", "text/plain; charset=utf-8")

    def _tilejson(self, ts, gen, query):
        url = f"{self._base()}/services/{ts.id}"
        out = gen.tilejson_base()
        out.update({"tilejson": "2.1.0", "scheme": "xyz", "format": gen.format, "name": ts.name,
                    "tiles": [f"{url}/tiles/{{z}}/{{x}}/{{y}}.{gen.format}" + (f"?{query}" if query else "")],
                    "map": f"{url}/map"})
        if gen.tilesize > 0:
            out["tilesize"] = gen.tilesize
        return out

    def _tile(self, srv, ts, gen, rest):
        parts = rest.split("/")
        if len(parts) != 3:
            return self._send(400, "requested path is too short\n", "text/plain; charset=utf-8")
        try:
            z, x = int(parts[0]), int(parts[1])
            y = int(parts[2].split(".", 1)[0])
            if not (0 <= z <= 30 and 0 <= x < (1 << z) and 0 <= y < (1 << z)):
                raise ValueError
        except ValueError:
            return self._send(400, "invalid tile coordinates\n", "text/plain; charset=utf-8")
        what = f"{ts.id} {z}/{x}/{y}"
        try:
            row = srv.read(ts, gen, "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                           (z, x, (1 << z) - 1 - y), what)
        except Busy:
            return self._send(503, "busy: the tile server can't read fast enough right now\n",
                              "text/plain; charset=utf-8", {"Retry-After": "2"})
        except Slow:
            return self._send(503, f"reading this tile took over {srv.read_limit:g} s\n",
                              "text/plain; charset=utf-8", {"Retry-After": "5"})
        except sqlite3.DatabaseError as e:
            srv.count("error")
            hint = ""
            if "malformed" in str(e) or "not a database" in str(e):
                hint = " (the file looks damaged: run 'Check' on it in the tools page)"
            elif "readonly" in str(e) and os.path.exists(ts.path + "-journal"):
                hint = (" (a -journal file is next to it: a program stopped half way through changing it, and "
                        "SQLite must roll that back before anyone can read it, which this read-only server can't do)")
            srv.note("read-error", 10, f"can't read {what}: {e}{hint}")
            return self._send(500, "Internal Server Error\n", "text/plain; charset=utf-8")
        data = bytes(row[0]) if row and row[0] is not None else b""
        if len(data) <= 1:
            srv.count("missing")
            if gen.format == "pbf":
                return self._send(204)
            if srv.missing_404:
                return self._send(404)
            return self._send(200, blank_png(gen.tilesize), "image/png")
        srv.count("tiles")
        fmt = tile_format(data) or gen.format
        headers = {"Content-Encoding": "gzip"} if fmt == "pbf" else None
        return self._send(200, data, MIME.get(fmt, "application/octet-stream"), headers)

    def _preview(self, ts, gen):
        tj = self._tilejson(ts, gen, "")
        zooms = f"zoom {gen.minzoom}-{gen.maxzoom}" if gen.minzoom is not None else ""
        about = html.escape(", ".join(p for p in (gen.format.upper(), zooms, fmt_bytes(gen.size)) if p))
        page = PREVIEW.format(title=html.escape(ts.name), about=about,
                              tilejson=json.dumps(tj).replace("</", "<\\/"))
        self._send(200, page, "text/html; charset=utf-8")

    def _index(self, items):
        rows = "".join(f'<li><a href="/services/{html.escape(i["url"].rsplit("/services/", 1)[1])}/map">'
                       f'{html.escape(i["name"])}</a> ({html.escape(i["imageType"])})</li>' for i in items)
        self._send(200, f"<!doctype html><meta charset=utf-8><title>Map tiles</title><h3>Tile sets</h3>"
                        f"<ul>{rows or '<li>none</li>'}</ul><p><a href=/status>status</a></p>",
                   "text/html; charset=utf-8")

    def _static(self, rel):
        rel = os.path.normpath(rel)
        p = os.path.join(LEAFLET_DIR, rel)
        if rel.startswith("..") or os.path.isabs(rel) or not os.path.isfile(p):
            return self._not_found()
        ctype = {".js": "application/javascript", ".css": "text/css", ".png": "image/png"}.get(
            os.path.splitext(p)[1], "application/octet-stream")
        with open(p, "rb") as f:
            self._send(200, f.read(), ctype, {"Cache-Control": "public, max-age=86400"})


class HTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 256


# --------------------------------------------------------------------------
# command line
# --------------------------------------------------------------------------

def _env_bool(name):
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def build_parser(p=None):
    p = p or argparse.ArgumentParser(prog="tileserver", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dir", "-d", default=os.environ.get("TILE_DIR", "./tilesets"),
                   help="folder with the .mbtiles files (default $TILE_DIR or ./tilesets)")
    p.add_argument("--port", "-p", type=int, default=int(os.environ.get("PORT", "8000")))
    p.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    p.add_argument("--missing-image-tile-404", action="store_true", default=_env_bool("MISSING_IMAGE_TILE_404"),
                   help="answer 404 for a missing image tile (default: a blank PNG, like mbtileserver)")
    p.add_argument("--slots", type=int, default=16, help="database reads at the same time (default 16)")
    p.add_argument("--queue-wait", type=float, default=10.0,
                   help="seconds a request may wait for a free reader before it gets 503 (default 10)")
    p.add_argument("--read-limit", type=float, default=8.0,
                   help="seconds one tile read may take before it is stopped with 503 (default 8)")
    p.add_argument("--verbose", "-v", action="store_true", default=_env_bool("VERBOSE"), help="log every request")
    return p


def main(argv=None, args=None):
    if args is None:
        args = build_parser().parse_args(argv)
    if not os.path.isdir(args.dir):
        sys.exit(f"ERROR: {args.dir} is not a folder")
    tiles = TileServer(args.dir, slots=max(1, args.slots), queue_wait=args.queue_wait, read_limit=args.read_limit,
                       missing_404=args.missing_image_tile_404, verbose=args.verbose)
    log(f"gcs-tools tile server: looking for .mbtiles files in {tiles.root}")
    tiles.scan(force=True)
    served = [t for t in tiles.tilesets.values() if t.gen]
    log(f"serving {len(served)} tile set{'s' if len(served) != 1 else ''}"
        + ("" if served else " (none could be opened yet; files that appear or get fixed are picked up by themselves)"))
    threading.Thread(target=tiles.watchdog, name="watchdog", daemon=True).start()
    srv = HTTPServer((args.host, args.port), Handler)
    srv.tiles = tiles
    log(f"HTTP server started on {args.host}:{args.port} (up to {tiles.slots} reads at once, "
        f"{tiles.queue_wait:g} s queue, {tiles.read_limit:g} s per read"
        f"{', 404 for missing tiles' if tiles.missing_404 else ''})")

    def stop(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("stopping")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
