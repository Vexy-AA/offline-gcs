"""Add a new area to the existing Cesium terrain (data/terrain) without rebuilding the rest.

    ./gcs-tools add-terrain data/src/northBig.tif data/terrain
    ./gcs-tools add-terrain data/src/northBig.tif data/terrain --prefer new --dry-run

Only tiles that touch the new DEM are made again. Every other tile is left
byte-for-byte as it is, and layer.json ends up listing both areas.

The tiles that touch the new DEM also cover part of the existing area (along
the border, and the zoomed-out tiles that span both), so they need the old
heights too. The DEM the terrain was built from is usually gone, but:

  1. the elevation pieces in data/elevation were cut from it: they are read as
     one mosaic and give the old heights exactly (--elevation-dir);
  2. where no piece covers a spot inside the old terrain area, the old terrain
     tile itself is decoded and its surface used (accurate to the mesh error).

Where both have heights, --prefer decides: "existing" (default) keeps the old
heights and only fills in where there were none; "new" uses the new DEM wherever
it has data. A tile whose heights would not change is not rewritten.

New tiles are written to data/.work first. Only when all of them are done are
they swapped in, with the replaced ones (and the old layer.json) kept as a
restore point: ./gcs-tools backups restore <id>.
"""

import argparse
import gzip
import json
import math
import multiprocessing as mp
import os
import shutil
import sys
import time
import types

import numpy as np
from osgeo import gdal

from . import backups, qmesh, regions, terrain
from .common import fmt_size, fmt_time, gdal_progress, pool_map

gdal.UseExceptions()


# --------------------------------------------------------------------------
# Existing terrain
# --------------------------------------------------------------------------

def load_layer(tdir):
    path = os.path.join(tdir, "layer.json")
    if not os.path.exists(path):
        sys.exit(f"ERROR: {path} not found. add-terrain adds to existing terrain; to make new terrain "
                 "use the terrain command (Build data > Terrain).")
    with open(path) as f:
        layer = json.load(f)
    fmt = layer.get("format", "")
    if not fmt.startswith("quantized-mesh-1."):
        sys.exit(f"ERROR: the existing terrain is {fmt or 'of unknown format'}; only quantized-mesh terrain can be added to")
    if layer.get("projection", "EPSG:4326") != "EPSG:4326":
        sys.exit(f"ERROR: the existing terrain uses {layer.get('projection')}; only EPSG:4326 is supported")
    if layer.get("scheme", "tms") != "tms":
        sys.exit(f"ERROR: the existing terrain uses the {layer.get('scheme')} scheme; only tms is supported")
    if layer.get("metadataAvailability"):
        sys.exit("ERROR: the existing terrain stores tile availability inside the tiles (metadataAvailability); "
                 "adding to it is not supported")
    if not layer.get("available"):
        sys.exit("ERROR: layer.json lists no available tiles")
    return layer


def avail_rects(layer):
    return {z: [regions.range_to_rect(r) for r in ranges] for z, ranges in enumerate(layer["available"])}


def contains(rects, x, y):
    return any(r[0] <= x < r[2] and r[1] <= y < r[3] for r in rects)


def layer_bounds(layer, rects):
    b = layer.get("bounds")
    if b and len(b) == 4 and b != [-180, -90, 180, 90]:
        return tuple(b)
    z = max(rects)
    boxes = []
    for r in rects[z]:
        w, s, _, _ = terrain.tile_bounds(z, r[0], r[1])
        _, _, e, n = terrain.tile_bounds(z, r[2] - 1, r[3] - 1)
        boxes.append((w, s, e, n))
    return regions.union_bbox(boxes)


# --------------------------------------------------------------------------
# Old heights from the elevation pieces
# --------------------------------------------------------------------------

