"""Make a clean copy of a damaged tile file, with every tile that can still be read.

    ./gcs-tools repair data/src/north.mbtiles          -> data/src/north-repaired.mbtiles

For an SQLite tile file that reports "database disk image is malformed" (a copy
that was cut short, a file copied while it was still being written, a bad disk).
The original is only read, never changed.

How: the tiles are read straight from the table, without the index (a damaged
index is the most common case, and then every tile is saved). If the table
itself has damaged pages, the rows around them are read in smaller and smaller
batches and only the rows that really can't be read are skipped. The copy is
always plain MBTiles (TMS rows, unique index), so RMaps/OsmAnd and OruxMaps files
come out as MBTiles too. Tiles that were lost leave holes: when zoomed in there
the map shows the zoomed-out tile enlarged.

Better than repairing: copy the file again from where it was made (compare the
size or a checksum first), or export it again.
"""

import argparse
import os
import shutil
import sqlite3
import sys
import time

from . import tilesource
from .common import Ticker, check_cancel, fmt_size, fmt_time
from .tilesource import LAYOUTS, SQLITE_MAGIC, SourceError, flip, open_ro

IMAGE = ("jpeg", "png", "webp", "gif")


def _layout(db, name):
    """(kind, columns, meta, is_view) using only the schema: no index, no tile reads."""
    try:
        objs = {n: t for n, t in db.execute("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view')")}
    except sqlite3.DatabaseError as e:
        raise SourceError(f"{name}: even its list of tables is damaged ({e})",
                          "Nothing can be saved from it with this tool: copy or export it again.")
    if "tiles" not in objs:
        raise SourceError(f"{name} has no 'tiles' table (its tables: {', '.join(sorted(objs)) or 'none'})")
    cols = {r[1] for r in db.execute("PRAGMA table_info('tiles')")}
    if {"zoom_level", "tile_column", "tile_row", "tile_data"} <= cols:
        kind = "mbtiles"
    elif {"x", "y", "z", "image"} <= cols:
        kind = "rmaps" if ("s" in cols or "info" in objs) else "orux"
    else:
        raise SourceError(f"{name}: its 'tiles' table has columns {', '.join(sorted(cols))}: not a known tile layout")
    meta = {}
    try:
        if kind == "mbtiles":
            meta = tilesource.read_meta(db)
        elif "info" in objs:
            cur = db.execute("SELECT * FROM info LIMIT 1")
            row = cur.fetchone()
            if row:
                meta = {d[0].lower(): ("" if v is None else str(v)) for d, v in zip(cur.description, row)}
    except sqlite3.DatabaseError:
        print("  the metadata can't be read (damaged); the copy gets new metadata")
    return kind, LAYOUTS[kind], meta, objs["tiles"] == "view"


