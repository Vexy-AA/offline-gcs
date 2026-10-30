"""Add a new area to an existing .mbtiles file without rebuilding (or losing) what is in it.

    ./gcs-tools add-mbtiles data/src/NorthXYZ   data/mbtiles/custom.mbtiles
    ./gcs-tools add-mbtiles data/src/north.tif  data/mbtiles/custom.mbtiles --prefer new
    ./gcs-tools add-mbtiles data/src/other.mbtiles data/mbtiles/custom.mbtiles --dry-run

The new area can be a {z}/{x}/{y} tile folder, another .mbtiles file, or imagery
raster(s) (cut into tiles first, exactly like the mbtiles command does). Folders and
.mbtiles files are read the same way; the row order of each is detected (--scheme),
512 px tiles are scaled to the file's tile size, and vector .mbtiles are refused.

  * Tiles the file doesn't have yet are added as they are (no re-encoding).
  * Where both have a tile (the overlap, and the zoomed-out tiles that cover both
    areas), --prefer decides which one is on top: "existing" (default) keeps every
    pixel the file already has and only fills its transparent parts from the new
    tile; "new" does the opposite. Fully opaque tiles (JPEG) are kept or replaced
    whole, without re-encoding.
  * If the new area starts at a deeper zoom than the file (a tile folder with
    zoom 12-17, say), the zoomed-out levels are built for it from its tiles and
    merged the same way, so the new area is visible when zoomed out too
    (--no-lower-zooms to skip).

Nothing is changed in place: the file is copied to data/.work, merged and checked
there, then swapped in with one atomic rename. The previous file becomes a
restore point in data/backups (a hard link, so it costs no extra space):
./gcs-tools backups restore <id> puts it back.
"""

import argparse
import multiprocessing as mp
import os
import shutil
import sqlite3
import sys
import time

import numpy as np
from osgeo import gdal

from . import backups, mbtiles, regions, tilesource
from .common import Ticker, check_cancel, fmt_size, fmt_time, pool_map
from .tilesource import SourceError, TileSource, describe, open_ro, xyz_bounds
from .tilesource import parse_bounds as _parse_bounds
from .tilesource import read_meta as _meta

gdal.UseExceptions()

def img_type(blob):
    """jpeg / png / webp / gif, or None for anything that isn't a raster image."""
    k = tilesource.img_type(blob)
    return k if k in ("jpeg", "png", "webp", "gif") else None


# --------------------------------------------------------------------------
# Pixels (run in worker processes)
# --------------------------------------------------------------------------

_O = {}


def _init(opts):
    gdal.UseExceptions()
    _O.update(opts)


def _rgba(blob, size):
    a = mbtiles._decode_rgba(blob)
    if a.shape[1] != size or a.shape[2] != size:
        a = _resize(a, size)
    return a