def added_pieces(root):
    """Names of elevation pieces that add-elevation added (from its restore points): they hold
    the new area's heights, not the old ones, so they don't count as existing data here."""
    out = set()
    for m in backups.list_points(os.path.join(root, "backups"), with_size=False):
        if m.get("kind") != "elevation":
            continue
        try:
            with open(os.path.join(m["dir"], backups.MANIFEST)) as f:
                entries = json.load(f).get("entries", [])
        except (OSError, ValueError):
            continue
        out.update(os.path.basename(e["path"]) for e in entries if not e.get("existed"))
    return out


def piece_names(edir, root):
    if not edir or not os.path.isdir(edir):
        return [], []
    names = sorted(n for n in os.listdir(edir) if n.lower().endswith(".tif"))
    skip = added_pieces(root)
    return [n for n in names if n not in skip], [n for n in names if n in skip]


def prepare_pieces(edir, names, work, workers):
    """Mosaic of the elevation pieces as one Float32 dataset with overviews.
    Returns (path or None, [piece boxes as (w, s, e, n)])."""
    if not names:
        return None, []
    os.makedirs(work, exist_ok=True)
    wrappers, boxes = [], []
    for n in names:
        p = os.path.join(edir, n)
        try:
            ds = gdal.Open(p)
        except RuntimeError as e:
            print(f"  skipping {n}: {e}")
            continue
        srs = ds.GetSpatialRef()
        if srs is None or not terrain.is_wgs84_geographic(srs):
            print(f"  skipping {n}: not in EPSG:4326 (the elevation server expects lat/lon pieces)")
            continue
        gt = ds.GetGeoTransform()
        w, n_ = gt[0], gt[3]
        e, s = w + ds.RasterXSize * gt[1], n_ + ds.RasterYSize * gt[5]
        boxes.append((w, s, e, n_))
        nodata = ds.GetRasterBand(1).GetNoDataValue()
        out = os.path.join(work, f"piece{len(wrappers):05d}.vrt")
        gdal.Translate(out, ds, format="VRT", outputType=gdal.GDT_Float32,
                       noData=nodata if nodata is not None else -32768).FlushCache()
        wrappers.append(out)
        ds = None
    if not wrappers:
        return None, []
    vrt = os.path.join(work, "pieces.vrt")
    gdal.BuildVRT(vrt, wrappers, resolution="highest", resampleAlg="bilinear", VRTNodata=-32768).FlushCache()
    ds = gdal.Open(vrt)
    factors = terrain._overview_factors(ds.RasterXSize, ds.RasterYSize)
    if factors:
        print(f"  overviews of the pieces mosaic {factors}")
        gdal.SetConfigOption("GDAL_NUM_THREADS", str(workers))
        gdal.SetConfigOption("COMPRESS_OVERVIEW", "DEFLATE")
        gdal.SetConfigOption("PREDICTOR_OVERVIEW", "3")
        gdal.SetConfigOption("BIGTIFF_OVERVIEW", "IF_SAFER")
        ds.BuildOverviews("AVERAGE", factors, callback=gdal_progress("overviews"))
    ds = None
    return vrt, boxes


def probe_dem(sources):
    """Cheap (bounds, pixel size) of the new DEM in EPSG:4326, without writing anything."""
    base = sources[0]
    if len(sources) > 1:
        base = "/vsimem/probe_mosaic.vrt"
        gdal.BuildVRT(base, sources).FlushCache()
    ds = gdal.Open(base)
    if ds.GetSpatialRef() is None:
        sys.exit(f"ERROR: {sources[0]} has no coordinate system")
    if not terrain.is_wgs84_geographic(ds.GetSpatialRef()):
        ds = gdal.Warp("", ds, format="VRT", dstSRS="EPSG:4326")
    gt = ds.GetGeoTransform()
    w, n = gt[0], gt[3]
    e, s = w + ds.RasterXSize * gt[1], n + ds.RasterYSize * gt[5]
    res = min(abs(gt[1]), abs(gt[5]))
    return (max(w, -180.0), max(s, -90.0), min(e, 180.0), min(n, 90.0)), res


# --------------------------------------------------------------------------
# Tile worker
# --------------------------------------------------------------------------

