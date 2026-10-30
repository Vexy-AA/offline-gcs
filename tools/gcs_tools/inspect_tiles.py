"""Explain step by step what a tile file or tile folder holds, and why it can or can't be used.

    ./gcs-tools inspect data/src/north.mbtiles
    ./gcs-tools inspect data/src/NorthXYZ --target data/mbtiles/custom.mbtiles
    ./gcs-tools inspect data/src/north.mbtiles --deep      also checks the whole file for damage

Each step prints  ok / !  (works, but worth knowing) / X  (this is the problem),
and the last line says whether add-mbtiles can use it. Nothing is changed.
"""

import argparse
import os
import sqlite3
import sys
import time

from . import regions, tilesource
from .common import fmt_size
from .tilesource import SourceError, TileSource, describe, open_ro

OK, WARN, BAD = "  ok ", "  !  ", "  X  "


def say(mark, text):
    print(f"{mark}{text}", flush=True)


def fmt_box(b):
    return f"W {b[0]:.5f}  S {b[1]:.5f}  E {b[2]:.5f}  N {b[3]:.5f}"


def other_files(path):
    base = os.path.dirname(os.path.abspath(path))
    stem = os.path.basename(path)
    return [n for n in (stem + "-wal", stem + "-journal") if os.path.exists(os.path.join(base, n))]