def _resize(a, size):
    """Nearest/average resize of a (4, h, w) tile to (4, size, size) (512 px retina tiles, etc.)."""
    h = a.shape[1]
    if h % size == 0:
        f = h // size
        alpha = a[3].astype(np.float64).reshape(size, f, size, f)
        asum = alpha.sum(axis=(1, 3))
        out = np.zeros((4, size, size))
        for b in range(3):
            c = (a[b] * a[3].astype(np.float64)).reshape(size, f, size, f).sum(axis=(1, 3))
            out[b] = np.where(asum > 0, c / np.maximum(asum, 1e-9), 0)
        out[3] = asum / (f * f)
        return np.clip(np.rint(out), 0, 255).astype(np.uint8)
    idx = (np.arange(size) * h // size)
    return a[:, idx][:, :, idx]


def _alpha(rgba):
    """Coverage 0..1; with black_empty, pure black opaque pixels count as empty."""
    a = rgba[3].astype(np.float64) / 255.0
    if _O.get("black_empty"):
        black = (rgba[0] == 0) & (rgba[1] == 0) & (rgba[2] == 0)
        a = np.where(black, 0.0, a)
    return a


def _encode(rgba, lossless=False):
    """JPEG when opaque, PNG when there is transparency (like the mbtiles command's auto format).
    lossless: a PNG tile went into it, so its pixels must come out exactly as they were."""
    opaque = bool((rgba[3] == 255).all())
    fmt = _O.get("fmt", "auto")
    if fmt == "webp":
        kind = "webp"
    elif opaque and not lossless and fmt in ("auto", "jpeg"):
        kind = "jpeg"
    else:
        kind = "png"
    return mbtiles._encode(rgba, kind, _O.get("quality", 85))


def _over(top, bottom):
    """Composite RGBA `top` over `bottom` (uint8 arrays). Returns 'top', 'bottom' or a new array."""
    ta = _alpha(top)
    if (ta >= 1.0).all():
        return "top"
    ba = _alpha(bottom)
    if not ta.any():
        return "bottom" if ba.any() or not (top[3] > 0).any() else "top"
    if not ba.any():
        return "top"
    out_a = ta + ba * (1.0 - ta)
    out = np.zeros((4,) + top.shape[1:])
    safe = np.maximum(out_a, 1e-9)
    for b in range(3):
        out[b] = (top[b] * ta + bottom[b] * ba * (1.0 - ta)) / safe
    out[3] = out_a * 255.0
    if _O.get("black_empty"):
        # where both are "empty" only because they are black, keep the original pixel (still black)
        none = out_a <= 0
        if none.any():
            src = np.where(top[3] > 0, 1, 0).astype(bool)
            for b in range(4):
                out[b] = np.where(none & src, top[b], np.where(none, bottom[b], out[b]))
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def _merge_job(item):
    """(key, rowid, top_blob, bottom_blob, top_is_new) -> (key, rowid, action, blob)

    action: 'keep' (the existing tile stays) or 'set' (blob replaces it)."""
    key, rowid, top_blob, bottom_blob, top_is_new = item
    size = _O["size"]
    try:
        top, bottom = _rgba(top_blob, size), _rgba(bottom_blob, size)
    except RuntimeError:
        # undecodable tile: keep whichever has priority, as-is
        return key, rowid, ("set", top_blob) if top_is_new else ("keep", None)
    res = _over(top, bottom)
    if isinstance(res, str):
        winner_is_new = (res == "top") == top_is_new
        if winner_is_new:
            return key, rowid, ("set", top_blob if top_is_new else bottom_blob)
        return key, rowid, ("keep", None)
    return key, rowid, ("set", _encode(res, lossless="png" in (img_type(top_blob), img_type(bottom_blob))))


def _fit_job(item):
    """(key, blob) -> (key, None, ('set', blob resized to the target's tile size))."""
    key, blob = item
    try:
        rgba = _rgba(blob, _O["size"])
    except RuntimeError:
        return key, None, ("skip", None)
    return key, None, ("set", _encode(rgba, lossless=img_type(blob) == "png"))


def _rendition(kids, size):
    """Zoomed-out tile made from up to four children {(dx, dy): blob}; None if empty.
    dy is the TMS row offset (1 = north half)."""
    canvas = np.zeros((4, 2 * size, 2 * size), dtype=np.float64)
    for (dx, dy), blob in kids.items():
        try:
            img = _rgba(blob, size).astype(np.float64)
        except RuntimeError:
            continue
        oy = 0 if dy == 1 else size
        canvas[:, oy:oy + size, dx * size:dx * size + size] = img
    a = canvas[3].reshape(size, 2, size, 2)
    a_sum = a.sum(axis=(1, 3))
    if not a_sum.any():
        return None
    out = np.zeros((4, size, size))
    for b in range(3):
        c = (canvas[b] * canvas[3]).reshape(size, 2, size, 2).sum(axis=(1, 3))
        out[b] = np.where(a_sum > 0, c / np.maximum(a_sum, 1e-9), 0)
    out[3] = a_sum / 4.0
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def _parent_job(item):
    """(key, kids, rowid, existing_blob) -> (key, rowid, action, blob); action: keep / set / insert."""
    key, kids, rowid, existing = item
    size = _O["size"]
    rend = _rendition(kids, size)
    if rend is None:
        return key, rowid, ("keep", None)
    if existing is None:
        return key, rowid, ("insert", _encode(rend))
    try:
        old = _rgba(existing, size)
    except RuntimeError:
        return key, rowid, ("keep", None)
    lossless = img_type(existing) == "png"
    if _O["prefer"] == "existing":
        res = _over(old, rend)
        if isinstance(res, str):
            return key, rowid, ("keep", None) if res == "top" else ("set", _encode(rend))
    else:
        res = _over(rend, old)
        if isinstance(res, str):
            return key, rowid, ("set", _encode(rend)) if res == "top" else ("keep", None)
    return key, rowid, ("set", _encode(res, lossless))


# --------------------------------------------------------------------------
# Target
# --------------------------------------------------------------------------

def _copy(src, dst):
    total = os.path.getsize(src)
    done = 0
    tick = Ticker()
    with open(src, "rb") as fi, open(dst, "wb") as fo:
        while True:
            check_cancel()
            buf = fi.read(16 * 1024 * 1024)
            if not buf:
                break
            fo.write(buf)
            done += len(buf)
            if tick.due():
                print(f"  copy: {100.0 * done / max(total, 1):.0f}%", flush=True)
    shutil.copystat(src, dst)


def _prepare_target(db):
    kind = db.execute("SELECT type FROM sqlite_master WHERE name='tiles'").fetchone()
    if kind is None:
        sys.exit("ERROR: the target has no 'tiles' table; is it an MBTiles file?")
    db.execute("CREATE TABLE IF NOT EXISTS metadata (name TEXT, value TEXT)")
    if kind[0] == "view":
        # deduplicated layout (map + images): store the tiles flat, like the rest of this stack
        print("  target stores tiles as map+images (deduplicated); converting the copy to a plain tiles table")
        db.executescript("""
            CREATE TABLE tiles_flat (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
            INSERT INTO tiles_flat SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles;
            DROP VIEW tiles;
            ALTER TABLE tiles_flat RENAME TO tiles;
        """)
    has_index = False
    for idx in db.execute("PRAGMA index_list(tiles)").fetchall():
        cols = [r[2] for r in db.execute(f"PRAGMA index_info('{idx[1]}')")]
        if cols[:3] == ["zoom_level", "tile_column", "tile_row"]:
            has_index = True
    if not has_index:
        print("  indexing the copy")
        try:
            db.execute("CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row)")
        except sqlite3.IntegrityError:
            db.execute("CREATE INDEX tile_index_nu ON tiles (zoom_level, tile_column, tile_row)")
    db.commit()


def _tile_size(db):
    row = db.execute("SELECT tile_data FROM tiles WHERE zoom_level=(SELECT MAX(zoom_level) FROM tiles) LIMIT 1").fetchone()
    if row is None:
        return 256
    try:
        return int(mbtiles._decode_rgba(bytes(row[0])).shape[1])
    except RuntimeError:
        return 256


def _set_meta(db, name, value):
    if db.execute("SELECT 1 FROM metadata WHERE name=?", (name,)).fetchone():
        db.execute("UPDATE metadata SET value=? WHERE name=?", (value, name))
    else:
        db.execute("INSERT INTO metadata (name, value) VALUES (?, ?)", (name, value))


def _get(db, z, x, row):
    return db.execute("SELECT rowid, tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                      (z, x, row)).fetchone()


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def plan(src, target_db):
    """Scan the source and count its tiles the target already has: (zooms, bytes, overlap per zoom)."""
    zooms, nbytes = src.scan()
    if not zooms:
        sys.exit(f"ERROR: no tiles found in {src.path}")
    overlap = {}
    tick = Ticker()
    n = 0
    for z, x, row in src.keys():
        check_cancel()
        n += 1
        if target_db.execute("SELECT 1 FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                             (z, x, row)).fetchone():
            overlap[z] = overlap.get(z, 0) + 1
        if tick.due():
            print(f"  comparing tiles: {n}", flush=True)
    return zooms, nbytes, overlap


def build_parser(p=None):
    p = p or argparse.ArgumentParser(prog="add-mbtiles", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("sources", nargs="+", metavar="SRC",
                   help="the new area: a {z}/{x}/{y} tile folder, a .mbtiles file, or imagery raster(s)")
    p.add_argument("target", metavar="TARGET.mbtiles", help="existing file to add to, e.g. data/mbtiles/custom.mbtiles")
    p.add_argument("--prefer", choices=["existing", "new"], default="existing",
                   help="where both have imagery: keep the existing tiles on top (default) or the new ones")
    p.add_argument("--no-lower-zooms", action="store_true",
                   help="don't build zoomed-out levels for the new area when it starts deeper than the file")
    p.add_argument("--min-zoom", type=int, default=None,
                   help="build zoomed-out levels down to this zoom (default: the file's own lowest zoom)")
    p.add_argument("--black-empty", action="store_true",
                   help="treat pure black pixels as empty when combining tiles (JPEG tiles with black edges)")
    p.add_argument("--scheme", choices=["auto", "xyz", "tms"], default="auto",
                   help="row order of a folder or .mbtiles source. auto (default): a folder is XYZ (Google/OSM/"
                        "SAS.Planet) unless it has gdal2tiles' tilemapresource.xml; an .mbtiles is TMS (the "
                        "standard) unless its metadata or bounds show XYZ rows")
    p.add_argument("--quality", type=int, default=85, help="JPEG/WebP quality of combined tiles (default 85)")
    p.add_argument("--max-zoom", type=int, help="raster source only: deepest zoom (default: from the image)")
    p.add_argument("--workers", type=int, default=os.cpu_count() or 1, help="processes (default: all CPUs)")
    p.add_argument("--dry-run", action="store_true", help="only report what would change")
    p.add_argument("--keep-work", action="store_true", help=argparse.SUPPRESS)
    return p


def _source_kind(sources):
    if len(sources) == 1 and os.path.isdir(sources[0]):
        return "folder"
    if any(os.path.isdir(s) for s in sources):
        sys.exit("ERROR: give either one tile folder, one tile file (.mbtiles, .sqlitedb), or raster file(s)")
    tiles = [s for s in sources if s.lower().endswith(tilesource.SQLITE_EXTS) or tilesource.is_sqlite(s)]
    if tiles:
        if len(sources) > 1:
            sys.exit("ERROR: add one tile file at a time, and don't mix it with rasters")
        return "mbtiles"
    return "raster"


def main(argv=None, args=None):
    try:
        _main(argv, args)
    except SourceError as e:
        sys.exit(f"ERROR: {e.full()}\nNothing was changed.")
    except sqlite3.DatabaseError as e:
        # a damaged new file found while reading it: the merge works on a copy, so nothing changed
        srcs = (args.sources if args else None) or ["the new file"]
        sys.exit(f"ERROR: {tilesource.damaged(os.path.basename(srcs[0].rstrip('/')), e, srcs[0]).full()}\n"
                 "Nothing was changed (the merge works on a copy of the tile set).")


def _main(argv=None, args=None):
    if args is None:
        args = build_parser().parse_args(argv)
    for s in args.sources:
        if not os.path.exists(s):
            sys.exit(f"ERROR: input not found: {s}")
    target = os.path.abspath(args.target)
    if not target.lower().endswith(".mbtiles"):
        sys.exit("ERROR: the target must be a .mbtiles file")
    if not os.path.isfile(target):
        sys.exit(f"ERROR: {args.target} does not exist. To make a new tile set use the mbtiles command "
                 "(Build data > Map tiles); add-mbtiles adds to an existing one.")
    if any(os.path.abspath(s) == target for s in args.sources):
        sys.exit("ERROR: source and target are the same file")
    src_kind = _source_kind(args.sources)
    folder = os.path.dirname(target)
    root = backups.root_of(folder)
    name = os.path.splitext(os.path.basename(target))[0]
    t0 = time.time()

    tdb = open_ro(target)
    tmeta = _meta(tdb)
    tz = {z: n for z, n in tdb.execute("SELECT zoom_level, COUNT(*) FROM tiles GROUP BY zoom_level")}
    if not tz:
        sys.exit(f"ERROR: {args.target} has no tiles")
    t_bounds = _parse_bounds(tmeta.get("bounds"))
    if t_bounds is None:
        zt = max(tz)
        x0, x1, r0, r1 = tdb.execute("SELECT MIN(tile_column), MAX(tile_column), MIN(tile_row), MAX(tile_row) "
                                     "FROM tiles WHERE zoom_level=?", (zt,)).fetchone()
        t_bounds = xyz_bounds(zt, x0, x1, (1 << zt) - 1 - r1, (1 << zt) - 1 - r0)
    print(f"Existing: {args.target}, {fmt_size(os.path.getsize(target))}, zoom {min(tz)}-{max(tz)}, "
          f"{sum(tz.values())} tiles, area {', '.join(f'{v:.4f}' for v in t_bounds)}")
    print(f"New area: {', '.join(args.sources)} ({src_kind})")
    print(f"Overlap rule: {'existing tiles stay on top' if args.prefer == 'existing' else 'new tiles go on top'}")

    work = os.path.join(root, ".work", f"add-mbtiles-{name}")
    if not args.dry_run:
        shutil.rmtree(work, ignore_errors=True)
        os.makedirs(work)
    try:
        src = args.sources[0]
        if src_kind == "raster":
            if args.dry_run:
                _plan_raster(args, tz, t_bounds)
                return
            print("Cutting the raster into tiles first")
            src = os.path.join(work, "src", "new.mbtiles")
            os.makedirs(os.path.dirname(src))
            margs = mbtiles.build_parser().parse_args([*args.sources, src, "--workers", str(args.workers)])
            margs.max_zoom = args.max_zoom
            margs.name, margs.out = "new", os.path.abspath(src)
            mbtiles.raster_to_mbtiles(margs)
            src_kind = "mbtiles"

        try:
            source = TileSource(src, args.scheme if src_kind != "raster" else "tms")
        except SourceError as e:
            sys.exit(f"ERROR: {e.full()}\nNothing was changed. (./gcs-tools inspect {src} explains it step by step)")
        if src_kind != "raster":
            print(f"  read as {source.label}" + (f", {'; '.join(source.notes)}" if source.notes else ""))
            print(f"  rows read as {source.scheme.upper()}: {source.reason}")
            if not source.indexed:
                print("  note: the file has no index on the zoom level, so reading it takes longer")
        zooms, nbytes, overlap = plan(source, tdb)
        tdb.close()
        s_bounds = describe(zooms)
        s_min, s_max = min(zooms), max(zooms)
        print(f"  new area: zoom {s_min}-{s_max}, {sum(r['count'] for r in zooms.values())} tiles, {fmt_size(nbytes)}, "
              f"area {', '.join(f'{v:.4f}' for v in s_bounds)}")
        frac = regions.covered_fraction(s_bounds, [t_bounds])
        print(f"  {100 * frac:.0f}% of the new area lies inside the existing area")
        if src_kind != "raster" and frac == 0 and regions.covered_fraction(source.flipped_bounds(zooms), [t_bounds]) > 0:
            other = "tms" if source.scheme == "xyz" else "xyz"
            print(f"WARNING: read with the other row order the new area would overlap the existing one: if it "
                  f"should, run again with --scheme {other} (on the page: Tile rows = {other.upper()}).")
        s_size = source.tile_size(zooms)
        for z in sorted(zooms):
            ov = overlap.get(z, 0)
            print(f"  z{z:<2} {zooms[z]['count']:>8} tiles: {zooms[z]['count'] - ov:>8} new, {ov:>8} already in the file")
        low_to = min(tz) if args.min_zoom is None else args.min_zoom
        lower = [] if args.no_lower_zooms else list(range(s_min - 1, low_to - 1, -1))
        if lower:
            print(f"  zoomed-out levels z{lower[-1]}-z{lower[0]} will be built for the new area and merged")
        need = os.path.getsize(target) + int(nbytes * 1.3) + 64 * 2**20
        free = shutil.disk_usage(root).free
        print(f"  disk: needs about {fmt_size(need)} in {os.path.join(root, '.work')}, {fmt_size(free)} free")
        if args.dry_run:
            print("Dry run: nothing changed.")
            return
        if free < need:
            sys.exit(f"ERROR: not enough free disk space ({fmt_size(free)} free, about {fmt_size(need)} needed)")

        out = os.path.join(work, f"{name}.mbtiles")
        print(f"Copying {args.target} to {out}")
        _copy(target, out)
        db = sqlite3.connect(out)
        db.execute("PRAGMA journal_mode=OFF")
        db.execute("PRAGMA synchronous=OFF")
        _prepare_target(db)
        size = _tile_size(db)
        resize = bool(s_size and s_size != size)
        if resize:
            print(f"  the new tiles are {s_size} px, the file's {size} px: new tiles are scaled to {size} px")
        fmt = {"png": "png", "webp": "webp"}.get((tmeta.get("format") or "").lower(), "auto")
        opts = {"size": size, "prefer": args.prefer, "black_empty": args.black_empty, "fmt": fmt,
                "quality": args.quality}
        before = db.execute("SELECT COUNT(*) FROM tiles").fetchone()[0]
        stats = {"added": 0, "replaced": 0, "combined": 0, "kept": 0, "same": 0, "skipped": 0}
        changed_low = set()
        lower_changes = [0]

        ctx = mp.get_context("spawn")
        with ctx.Pool(max(1, args.workers), initializer=_init, initargs=(opts,)) as pool:
            total = sum(r["count"] for r in zooms.values())
            print(f"Merging {total} tiles")
            it = source.tiles()
            done = 0
            tick = Ticker()
            batch = []

            def flush():
                inserts, updates, jobs = [], [], []
                if resize:
                    fitted = []
                    for (z, x, row), _, (action, data) in pool_map(
                            pool, _fit_job, [((z, x, row), b) for z, x, row, b in batch if img_type(b)], batch=8):
                        if action == "set":
                            fitted.append((z, x, row, data))
                    stats["skipped"] += len(batch) - len(fitted)
                    batch[:] = fitted
                for z, x, row, blob in batch:
                    if img_type(blob) is None:
                        stats["skipped"] += 1
                        continue
                    cur = _get(db, z, x, row)
                    if cur is None:
                        inserts.append((z, x, row, sqlite3.Binary(blob)))
                        stats["added"] += 1
                        if z == s_min:
                            changed_low.add((x, row))
                        continue
                    rowid, old = cur[0], bytes(cur[1])
                    if old == blob:
                        stats["same"] += 1
                        continue
                    if args.prefer == "existing":
                        if img_type(old) == "jpeg" and not args.black_empty:
                            stats["kept"] += 1
                            continue
                        jobs.append(((z, x, row), rowid, old, blob, False))
                    else:
                        if img_type(blob) == "jpeg" and not args.black_empty:
                            updates.append((sqlite3.Binary(blob), rowid))
                            stats["replaced"] += 1
                            if z == s_min:
                                changed_low.add((x, row))
                            continue
                        jobs.append(((z, x, row), rowid, blob, old, True))
                for (z, x, row), rowid, (action, data) in pool_map(pool, _merge_job, jobs, batch=8):
                    if action == "keep":
                        stats["kept"] += 1
                        continue
                    updates.append((sqlite3.Binary(data), rowid))
                    stats["combined"] += 1
                    if z == s_min:
                        changed_low.add((x, row))
                if inserts:
                    db.executemany("INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?,?,?,?)", inserts)
                if updates:
                    db.executemany("UPDATE tiles SET tile_data=? WHERE rowid=?", updates)
                db.commit()
                batch.clear()

            for item in it:
                check_cancel()
                batch.append(item)
                done += 1
                if len(batch) >= 512:
                    flush()
                if tick.due():
                    print(f"  {done}/{total} tiles ({100.0 * done / max(total, 1):.1f}%)", flush=True)
            flush()
            print(f"  {stats['added']} added, {stats['combined']} combined, {stats['replaced']} replaced, "
                  f"{stats['kept']} kept as they were, {stats['same']} identical"
                  + (f", {stats['skipped']} not images (skipped)" if stats["skipped"] else ""))

            if lower and changed_low:
                print(f"Building zoomed-out levels z{lower[0]}..z{lower[-1]} for the new area")
                changed = changed_low
                tot = [0, 0, 0]
                for z in lower:
                    check_cancel()
                    parents = sorted({(x >> 1, r >> 1) for x, r in changed})
                    changed = set()
                    n_ins = n_set = 0
                    for i in range(0, len(parents), 256):
                        items = []
                        for px, pr in parents[i:i + 256]:
                            kids = {}
                            for dx in (0, 1):
                                for dy in (0, 1):
                                    c = _get(db, z + 1, 2 * px + dx, 2 * pr + dy)
                                    if c is not None:
                                        kids[(dx, dy)] = bytes(c[1])
                            cur = _get(db, z, px, pr)
                            items.append(((px, pr), kids, cur[0] if cur else None, bytes(cur[1]) if cur else None))
                        ins, upd = [], []
                        for (px, pr), rowid, (action, data) in pool_map(pool, _parent_job, items, batch=8):
                            if action == "insert":
                                ins.append((z, px, pr, sqlite3.Binary(data)))
                                changed.add((px, pr))
                            elif action == "set":
                                upd.append((sqlite3.Binary(data), rowid))
                                changed.add((px, pr))
                        if ins:
                            db.executemany("INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?,?,?,?)", ins)
                        if upd:
                            db.executemany("UPDATE tiles SET tile_data=? WHERE rowid=?", upd)
                        db.commit()
                        n_ins += len(ins)
                        n_set += len(upd)
                        lower_changes[0] += len(ins) + len(upd)
                    tot[0] += len(parents)
                    tot[1] += n_ins
                    tot[2] += n_set
                    if len(parents) > 64:
                        print(f"  z{z}: {len(parents)} tiles looked at, {n_ins} added, {n_set} updated", flush=True)
                    if not changed:
                        break
                print(f"  zoomed-out levels: {tot[0]} tiles looked at, {tot[1]} added, {tot[2]} updated")

        n_changed = stats["added"] + stats["combined"] + stats["replaced"] + lower_changes[0]
        if stats["skipped"] and not (stats["added"] + stats["combined"] + stats["replaced"] + stats["kept"] + stats["same"]):
            db.close()
            sys.exit("ERROR: none of the new tiles is a JPEG, PNG or WebP image; nothing was changed")
        if not n_changed:
            db.close()
            print("Nothing to change: every tile of the new area is already in the file as it would be.")
            return

        # metadata
        new_bounds = regions.union_bbox([t_bounds, s_bounds])
        zr = db.execute("SELECT MIN(zoom_level), MAX(zoom_level) FROM tiles").fetchone()
        _set_meta(db, "bounds", ",".join(f"{v:.8f}" for v in new_bounds))
        _set_meta(db, "minzoom", str(zr[0]))
        _set_meta(db, "maxzoom", str(zr[1]))
        db.commit()
        print("Checking the merged file")
        check = db.execute("PRAGMA quick_check").fetchone()[0]
        after = db.execute("SELECT COUNT(*) FROM tiles").fetchone()[0]
        db.close()
        if check != "ok":
            sys.exit(f"ERROR: the merged file failed SQLite's check ({check}); nothing was changed")
        print(f"  quick_check ok, {after} tiles ({after - before:+d}), zoom {zr[0]}-{zr[1]}")

        change = backups.Change("mbtiles", root, os.path.relpath(target, root),
                                f"Map tiles: added {', '.join(os.path.basename(s.rstrip('/')) for s in args.sources)} "
                                f"to {os.path.basename(target)}",
                                details={"sources": [os.path.basename(s.rstrip("/")) for s in args.sources],
                                         "prefer": args.prefer, "stats": stats, "bounds": list(s_bounds),
                                         "rows": source.scheme if src_kind != "raster" else None})
        change.put(os.path.relpath(target, root), out)
        change.install()
        print(f"Done in {fmt_time(time.time() - t0)}: {os.path.basename(target)} now covers "
              f"{', '.join(f'{v:.4f}' for v in new_bounds)}, {fmt_size(os.path.getsize(target))}.")
    finally:
        if not args.keep_work and not args.dry_run:
            shutil.rmtree(work, ignore_errors=True)
            try:
                os.rmdir(os.path.dirname(work))
            except OSError:
                pass


def _plan_raster(args, tz, t_bounds):
    ds = gdal.Open(args.sources[0])
    probe = gdal.Warp("", ds, format="VRT", dstSRS="EPSG:3857")
    native = mbtiles.native_zoom(abs(probe.GetGeoTransform()[1]))
    probe = None
    info = gdal.Info(ds, format="json").get("wgs84Extent", {}).get("coordinates", [[]])[0]
    if info:
        lons, lats = [c[0] for c in info], [c[1] for c in info]
        b = (min(lons), min(lats), max(lons), max(lats))
        print(f"  new area: about {', '.join(f'{v:.4f}' for v in b)}, cut at zoom {args.max_zoom or native}")
        if t_bounds:
            print(f"  {100 * regions.covered_fraction(b, [t_bounds]):.0f}% of it lies inside the existing area")
    print("Dry run: nothing changed (the raster would be cut into tiles first, then merged).")


if __name__ == "__main__":
    main()