_W = {}


def _init(opts):
    gdal.UseExceptions()
    gdal.SetCacheMax(opts["cache_mb"] * 1024 * 1024)
    _W.update(opts)
    _W["new"] = gdal.Open(opts["new_path"])
    _W["old"] = gdal.Open(opts["old_path"]) if opts["old_path"] else None
    _W["made"] = set()


def sample(ds, bounds, grid, resampling):
    """Heights on the tile lattice, NaN where the dataset has no data."""
    west, south, east, north = bounds
    d = (east - west) / (grid - 1)
    mem = gdal.Warp("", ds, format="MEM",
                    outputBounds=(west - d / 2, south - d / 2, east + d / 2, north + d / 2),
                    width=grid, height=grid, resampleAlg=resampling,
                    outputType=gdal.GDT_Float32, dstNodata=float("nan"),
                    errorThreshold=0, multithread=False)
    arr = mem.GetRasterBand(1).ReadAsArray().astype(np.float64)
    mem = None
    return arr


def lattice(bounds, grid):
    west, south, east, north = bounds
    lon = np.linspace(west, east, grid)
    lat = np.linspace(north, south, grid)  # row 0 = north
    return lon, lat


def box_mask(lon, lat, boxes):
    m = np.zeros((lat.size, lon.size), dtype=bool)
    for w, s, e, n in boxes:
        cols = (lon >= w) & (lon <= e)
        rows = (lat >= s) & (lat <= n)
        if cols.any() and rows.any():
            m |= rows[:, None] & cols[None, :]
    return m


def rasterize(t, u0, v0, u1, v1, grid):
    """Heights of a decoded quantized-mesh tile on a grid x grid lattice over the
    window (u0..u1, v0..v1) of quantized coordinates (row 0 = north)."""
    cu = (t["u"].astype(np.float64) - u0) / (u1 - u0) * (grid - 1)
    rv = (v1 - t["v"].astype(np.float64)) / (v1 - v0) * (grid - 1)
    h = t["height"]
    tri = t["triangles"]
    out = np.full((grid, grid), np.nan)
    if tri.size == 0:
        return out
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    cmin = np.minimum(np.minimum(cu[a], cu[b]), cu[c])
    cmax = np.maximum(np.maximum(cu[a], cu[b]), cu[c])
    rmin = np.minimum(np.minimum(rv[a], rv[b]), rv[c])
    rmax = np.maximum(np.maximum(rv[a], rv[b]), rv[c])
    sel = np.nonzero((cmax >= -1e-6) & (cmin <= grid - 1 + 1e-6) & (rmax >= -1e-6) & (rmin <= grid - 1 + 1e-6))[0]
    eps = 1e-7
    for k in sel:
        j0, j1 = max(0, math.ceil(cmin[k] - 1e-6)), min(grid - 1, math.floor(cmax[k] + 1e-6))
        i0, i1 = max(0, math.ceil(rmin[k] - 1e-6)), min(grid - 1, math.floor(rmax[k] + 1e-6))
        if j0 > j1 or i0 > i1:
            continue
        xa, ya, xb, yb, xc, yc = cu[a[k]], rv[a[k]], cu[b[k]], rv[b[k]], cu[c[k]], rv[c[k]]
        det = (yb - yc) * (xa - xc) + (xc - xb) * (ya - yc)
        if det == 0:
            continue
        jj, ii = np.meshgrid(np.arange(j0, j1 + 1, dtype=np.float64), np.arange(i0, i1 + 1, dtype=np.float64))
        l1 = ((yb - yc) * (jj - xc) + (xc - xb) * (ii - yc)) / det
        l2 = ((yc - ya) * (jj - xc) + (xa - xc) * (ii - yc)) / det
        l3 = 1.0 - l1 - l2
        inside = (l1 >= -eps) & (l2 >= -eps) & (l3 >= -eps)
        if inside.any():
            vals = l1 * h[a[k]] + l2 * h[b[k]] + l3 * h[c[k]]
            out[ii[inside].astype(int), jj[inside].astype(int)] = vals[inside]
    return out


