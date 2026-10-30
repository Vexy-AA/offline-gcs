"""Read map tiles from a {z}/{x}/{y} folder or an SQLite tile file, the same way.

Used by add-mbtiles (the new area), inspect (what is wrong with a file) and the
tools page (what a file in data/src holds). Every tile comes out as
(zoom, x, tms_row, bytes): MBTiles rows count from the south (TMS), so that is
what the target file stores.

SQLite tile files, whatever their extension (.mbtiles, .sqlitedb, .db):

  mbtiles  tiles(zoom_level, tile_column, tile_row, tile_data), a table or the
           tiles view of a deduplicated file (map + images)
  rmaps    tiles(x, y, z, s, image) + info: RMaps / OsmAnd .sqlitedb, what
           SAS.Planet writes as "SQLite3". z is usually stored as 17 - zoom
           ("BigPlanet" numbering); rows count from the north
  orux     tiles(x, y, z, image): OruxMaps (OruxMapsImages.db)

Row order (`scheme`) is the order of the stored rows: xyz = from the north
(Google, OSM, SAS.Planet), tms = from the south. "auto": a folder is XYZ unless it
holds gdal2tiles' tilemapresource.xml; MBTiles is TMS unless its metadata says
scheme=xyz or its 'bounds' only match the tiles read the other way round;
RMaps/OsmAnd and OruxMaps are XYZ (OsmAnd's inverted_y=1 is TMS).
"""

import math
import os
import sqlite3
import urllib.parse

from . import mbtiles, regions

SQLITE_MAGIC = b"SQLite format 3\x00"
SQLITE_EXTS = (".mbtiles", ".sqlitedb", ".sqlite", ".sqlite3", ".db")

LAYOUTS = {
    "mbtiles": {"z": "zoom_level", "x": "tile_column", "y": "tile_row", "data": "tile_data", "label": "MBTiles"},
    "rmaps": {"z": "z", "x": "x", "y": "y", "data": "image",
              "label": 'RMaps/OsmAnd .sqlitedb (what SAS.Planet calls "SQLite3")'},
    "orux": {"z": "z", "x": "x", "y": "y", "data": "image", "label": "OruxMaps database"},
}


class SourceError(Exception):
    """Why a file can't be used, and what to do about it."""

    def __init__(self, msg, hint=None):
        super().__init__(msg)
        self.hint = hint

    def full(self):
        msg = str(self)
        if not self.hint:
            return msg
        return msg + ("" if msg.endswith((".", ":", "!", "?")) else ".") + " " + self.hint


def header_size(path):
    """(size the SQLite header says the file has, actual size), or None if the header doesn't say."""
    try:
        with open(path, "rb") as f:
            h = f.read(100)
        if len(h) < 100 or h[:16] != SQLITE_MAGIC:
            return None
        page = int.from_bytes(h[16:18], "big")
        page = 65536 if page == 1 else page
        pages = int.from_bytes(h[28:32], "big")
        # the page count is only valid when "version-valid-for" matches the change counter
        if not pages or h[92:96] != h[24:28]:
            return None
        return pages * page, os.path.getsize(path)
    except OSError:
        return None


def size_note(path):
    """Plain words on whether a damaged file is cut short, or full size."""
    hs = header_size(path) if path else None
    if not hs:
        return None, None
    want, have = hs
    if have < want:
        return "short", (f"It is cut short: {fmt_bytes(have)} of the {fmt_bytes(want)} its header says it has "
                         f"({100 * have / want:.0f}%), so the copy or download did not finish.")
    return "full", (f"It is full size ({fmt_bytes(have)}, as its header says), so it was not cut short: it was "
                    "probably copied while the program that made it was still writing, or the export itself "
                    "or the disk is bad.")