class Salvage:
    """Reads rows of a table by rowid, around damaged pages."""

    def __init__(self, db, sql_cols, table, out):
        self.db, self.cols, self.table, self.out = db, sql_cols, table, out
        self.ok = self.bad = 0
        self.bad_ranges = []
        self.tick = Ticker()

    def _emit(self, rows):
        for r in rows:
            self.out(r[1:])
        self.ok += len(rows)

    def scan(self):
        """Fast path: one pass over the table without any index. Returns the last rowid read, or None if done."""
        last = 0
        try:
            cur = self.db.execute(f"SELECT rowid, {self.cols} FROM {self.table} NOT INDEXED ORDER BY rowid")
            while True:
                check_cancel()
                rows = cur.fetchmany(2000)
                if not rows:
                    return None
                self._emit(rows)
                last = rows[-1][0]
                self.progress(last)
        except sqlite3.DatabaseError as e:
            print(f"  damaged pages{f' after row {last}' if last else ''} ({e}): reading around them, "
                  "row range by row range", flush=True)
            return last

    def max_rowid(self):
        for sql in (f"SELECT MAX(rowid) FROM {self.table}", f"SELECT rowid FROM {self.table} ORDER BY rowid DESC LIMIT 1"):
            try:
                v = self.db.execute(sql).fetchone()[0]
                if v is not None:
                    return v
            except sqlite3.DatabaseError:
                continue
        return None

    def ranges(self, lo, hi, step=4096):
        """Read rowids lo..hi; on an error split the range until single rows."""
        stack = [(a, min(a + step - 1, hi)) for a in range(lo, hi + 1, step)][::-1]
        while stack:
            check_cancel()
            a, b = stack.pop()
            try:
                rows = self.db.execute(f"SELECT rowid, {self.cols} FROM {self.table} WHERE rowid BETWEEN ? AND ?",
                                       (a, b)).fetchall()
                self._emit(rows)
            except sqlite3.DatabaseError:
                if a == b:
                    self.bad += 1
                    if self.bad_ranges and self.bad_ranges[-1][1] == a - 1:
                        self.bad_ranges[-1][1] = a
                    else:
                        self.bad_ranges.append([a, a])
                else:
                    m = (a + b) // 2
                    stack.extend([(m + 1, b), (a, m)])
            self.progress(b)

    def probe(self, start, window=4096, give_up=64):
        """The end of the table can't be found (its last pages are damaged or missing): read on
        window by window, and stop after `give_up` windows in a row that hold nothing readable."""
        dead, a = 0, start
        while dead < give_up:
            check_cancel()
            b = a + window - 1
            ok_before = self.ok
            try:
                rows = self.db.execute(f"SELECT rowid, {self.cols} FROM {self.table} WHERE rowid BETWEEN ? AND ?",
                                       (a, b)).fetchall()
                self._emit(rows)
            except sqlite3.DatabaseError:
                # a few single rows tell whether anything in this window is still reachable
                hits = 0
                for r in range(a, b + 1, window // 8):
                    try:
                        hits += bool(self.db.execute(f"SELECT 1 FROM {self.table} WHERE rowid=?", (r,)).fetchone())
                    except sqlite3.DatabaseError:
                        pass
                if hits:
                    self.ranges(a, b)
            dead = 0 if self.ok > ok_before else dead + 1
            self.progress(b)
            a = b + 1
        return a - 1

    def progress(self, at):
        if self.tick.due():
            print(f"  {self.ok} tiles read" + (f", {self.bad} unreadable rows" if self.bad else "")
                  + f" (up to row {at})", flush=True)


def repair(src, out, overwrite=False):
    name = os.path.basename(src)
    with open(src, "rb") as f:
        if f.read(16) != SQLITE_MAGIC:
            raise SourceError(f"{name} is not an SQLite database at all, so there is nothing to repair",
                              "It is probably not a tile file, or the start of the file is missing: copy it again.")
    if os.path.exists(out) and not overwrite:
        raise SourceError(f"{os.path.basename(out)} already exists", "Delete or rename it first.")
    root = os.path.dirname(os.path.dirname(os.path.abspath(out)))  # data/src/x -> data
    work = os.path.join(root, ".work", "repair")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    tmp = os.path.join(work, os.path.basename(out))
    free = shutil.disk_usage(work).free
    if free < os.path.getsize(src) * 1.1:
        raise SourceError(f"not enough free disk space for the copy ({fmt_size(free)} free, "
                          f"about {fmt_size(os.path.getsize(src))} needed)")
    t0 = time.time()
    cut, note = tilesource.size_note(src)
    if note:
        print(note.replace(", so the copy or download did not finish.", ". Only the part that arrived can be saved."))
    try:
        db = open_ro(src, timeout=30)
        # read-only, so nothing is written: this only makes SQLite skip schema entries it can't use
        # (e.g. an index whose pages are in the missing part of a cut-short file)
        db.execute("PRAGMA writable_schema=ON")
        kind, L, meta, is_view = _layout(db, name)
        print(f"{name}: {LAYOUTS[kind]['label']}" + (" (deduplicated)" if is_view else "")
              + f", {fmt_size(os.path.getsize(src))}")

        o = sqlite3.connect(tmp)
        o.executescript("""
            PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
            CREATE TABLE metadata (name TEXT, value TEXT);
            CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
            CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
        """)
        batch, kinds, skipped = [], {}, [0]

        def keep(row):
            z, x, y, data = row
            if not isinstance(z, int) or not isinstance(x, int) or not isinstance(y, int) or not data \
                    or not 0 <= z <= 30 or not 0 <= x < (1 << 30) or not 0 <= y < (1 << 30):
                skipped[0] += 1  # garbage from a damaged page
                return
            k = tilesource.img_type(data)
            if k not in IMAGE:
                skipped[0] += 1
                return
            kinds[k] = kinds.get(k, 0) + 1
            batch.append((z, x, y, bytes(data)))
            if len(batch) >= 2000:
                flush()

        def flush():
            o.executemany("INSERT OR IGNORE INTO tiles VALUES (?,?,?,?)", batch)
            o.commit()
            batch.clear()

        cols = f"{L['z']}, {L['x']}, {L['y']}, {L['data']}"
        if is_view:
            # deduplicated MBTiles: walk the map table, fetch each image by its id
            images = {}
            sv = Salvage(db, "zoom_level, tile_column, tile_row, tile_id", "map",
                         lambda r: keep((r[0], r[1], r[2], _image(db, r[3], images))))
        else:
            sv = Salvage(db, cols, "tiles", keep)
        print("Reading every tile straight from the table (not through the index)")
        last = sv.scan()
        if last is not None:
            top = sv.max_rowid()
            if top is None:
                print("  the end of the table can't be found (damaged or missing): reading on until nothing more "
                      "can be read", flush=True)
                sv.probe(last + 1)
            else:
                sv.ranges(last + 1, top)
        flush()
        print(f"  {sv.ok} rows read, {sv.bad} unreadable" + (f", {skipped[0]} not image tiles (left out)" if skipped[0] else "")
              + f" in {fmt_time(time.time() - t0)}")
        if sv.bad_ranges:
            shown = ", ".join(f"{a}-{b}" if a != b else str(a) for a, b in sv.bad_ranges[:8])
            print(f"  unreadable rows: {shown}" + (" ..." if len(sv.bad_ranges) > 8 else ""))

        n = o.execute("SELECT COUNT(*) FROM tiles").fetchone()[0]
        if not n:
            raise SourceError(f"no tile of {name} could be read", "Copy or export it again.")

        # RMaps/OsmAnd/OruxMaps: zoom numbering and rows -> MBTiles (TMS)
        if kind in ("rmaps", "orux"):
            rows = o.execute("SELECT zoom_level, MAX(tile_column), MAX(tile_row) FROM tiles GROUP BY zoom_level").fetchall()
            shift, note = (tilesource.zoom_numbering(name, rows, meta) if kind == "rmaps" else (0, "zoom as stored"))
            inverted = (meta.get("inverted_y") or "0") not in ("0", "")
            print(f"  converting to MBTiles: {note}, rows {'TMS' if inverted else 'XYZ'} -> TMS")
            o.executescript("CREATE TABLE t2 (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);")
            for (sz,) in o.execute("SELECT DISTINCT zoom_level FROM tiles").fetchall():
                z = (17 - sz) if shift == 17 else sz
                if inverted:
                    o.execute("INSERT INTO t2 SELECT ?, tile_column, tile_row, tile_data FROM tiles WHERE zoom_level=?", (z, sz))
                else:
                    o.execute("INSERT INTO t2 SELECT ?, tile_column, ? - tile_row, tile_data FROM tiles WHERE zoom_level=?",
                              (z, (1 << z) - 1, sz))
            o.executescript("DROP TABLE tiles; ALTER TABLE t2 RENAME TO tiles; "
                            "CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);")
            meta = {}

        zooms = {z: (c, x0, x1, r0, r1) for z, c, x0, x1, r0, r1 in o.execute(
            "SELECT zoom_level, COUNT(*), MIN(tile_column), MAX(tile_column), MIN(tile_row), MAX(tile_row) "
            "FROM tiles GROUP BY zoom_level")}
        zmax = max(zooms)
        _, x0, x1, r0, r1 = zooms[zmax]
        box = tilesource.xyz_bounds(zmax, x0, x1, flip(zmax, r1), flip(zmax, r0))
        fmt = max(kinds, key=kinds.get).replace("jpeg", "jpg")
        new_meta = {k: v for k, v in meta.items() if k in ("name", "description", "attribution", "type", "version", "scheme")}
        new_meta.update({"name": new_meta.get("name") or os.path.splitext(os.path.basename(out))[0],
                         "format": fmt, "minzoom": str(min(zooms)), "maxzoom": str(zmax),
                         "bounds": meta.get("bounds") or ",".join(f"{v:.8f}" for v in box),
                         "description": (new_meta.get("description", "") + f" (repaired from {name})").strip()})
        o.executemany("INSERT INTO metadata VALUES (?,?)", list(new_meta.items()))
        o.commit()
        check = o.execute("PRAGMA quick_check").fetchone()[0]
        o.close()
        if check != "ok":
            raise SourceError(f"the repaired copy failed SQLite's check ({check})")
        os.replace(tmp, out)
        print("  tiles per zoom: " + ", ".join(f"z{z} {zooms[z][0]}" for z in sorted(zooms)))
        whole = sv.bad == 0 and cut != "short"
        if cut == "short":
            lost = "the tiles in the part of the file that never arrived are missing"
        else:
            lost = f"{sv.bad} rows could not be read"
        print(f"Saved {n} tiles to {os.path.basename(out)} ({fmt_size(os.path.getsize(out))})"
              + (": every tile could be read, so only the index or other bookkeeping was damaged." if whole else
                 f": {lost}. Where those tiles were, the map shows the zoomed-out tile enlarged."))
        print("RESULT: repaired: use " + os.path.basename(out) + " as the new imagery"
              + ("" if whole else " (or copy the original again to get the missing tiles too)"))
    finally:
        try:
            db.close()
        except Exception:  # noqa: BLE001
            pass
        shutil.rmtree(work, ignore_errors=True)
        try:
            os.rmdir(os.path.dirname(work))
        except OSError:
            pass


def _image(db, tile_id, _cache):
    try:
        row = db.execute("SELECT tile_data FROM images WHERE tile_id=?", (tile_id,)).fetchone()
        return row[0] if row else None
    except sqlite3.DatabaseError:
        return None


def default_out(src):
    base, ext = os.path.splitext(src)
    return f"{base}-repaired.mbtiles"


def build_parser(p=None):
    p = p or argparse.ArgumentParser(prog="repair", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("path", help="the damaged tile file (.mbtiles, .sqlitedb, ...)")
    p.add_argument("--out", help="where to write the copy (default: <name>-repaired.mbtiles next to it)")
    p.add_argument("--overwrite", action="store_true", help="replace the copy if it exists")
    return p


def main(argv=None, args=None):
    if args is None:
        args = build_parser().parse_args(argv)
    if not os.path.isfile(args.path):
        sys.exit(f"ERROR: {args.path} not found")
    out = os.path.abspath(args.out or default_out(args.path))
    if out == os.path.abspath(args.path):
        sys.exit("ERROR: the copy can't replace the original")
    try:
        repair(args.path, out, args.overwrite)
    except SourceError as e:
        print(f"RESULT: not repaired: {e.full()}", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