def old_tile_heights(z, x, y, grid):
    """Old terrain surface over tile z/x/y, from that tile or its deepest existing ancestor."""
    rects = _W["old_rects"]
    for zz in range(min(z, _W["old_max"]), -1, -1):
        sh = z - zz
        ax, ay = x >> sh, y >> sh
        if not contains(rects.get(zz, []), ax, ay):
            continue
        path = os.path.join(_W["live"], str(zz), str(ax), f"{ay}.terrain")
        try:
            with open(path, "rb") as f:
                raw = f.read()
            t = qmesh.decode(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)
        except (OSError, ValueError, EOFError):
            continue
        n = 1 << sh
        fx, fy = x - (ax << sh), y - (ay << sh)
        q = qmesh.QMAX
        # heights are stored in 32767 steps between the tile's min and max: a vertex at
        # the fill height comes back within half a step of it
        step = (t["max_height"] - t["min_height"]) / q
        return rasterize(t, fx / n * q, fy / n * q, (fx + 1) / n * q, (fy + 1) / n * q, grid), step
    return None, 0.0


def _work(task):
    """Make one tile from three layers of heights:

      O  what the existing terrain shows: the elevation pieces inside the old terrain
         area, or (where no piece covers) the old terrain tiles themselves
      N  the new DEM
      P  elevation pieces outside the old terrain area (fills gaps only)

    prefer existing: O, else N, else P, else fill.  prefer new: N, else O, else P, else fill.
    An existing tile is rewritten only if N changes something in it."""
    z, x, y = task
    grid = _W["grid"]
    bounds = terrain.tile_bounds(z, x, y)
    new = sample(_W["new"], bounds, grid, _W["resampling"])
    pieces = (sample(_W["old"], bounds, grid, _W["resampling"]) if _W["old"] is not None
              else np.full((grid, grid), np.nan))
    existed = contains(_W["old_rects"].get(z, []), x, y)

    lon, lat = lattice(bounds, grid)
    inside = box_mask(lon, lat, [_W["old_bounds"]])
    old = np.where(inside, pieces, np.nan)
    other = np.where(inside, np.nan, pieces)
    fallback = inside & ~box_mask(lon, lat, _W["piece_boxes"])
    used_tiles = 0
    if fallback.any():
        heights, step = old_tile_heights(z, x, y, grid)
        if heights is not None:
            ok = fallback & np.isfinite(heights)
            if _W["prefer"] == "existing":
                # the old terrain used the fill height where its DEM had no data: treat that as empty
                ok &= np.abs(heights - _W["fill"]) > step + 1e-3
            old[ok] = heights[ok]
            used_tiles = int(ok.sum())

    vn, vo = np.isfinite(new), np.isfinite(old)
    if _W["prefer"] == "existing":
        contrib = vn & ~vo
        merged = np.where(vo, old, new)
    else:
        contrib = vn
        merged = np.where(vn, new, old)
    if existed and not contrib.any():
        return z, x, y, "unchanged", 0, used_tiles
    merged = np.where(np.isfinite(merged), merged, other)
    merged[~np.isfinite(merged)] = _W["fill"]

    deepest = z in (_W["new_max"], _W["old_max"])
    err = terrain.tile_error(z, z if deepest else z + 1, _W["quality"], _W["max_zoom_error"], _W["min_error"])
    data = gzip.compress(terrain.build_tile(merged, bounds, err, _W["normals"]), compresslevel=6, mtime=0)
    d = os.path.join(_W["stage"], str(z), str(x))
    if d not in _W["made"]:
        os.makedirs(d, exist_ok=True)
        _W["made"].add(d)
    with open(os.path.join(d, f"{y}.terrain"), "wb") as f:
        f.write(data)
    return z, x, y, "replaced" if existed else "added", len(data), used_tiles


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def plan_levels(new_bounds, new_max, old_rects, old_max):
    """{z: [rects of tiles to make]} for every level that has some."""
    out = {}
    for z in range(max(new_max, old_max) + 1):
        if z == 0:
            nb = (0, 0, 2, 1)
        else:
            x0, y0, x1, y1 = terrain.tile_range(z, new_bounds)
            nb = (x0, y0, x1 + 1, y1 + 1)
        if z <= new_max:
            rects = [nb]
        else:
            # deeper than the new DEM: only the old tiles it reaches into (their outer part was empty)
            rects = [r for r in (regions.intersect(nb, o) for o in old_rects.get(z, [])) if r]
        if rects:
            out[z] = rects
    return out