def fmt_bytes(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0


def damaged(name, e, path=None):
    kind, note = size_note(path)
    if kind == "short":
        fix = (f"{note} Copy it again from where it was made, and compare the size. Repair "
               "(./gcs-tools repair) can save the tiles in the part that arrived.")
    elif kind == "full":
        fix = (f"{note} Close the program that made it, copy it again and compare a checksum; if the original "
               "is damaged too, export it again, or Repair (./gcs-tools repair) saves every tile that can still "
               "be read.")
    else:
        fix = ("Usually the copy was cut short, or the file was copied while the program that made it was still "
               "writing. Compare its size (or checksum) with the original and copy it again. If the original is "
               "damaged too, Repair (./gcs-tools repair) makes a copy with every tile that can still be read.")
    return SourceError(f"{name} is damaged: SQLite says '{e}'", fix)


def open_ro(path, timeout=5):
    """Read-only SQLite connection. The path is %-escaped: an unescaped '#' or '?' in a file
    name makes SQLite open (and create) a different, shorter file name."""
    uri = "file:" + urllib.parse.quote(os.path.abspath(path)) + "?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=timeout)


def is_sqlite(path):
    try:
        with open(path, "rb") as f:
            return f.read(16) == SQLITE_MAGIC
    except OSError:
        return False


def img_type(blob):
    head = bytes(blob[:12])
    if head.startswith(b"\xff\xd8"):
        return "jpeg"
    if head.startswith(b"\x89PNG"):
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:2] == b"\x1f\x8b" or head[:1] == b"\x1a":
        return "vector"
    if head[:3] == b"GIF":
        return "gif"
    return None


def xyz_bounds(z, x0, x1, y0, y1):
    """lon/lat box of an inclusive XYZ tile range."""
    west, north = mbtiles.tile_lonlat(z, x0, y0)
    east, south = mbtiles.tile_lonlat(z, x1 + 1, y1 + 1)
    return (west, south, east, north)


def parse_bounds(text):
    try:
        b = tuple(float(v) for v in (text or "").split(","))
        return b if len(b) == 4 else None
    except ValueError:
        return None


def read_meta(db):
    try:
        return {str(k): str(v) for k, v in db.execute("SELECT name, value FROM metadata")}
    except sqlite3.Error:
        return {}


def flip(z, y):
    return (1 << z) - 1 - y


def _iou(a, b):
    i = regions.intersect(a, b)
    if not i:
        return 0.0
    return regions.area(i) / (regions.area(a) + regions.area(b) - regions.area(i))


def describe(zooms):
    """lon/lat box of a scan() result, from its deepest zoom."""
    zmax = max(zooms)
    r = zooms[zmax]
    return xyz_bounds(zmax, r["x0"], r["x1"], r["y0"], r["y1"])


def zoom_numbering(name, rows, meta):
    """RMaps/OsmAnd store z either as the zoom or as 17 - zoom; pick the one the tile numbers fit.
    rows: [(stored z, max x, max y)]. Returns (17 or 0, note)."""
    def fits(shift):
        for z, mx, my in rows:
            zoom = (17 - z) if shift else z
            if not 0 <= zoom <= 30 or mx >= (1 << zoom) or my >= (1 << zoom):
                return False
        return True

    want = (meta.get("tilenumbering") or "").lower() == "bigplanet" or "tilenumbering" not in meta
    if fits(want):
        return (17 if want else 0), ("zoom numbers stored as 17 - zoom (BigPlanet/RMaps)" if want
                                     else "zoom numbers stored as they are")
    if fits(not want):
        return (0 if want else 17), ("zoom numbers stored as " + ("17 - zoom" if not want else "they are")
                                     + " (the only way the tile numbers fit)")
    raise SourceError(f"{name}: its tile numbers don't fit any zoom numbering",
                      "The file may be damaged, or it is a layout this tool doesn't know.")