def inspect(path, target=None, deep=False):
    """Returns (usable, verdict)."""
    from osgeo import gdal
    gdal.PushErrorHandler("CPLQuietErrorHandler")  # damaged JPEGs are counted below, not printed by libjpeg
    name = os.path.basename(path.rstrip("/"))
    if not os.path.exists(path):
        say(BAD, f"{name} not found")
        return False, "the file is not there"
    if os.path.isdir(path):
        n = sum(1 for _ in os.scandir(path))
        print(f"{name}/  folder, {n} entries")
    else:
        st = os.stat(path)
        print(f"{name}  {fmt_size(st.st_size)}, modified {time.strftime('%Y-%m-%d %H:%M', time.localtime(st.st_mtime))}")
        hs = tilesource.header_size(path)
        if hs and hs[1] < hs[0]:
            say(BAD, f"cut short: {fmt_size(hs[1])} of the {fmt_size(hs[0])} its header says it has "
                     f"({100 * hs[1] / hs[0]:.0f}%)")
        elif hs:
            say(OK, "full size (as its header says)")
        if time.time() - st.st_mtime < 120:
            say(WARN, "changed less than 2 minutes ago: if it is still being copied or uploaded, check again when that is done")
        if not tilesource.is_sqlite(path) and not path.lower().endswith(tilesource.SQLITE_EXTS):
            say(BAD, "not a tile file or tile folder (no SQLite header)")
            if path.lower().endswith((".tif", ".tiff", ".vrt", ".jp2", ".img", ".ecw", ".sid")):
                return False, ("this is a raster image, not tiles: it is listed under 'Imagery GeoTIFFs' "
                               "if it is 8-bit imagery, or under 'Elevation model' if it is a DEM")
            if path.lower().endswith(".zip"):
                return False, "this is a zip: unpack it on the Files tab, then pick what was inside"
            return False, "not a tile file"

    # 1. open and classify
    try:
        src = TileSource(path)
    except SourceError as e:
        say(BAD, str(e))
        return False, e.full()
    if src.kind == "folder":
        say(OK, "a {z}/{x}/{y} tile folder")
    else:
        say(OK, f"opens as an SQLite database: {src.label}")
        extra = other_files(path)
        if extra:
            say(WARN, f"{', '.join(extra)} next to it: another program may still have it open. "
                      "Close that program (or finish the export) and copy the file again with it.")
        say(OK if src.indexed else WARN, "has an index on the tile numbers" if src.indexed else
            "no index on the tile numbers: everything that reads it scans the whole file (slow for big files)")
        if src.kind == "mbtiles":
            m = src.meta
            if m:
                shown = {k: m[k] for k in ("name", "format", "bounds", "minzoom", "maxzoom", "scheme") if k in m}
                say(OK, "metadata: " + ", ".join(f"{k}={v}" for k, v in shown.items()))
            else:
                say(WARN, "no metadata table (not needed: the area is worked out from the tiles)")
        elif src.meta:
            say(OK, "info: " + ", ".join(f"{k}={v}" for k, v in src.meta.items() if v != ""))
    for n in src.notes:
        say(OK, n)

    # 2. tiles per zoom
    t0 = time.time()
    if src.kind != "folder" and not src.indexed and os.path.getsize(path) > 200 * 2**20:
        say(WARN, f"counting tiles: reading all {fmt_size(os.path.getsize(path))}...")
    try:
        zooms, nbytes = src.scan()
    except sqlite3.DatabaseError as e:
        say(BAD, f"reading the tiles failed: {e}")
        return False, "the file is damaged or incomplete: copy or export it again"
    if not zooms:
        say(BAD, "no tiles in it")
        return False, "it holds no tiles: the export probably failed or was stopped"
    total = sum(r["count"] for r in zooms.values())
    say(OK, f"{total} tiles at zoom {min(zooms)}-{max(zooms)}: "
            + ", ".join(f"z{z} {zooms[z]['count']}" for z in sorted(zooms))
            + (f"  ({time.time() - t0:.0f} s)" if time.time() - t0 > 2 else ""))
    bad_zoom = [z for z in zooms if not 0 <= z <= 24]
    if bad_zoom:
        say(BAD, f"zoom levels {bad_zoom} are impossible for web map tiles")
        return False, "the zoom numbers are wrong: the file is not a web-mercator tile set this tool can read"
    over = [z for z in zooms if zooms[z]["x1"] >= (1 << z) or zooms[z]["y1"] >= (1 << z) or zooms[z]["y0"] < 0]
    if over:
        say(BAD, f"tile numbers too big for their zoom at z{over[0]} (x up to {zooms[over[0]]['x1']})")
        return False, "the tile numbers don't fit the zoom levels: it is not a standard web map tile set"

    # 3. what the tiles are
    kinds, sizes, undecodable = {}, {}, 0
    sample = src.sample(zooms, per_zoom=10)
    for _, blob in sample:
        k = tilesource.img_type(blob) or ("empty" if not blob else "unknown")
        kinds[k] = kinds.get(k, 0) + 1
        if k in ("jpeg", "png", "webp", "gif"):
            try:
                from . import mbtiles
                s = mbtiles._decode_rgba(blob).shape[1]
                sizes[s] = sizes.get(s, 0) + 1
            except RuntimeError:
                undecodable += 1
    images = sum(kinds.get(k, 0) for k in ("jpeg", "png", "webp", "gif"))
    say(OK if images == len(sample) else (WARN if images else BAD),
        f"looked at {len(sample)} tiles: " + ", ".join(f"{n} {k.upper()}" for k, n in sorted(kinds.items())))
    if not images:
        if kinds.get("vector"):
            return False, "it holds vector tiles, not images: the log viewer needs raster tiles"
        first = next((b for _, b in sample if b), b"")
        return False, f"the tiles are not images (they start with {first[:12]!r})"
    if kinds.get("unknown") or kinds.get("empty"):
        say(WARN, "some tiles are not images; they are skipped when merging")
    if undecodable:
        say(WARN, f"{undecodable} sampled tiles could not be decoded (damaged images?)")
    if sizes:
        size = max(sizes, key=sizes.get)
        say(OK if size == 256 else WARN, f"tile size {size} px" + ("" if size == 256 else
            ": merged into a 256 px tile set they are scaled to 256 px"))

    # 4. where it is
    box = describe(zooms)
    say(OK, f"rows read as {src.scheme.upper()} ({src.reason})")
    say(OK, f"area: {fmt_box(box)}")
    mb = tilesource.parse_bounds(src.meta.get("bounds")) if src.kind == "mbtiles" else None
    if mb and not (mb[0] <= -179.9 and mb[2] >= 179.9) and tilesource._iou(box, mb) < 0.3:
        say(WARN, f"its own 'bounds' metadata says {fmt_box(mb)}, which is not where its tiles are; "
                  "the tiles are what counts (the metadata is often left over from another export)")
    if target and os.path.exists(target):
        try:
            tdb = open_ro(target)
            tb = tilesource.parse_bounds(tilesource.read_meta(tdb).get("bounds"))
            tdb.close()
        except sqlite3.Error:
            tb = None
        if tb:
            frac = regions.covered_fraction(box, [tb])
            tname = os.path.basename(target)
            if frac > 0:
                say(OK, f"{100 * frac:.0f}% of it lies inside {tname} ({fmt_box(tb)})")
            else:
                flipped = src.flipped_bounds(zooms)
                if regions.covered_fraction(flipped, [tb]) > 0:
                    other = "TMS" if src.scheme == "xyz" else "XYZ"
                    say(WARN, f"it doesn't touch {tname}, but read with {other} rows it would: if it should "
                              f"overlap, choose Tile rows = {other} (--scheme {other.lower()})")
                else:
                    say(OK, f"it lies outside {tname} ({fmt_box(tb)}): it is added next to it")

    # 5. damage
    if deep and src.kind != "folder":
        say(OK, "checking the whole file for damage (PRAGMA quick_check)...")
        db = open_ro(path, timeout=30)
        res = [r[0] for r in db.execute("PRAGMA quick_check(5)")]
        db.close()
        if res != ["ok"]:
            say(BAD, "the file is damaged: " + "; ".join(res))
            return False, tilesource.damaged(name, "quick_check: " + res[0], path).full()
        say(OK, "no damage found")
    return True, ("it can be added as new imagery (Add area > Imagery)"
                  + ("" if deep or src.kind == "folder" else
                     ". This quick check reads only part of the file; --deep (on the page: 'Also check the "
                     "whole file for damage') reads all of it"))


def build_parser(p=None):
    p = p or argparse.ArgumentParser(prog="inspect", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("path", help="tile file (.mbtiles, .sqlitedb, ...) or {z}/{x}/{y} folder")
    p.add_argument("--target", help="tile set it would be added to, to say where it lies (e.g. data/mbtiles/custom.mbtiles)")
    p.add_argument("--deep", action="store_true", help="also check the whole file for damage (reads all of it)")
    return p


def main(argv=None, args=None):
    if args is None:
        args = build_parser().parse_args(argv)
    usable, verdict = inspect(args.path, args.target, args.deep)
    print(("RESULT: usable: " if usable else "RESULT: not usable: ") + verdict, flush=True)
    if not usable:
        sys.exit(1)


if __name__ == "__main__":
    main()