def build_parser(p=None):
    p = p or argparse.ArgumentParser(prog="add-terrain", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("sources", nargs="+", metavar="DEM", help="DEM raster(s) of the new area (any GDAL format and CRS)")
    p.add_argument("out", metavar="TERRAIN_DIR", help="existing terrain folder, e.g. data/terrain")
    p.add_argument("--prefer", choices=["existing", "new"], default="existing",
                   help="where both have heights: keep the existing ones (default) or use the new DEM")
    p.add_argument("--elevation-dir", default=None,
                   help="elevation pieces holding the old heights (default: elevation next to TERRAIN_DIR; "
                        "'none' to use only the old terrain tiles)")
    p.add_argument("--max-zoom", type=int, help="deepest level for the new area (default: matched to the new DEM)")
    p.add_argument("--quality", type=float, default=1.0, help="mesh error factor, as for terrain (default 1.0)")
    p.add_argument("--max-zoom-error", type=float, default=None, metavar="METRES",
                   help="max error at the deepest level (default: a quarter of that level's geometric error)")
    p.add_argument("--min-error", type=float, default=0.1, metavar="METRES", help="never simplify below this (default 0.1)")
    p.add_argument("--grid", type=int, default=257, help="samples per tile edge (default 257)")
    p.add_argument("--resampling", choices=terrain.RESAMPLING, default="bilinear", help="DEM resampling (default bilinear)")
    p.add_argument("--nodata", type=float, help="treat this value of the new DEM as no-data (default: from the file)")
    p.add_argument("--fill", type=float, default=0.0, metavar="METRES",
                   help="height where neither has data (default 0, as the terrain command)")
    p.add_argument("--workers", type=int, default=os.cpu_count() or 1, help="parallel processes (default: all CPUs)")
    p.add_argument("--version", default=None, help="layer.json version (default: timestamp)")
    p.add_argument("--dry-run", action="store_true", help="only report what would change")
    p.add_argument("--keep-work", action="store_true", help=argparse.SUPPRESS)
    return p


def main(argv=None, args=None):
    if args is None:
        args = build_parser().parse_args(argv)
    for s in args.sources:
        if not os.path.exists(s) and not s.startswith("/vsi"):
            sys.exit(f"ERROR: input not found: {s}")
    tdir = os.path.abspath(args.out)
    root = backups.root_of(tdir)
    layer = load_layer(tdir)
    old_rects = avail_rects(layer)
    old_max = len(layer["available"]) - 1
    old_bounds = layer_bounds(layer, old_rects)
    normals = "octvertexnormals" in (layer.get("extensions") or [])
    edir = args.elevation_dir
    if edir is None:
        edir = os.path.join(root, "elevation")
    elif edir.lower() == "none":
        edir = None
    args.workers = max(1, args.workers)
    t0 = time.time()

    new_bounds, new_res = probe_dem(args.sources)
    native = terrain.auto_max_zoom(new_res, args.grid)
    new_max = native if args.max_zoom is None else args.max_zoom
    levels = plan_levels(new_bounds, new_max, old_rects, old_max)
    total = sum(regions.count_tiles(r) for r in levels.values())
    existing = 0
    for z, rects in levels.items():
        for r in rects:
            for o in old_rects.get(z, []):
                i = regions.intersect(r, o)
                if i:
                    existing += regions.count_tiles([i])

    print(f"Existing terrain: {tdir}, levels 0-{old_max}, area {', '.join(f'{v:.4f}' for v in old_bounds)}"
          f"{', with normals' if normals else ''}")
    print(f"New DEM: {', '.join(args.sources)}")
    print(f"  area {', '.join(f'{v:.4f}' for v in new_bounds)}, pixel {new_res:.7f} deg (~{new_res * 111320:.1f} m) "
          f"-> levels 0-{new_max}")
    frac = regions.covered_fraction(new_bounds, [old_bounds])
    print(f"  {100 * frac:.0f}% of the new area lies inside the existing terrain area")
    print(f"Overlap rule: {'existing heights win' if args.prefer == 'existing' else 'new heights win'}")
    print(f"Tiles to make: {total} ({total - existing} new, up to {existing} existing ones remade if their heights change)")
    for z, rects in levels.items():
        n = regions.count_tiles(rects)
        print(f"  z{z:<2} {n:>7} tiles  " + "  ".join(f"x {r[0]}..{r[2] - 1} y {r[1]}..{r[3] - 1}" for r in rects))
    pieces, skipped = piece_names(edir, root)
    if skipped:
        print(f"  ignoring {len(skipped)} elevation pieces that add-elevation added (new data, not old)")
    if pieces:
        print(f"Old heights: {len(pieces)} elevation pieces in {edir}, then the old terrain tiles where no piece covers")
    else:
        print("Old heights: no elevation pieces found, the old terrain tiles are decoded instead (accurate to their mesh error)")

    sample_sizes = []
    deepest = os.path.join(tdir, str(old_max))
    if os.path.isdir(deepest):
        for xd in os.listdir(deepest)[:20]:
            p = os.path.join(deepest, xd)
            if os.path.isdir(p):
                for f in os.listdir(p)[:10]:
                    sample_sizes.append(os.path.getsize(os.path.join(p, f)))
    avg = (sum(sample_sizes) / len(sample_sizes)) if sample_sizes else 30000
    need = int(total * avg * 1.5) + sum(os.path.getsize(s) for s in args.sources if os.path.isfile(s)) * 2 + 64 * 2**20
    free = shutil.disk_usage(root).free
    print(f"Disk: needs about {fmt_size(need)} in {os.path.join(root, '.work')}, {fmt_size(free)} free")
    if args.dry_run:
        print("Dry run: nothing changed.")
        return
    if free < need:
        sys.exit(f"ERROR: not enough free disk space ({fmt_size(free)} free, about {fmt_size(need)} needed)")

    work = os.path.join(root, ".work", "add-terrain")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    try:
        print("Preparing the new DEM")
        pa = types.SimpleNamespace(sources=args.sources, nodata=args.nodata, resampling=args.resampling,
                                   workers=args.workers, work_dir=os.path.join(work, "new"))
        new_path, _, _ = terrain.prepare_source(pa)
        print("Preparing the old heights")
        old_path, piece_boxes = prepare_pieces(edir, pieces, os.path.join(work, "old"), args.workers)
        if old_path:
            print(f"  {len(piece_boxes)} pieces, together {', '.join(f'{v:.4f}' for v in regions.union_bbox(piece_boxes))}")
            gap = 1.0 - regions.covered_fraction(old_bounds, piece_boxes)
            if gap > 0.001:
                print(f"  {100 * gap:.1f}% of the old terrain area has no piece: the old tiles are used there")

        stage = os.path.join(work, "tiles")
        opts = {
            "new_path": new_path, "old_path": old_path, "piece_boxes": piece_boxes, "old_bounds": old_bounds,
            "old_rects": old_rects, "old_max": old_max, "new_max": new_max, "live": tdir, "stage": stage,
            "grid": args.grid, "resampling": args.resampling, "fill": args.fill, "prefer": args.prefer,
            "quality": args.quality, "max_zoom_error": args.max_zoom_error, "min_error": args.min_error,
            "normals": normals, "cache_mb": 256,
        }

        def tasks():
            for z, rects in levels.items():
                for x, y in regions.tiles_in(rects):
                    yield z, x, y

        counts = {"added": 0, "replaced": 0, "unchanged": 0}
        made, nbytes, from_tiles = [], 0, 0
        done, last = 0, time.time()
        t1 = last
        print(f"Making {total} tiles with {args.workers} workers")
        ctx = mp.get_context("spawn")
        with ctx.Pool(args.workers, initializer=_init, initargs=(opts,)) as pool:
            for z, x, y, what, size, used in pool_map(pool, _work, tasks(), batch=4):
                done += 1
                counts[what] += 1
                nbytes += size
                from_tiles += used
                if what != "unchanged":
                    made.append((z, x, y))
                now = time.time()
                if now - last >= 5:
                    last = now
                    rate = done / max(now - t1, 1e-6)
                    print(f"  {done}/{total} tiles ({100.0 * done / total:.1f}%)  z{z}  {rate:.1f} tiles/s  "
                          f"ETA {fmt_time((total - done) / max(rate, 1e-6))}", flush=True)
        print(f"  {counts['added']} new tiles, {counts['replaced']} existing tiles remade, "
              f"{counts['unchanged']} existing tiles unchanged ({nbytes / 2**20:.1f} MB)")
        if from_tiles:
            print(f"  old heights for {from_tiles} samples came from decoding the old terrain tiles")
        if not made:
            print("Nothing to change: the new DEM adds no heights the terrain doesn't already have.")
            return

        # layer.json: both areas
        new_layer = dict(layer)
        levels_n = max(old_max, max(levels)) + 1
        avail = []
        for z in range(levels_n):
            rects = regions.merge_rects(old_rects.get(z, []) + levels.get(z, []))
            avail.append([regions.rect_to_range(r) for r in sorted(rects, key=lambda r: (r[1], r[0]))])
        new_layer["available"] = avail
        new_layer["maxzoom"] = levels_n - 1
        new_layer["bounds"] = [round(v, 9) for v in regions.union_bbox([old_bounds, new_bounds])]
        new_layer["version"] = args.version or time.strftime("1.0.%Y%m%d%H%M%S")
        tiles_tmpl = new_layer.get("tiles") or ["{z}/{x}/{y}.terrain?v={version}"]
        if not any("{version}" in t for t in tiles_tmpl):
            tiles_tmpl = [t + ("&" if "?" in t else "?") + "v={version}" for t in tiles_tmpl]
            print("  added ?v={version} to the tile URL so browsers fetch the changed tiles")
        new_layer["tiles"] = tiles_tmpl
        staged_layer = os.path.join(work, "layer.json")
        with open(staged_layer, "w") as f:
            json.dump(new_layer, f, indent=2)
            f.write("\n")

        rel = os.path.relpath(tdir, root)
        change = backups.Change("terrain", root, rel,
                                f"Terrain: added {', '.join(os.path.basename(s) for s in args.sources)}",
                                details={"sources": [os.path.basename(s) for s in args.sources], "prefer": args.prefer,
                                         "bounds": list(new_bounds), "levels": f"0-{levels_n - 1}", **counts})
        for z, x, y in made:
            change.put(os.path.join(rel, str(z), str(x), f"{y}.terrain"),
                       os.path.join(stage, str(z), str(x), f"{y}.terrain"))
        change.put(os.path.join(rel, "layer.json"), staged_layer)
        print("Installing")
        change.install()
        print(f"Done in {fmt_time(time.time() - t0)}. Terrain now covers "
              f"{', '.join(f'{v:.4f}' for v in new_layer['bounds'])}, levels 0-{levels_n - 1}. "
              "Hard-refresh the browser.")
    finally:
        if not args.keep_work:
            shutil.rmtree(work, ignore_errors=True)
            try:
                os.rmdir(os.path.dirname(work))
            except OSError:
                pass


if __name__ == "__main__":
    main()