class TileSource:
    def __init__(self, path, scheme="auto"):
        self.path = path
        self.name = os.path.basename(path.rstrip("/"))
        self.meta = {}
        self.notes = []           # facts worth telling (shown by inspect)
        self.zoom_shift = None    # rmaps: zoom = 17 - z ("bigplanet") or z
        self.indexed = True
        if not os.path.exists(path):
            raise SourceError(f"{self.name} not found")
        if os.path.isdir(path):
            self.kind, self.label = "folder", "{z}/{x}/{y} tile folder"
            if not any(n.isdigit() and os.path.isdir(os.path.join(path, n)) for n in os.listdir(path)):
                inside = sorted(n for n in os.listdir(path) if n.lower().endswith(SQLITE_EXTS))
                raise SourceError(f"{self.name}/ has no zoom-level folders (0/, 1/, ... 17/) in it",
                                  f"It holds {', '.join(inside)}: choose that file instead." if inside else
                                  "A tile folder has one folder per zoom level, each with one folder per column.")
        else:
            self._open_sqlite()
        try:
            self.scheme, self.reason = self._decide_rows(scheme)
        except sqlite3.DatabaseError as e:
            raise damaged(self.name, e, self.path)

    # ------------------------------------------------------------------ SQLite
    def _open_sqlite(self):
        size = os.path.getsize(self.path)
        if size == 0:
            raise SourceError(f"{self.name} is empty (0 bytes)", "Copy or upload it again.")
        if not is_sqlite(self.path):
            with open(self.path, "rb") as f:
                head = f.read(64)
            what = "an HTML page (a failed download?)" if b"<html" in head.lower() or b"<!doc" in head.lower() else \
                   "a zip archive: unpack it on the Files tab" if head[:2] == b"PK" else \
                   f"something else (it starts with {head[:16]!r})"
            raise SourceError(f"{self.name} is not an SQLite database, so not an MBTiles file: it is {what}")
        try:
            db = open_ro(self.path)
            objs = {n: t for n, t in db.execute("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view')")}
        except sqlite3.DatabaseError as e:
            raise damaged(self.name, e, self.path)
        try:
            self._classify(db, objs)
            self._check_first(db)
        except sqlite3.DatabaseError as e:
            raise damaged(self.name, e, self.path)
        finally:
            db.close()

    def _cols(self, db, table):
        return {r[1] for r in db.execute(f"PRAGMA table_info('{table}')")}

    def _classify(self, db, objs):
        tables = ", ".join(sorted(objs)) or "none"
        if "tiles" not in objs:
            if {"map", "images"} <= set(objs):
                raise SourceError(f"{self.name} has 'map' and 'images' tables but no 'tiles' view",
                                  "It is an incomplete deduplicated MBTiles; export it again.")
            raise SourceError(f"{self.name} is an SQLite database but has no 'tiles' table (its tables: {tables})",
                              "It is not a tile file this tool knows (MBTiles, RMaps/OsmAnd .sqlitedb, OruxMaps).")
        cols = self._cols(db, "tiles")
        if {"zoom_level", "tile_column", "tile_row", "tile_data"} <= cols:
            self.kind = "mbtiles"
            self.label = "MBTiles" + (" (deduplicated: map + images)" if objs["tiles"] == "view" else "")
            self.meta = read_meta(db)
        elif {"x", "y", "z", "image"} <= cols:
            self.kind = "rmaps" if ("s" in cols or "info" in objs) else "orux"
            self.label = LAYOUTS[self.kind]["label"]
            if "info" in objs:
                try:
                    cur = db.execute("SELECT * FROM info LIMIT 1")
                    row = cur.fetchone()
                    if row:
                        self.meta = {d[0].lower(): ("" if v is None else str(v)) for d, v in zip(cur.description, row)}
                except sqlite3.Error:
                    pass
        else:
            raise SourceError(f"{self.name} has a 'tiles' table with columns {', '.join(sorted(cols))}",
                              "That is not a tile layout this tool knows (MBTiles, RMaps/OsmAnd .sqlitedb, OruxMaps).")
        L = LAYOUTS[self.kind]
        self.c = L
        # an index whose first column is the zoom makes per-zoom questions instant
        self.indexed = False
        if objs["tiles"] == "view":
            self.indexed = bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='index' AND tbl_name='map'").fetchone())
        else:
            for idx in db.execute("PRAGMA index_list('tiles')").fetchall():
                first = [r[2] for r in db.execute(f"PRAGMA index_info('{idx[1]}')")][:1]
                if first in ([L["z"]], [L["x"]]):
                    self.indexed = True
        if self.kind == "rmaps":
            self._decide_zoom(db)
        elif self.kind == "orux":
            self.zoom_shift = 0

    def _decide_zoom(self, db):
        L = self.c
        rows = db.execute(f"SELECT {L['z']}, MAX({L['x']}), MAX({L['y']}) FROM tiles GROUP BY {L['z']}").fetchall()
        self.zoom_shift, note = zoom_numbering(self.name, rows, self.meta)
        self.notes.append(note)

    def zoom(self, z):
        """stored z -> zoom"""
        return (17 - z) if self.zoom_shift == 17 else z

    def stored_z(self, zoom):
        return (17 - zoom) if self.zoom_shift == 17 else zoom

    def _check_first(self, db):
        L = self.c
        first = db.execute(f"SELECT {L['data']} FROM tiles WHERE {L['data']} IS NOT NULL LIMIT 1").fetchone()
        if first is None:
            raise SourceError(f"{self.name} has no tiles in it", "The export may have failed or been stopped early.")
        fmt = (self.meta.get("format") or "").lower()
        if fmt in ("pbf", "mvt") or img_type(first[0]) == "vector":
            raise SourceError(f"{self.name} holds vector tiles (format {fmt or 'pbf'}), not imagery",
                              "The map tile server and the log viewer need raster tiles (JPEG/PNG/WebP).")

    # ------------------------------------------------------------- row order
    def _decide_rows(self, scheme):
        if scheme != "auto":
            return scheme, "as chosen"
        if self.kind == "folder":
            if os.path.exists(os.path.join(self.path, "tilemapresource.xml")):
                return "tms", "tilemapresource.xml present (gdal2tiles writes TMS rows)"
            return "xyz", "the usual row order of tile folders (Google/OSM/SAS.Planet)"
        if self.kind in ("rmaps", "orux"):
            if (self.meta.get("inverted_y") or "0") not in ("0", ""):
                return "tms", "its info table says inverted_y"
            return "xyz", f"the row order of {self.label.split(' (')[0]}"
        if (self.meta.get("scheme") or "").lower() == "xyz":
            return "xyz", "metadata says scheme=xyz"
        b = parse_bounds(self.meta.get("bounds"))
        if b and not (b[0] <= -179.9 and b[2] >= 179.9):
            db = open_ro(self.path)
            z = db.execute("SELECT MAX(zoom_level) FROM tiles").fetchone()[0]
            if z is not None:
                x0, x1, r0, r1 = db.execute("SELECT MIN(tile_column), MAX(tile_column), MIN(tile_row), MAX(tile_row) "
                                            "FROM tiles WHERE zoom_level=?", (z,)).fetchone()
                db.close()
                as_tms = xyz_bounds(z, x0, x1, flip(z, r1), flip(z, r0))
                as_xyz = xyz_bounds(z, x0, x1, r0, r1)
                if _iou(as_xyz, b) > max(0.3, 2 * _iou(as_tms, b)):
                    return "xyz", "its tile rows only match its 'bounds' metadata read top-down (XYZ)"
            else:
                db.close()
        return "tms", "the MBTiles standard"

    def _row(self, zoom, y):
        """Stored row -> TMS row."""
        return flip(zoom, y) if self.scheme == "xyz" else y

    # --------------------------------------------------------------- reading
    def scan(self):
        """{zoom: {count, x0, x1, y0, y1 (XYZ rows)}}, size in bytes (the file size for SQLite)."""
        zooms = {}
        if self.kind == "folder":
            nbytes = 0
            for z, x, y, path in mbtiles._iter_tiles(self.path):
                yx = flip(z, self._row(z, y))
                r = zooms.get(z)
                if r is None:
                    zooms[z] = r = {"count": 0, "x0": x, "x1": x, "y0": yx, "y1": yx}
                r["count"] += 1
                r["x0"], r["x1"] = min(r["x0"], x), max(r["x1"], x)
                r["y0"], r["y1"] = min(r["y0"], yx), max(r["y1"], yx)
                try:
                    nbytes += os.path.getsize(path)
                except OSError:
                    pass
            return zooms, nbytes
        L = self.c
        db = open_ro(self.path)
        try:
            return self._scan_db(db, L, zooms)
        except sqlite3.DatabaseError as e:
            raise damaged(self.name, e, self.path)
        finally:
            db.close()

    def _scan_db(self, db, L, zooms):
        # per zoom, so an index on the zoom answers without reading any tile
        for sz in [r[0] for r in db.execute(f"SELECT DISTINCT {L['z']} FROM tiles")]:
            n, x0, x1, y0, y1 = db.execute(
                f"SELECT COUNT(*), MIN({L['x']}), MAX({L['x']}), MIN({L['y']}), MAX({L['y']}) "
                f"FROM tiles WHERE {L['z']}=?", (sz,)).fetchone()
            z = self.zoom(sz)
            ya, yb = flip(z, self._row(z, y0)), flip(z, self._row(z, y1))
            zooms[z] = {"count": n, "x0": x0, "x1": x1, "y0": min(ya, yb), "y1": max(ya, yb)}
        return zooms, os.path.getsize(self.path)

    def keys(self):
        if self.kind == "folder":
            for z, x, y, _ in mbtiles._iter_tiles(self.path):
                yield z, x, self._row(z, y)
            return
        L = self.c
        db = open_ro(self.path)
        try:
            for sz, x, y in db.execute(f"SELECT {L['z']}, {L['x']}, {L['y']} FROM tiles"):
                z = self.zoom(sz)
                yield z, x, self._row(z, y)
        finally:
            db.close()

    def tiles(self):
        if self.kind == "folder":
            for z, x, y, path in mbtiles._iter_tiles(self.path):
                with open(path, "rb") as f:
                    data = f.read()
                if data:
                    yield z, x, self._row(z, y), data
            return
        # no ORDER BY: sorting a multi-GB table would copy every tile into a temp file
        L = self.c
        db = open_ro(self.path)
        try:
            for sz, x, y, data in db.execute(f"SELECT {L['z']}, {L['x']}, {L['y']}, {L['data']} FROM tiles"):
                if data:
                    z = self.zoom(sz)
                    yield z, x, self._row(z, y), bytes(data)
        finally:
            db.close()

    def sample(self, zooms, per_zoom=20):
        """A few tiles from every zoom: [(zoom, bytes)]."""
        out = []
        if self.kind == "folder":
            for z in sorted(zooms):
                zdir = os.path.join(self.path, str(z))
                got = 0
                for xn in sorted(os.listdir(zdir))[:per_zoom]:
                    xd = os.path.join(zdir, xn)
                    if not os.path.isdir(xd):
                        continue
                    for yn in sorted(os.listdir(xd))[:2]:
                        with open(os.path.join(xd, yn), "rb") as f:
                            out.append((z, f.read()))
                        got += 1
                    if got >= per_zoom:
                        break
            return out
        L = self.c
        db = open_ro(self.path)
        try:
            for z in sorted(zooms):
                for (data,) in db.execute(f"SELECT {L['data']} FROM tiles WHERE {L['z']}=? LIMIT ?",
                                          (self.stored_z(z), per_zoom)):
                    out.append((z, bytes(data) if data is not None else b""))
        except sqlite3.DatabaseError as e:
            raise damaged(self.name, e, self.path)
        finally:
            db.close()
        return out

    def tile_size(self, zooms=None):
        """Pixel size of the source's tiles (from a tile at its deepest zoom)."""
        if zooms is None:
            zooms, _ = self.scan()
        if not zooms:
            return None
        for _, blob in self.sample({max(zooms): None}, per_zoom=5):
            if img_type(blob) in ("jpeg", "png", "webp", "gif"):
                try:
                    return int(mbtiles._decode_rgba(blob).shape[1])
                except RuntimeError:
                    continue
        return None

    def flipped_bounds(self, zooms):
        """Where the area would be with the other row order (to warn about a likely mix-up)."""
        zmax = max(zooms)
        r = zooms[zmax]
        return xyz_bounds(zmax, r["x0"], r["x1"], flip(zmax, r["y1"]), flip(zmax, r["y0"]))


def summary(path, scheme="auto"):
    """For the tools page: what a tile folder / tile file holds, read the way add-mbtiles reads it."""
    try:
        src = TileSource(path, scheme)
        zooms, nbytes = src.scan()
    except SourceError as e:
        return {"error": e.full(), "damaged": "is damaged" in str(e)}
    except sqlite3.DatabaseError as e:
        return {"error": damaged(os.path.basename(path), e, path).full(), "damaged": True}
    except sqlite3.Error as e:
        return {"error": f"{os.path.basename(path)}: reading it failed ({e})"}
    if not zooms:
        return {"error": f"{src.name} has no tiles in it"}
    b = describe(zooms)
    if not all(math.isfinite(v) for v in b):
        return {"error": f"{src.name}: its tile numbers are out of range"}
    return {"layout": src.kind, "label": src.label, "scheme": src.scheme, "reason": src.reason,
            "zooms": [min(zooms), max(zooms)], "tiles": sum(r["count"] for r in zooms.values()), "bytes": nbytes,
            "bounds": [round(v, 5) for v in b], "format": src.meta.get("format"), "indexed": src.indexed}
