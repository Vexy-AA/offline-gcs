"""Cut a (big) DEM raster into Cesium quantized-mesh terrain tiles.

Output layout is what terrain/nginx.conf serves (and what cesium-terrain-builder
writes):  OUT/layer.json  and  OUT/{z}/{x}/{y}.terrain  (gzip-compressed).

Tiling scheme: geographic (EPSG:4326), TMS y axis, two tiles at level 0 --
the scheme Cesium's CesiumTerrainProvider expects for quantized-mesh.

Pipeline
  1. mosaic several inputs into a VRT; reproject to EPSG:4326 if needed
  2. build overviews in a work dir (the source file is never modified), so
     low zoom levels don't read the whole raster for every tile
  3. per tile: resample the DEM onto a regular grid whose outer rows/columns
     sit exactly on the tile edges, triangulate it with Delatin (error bound
     scaled to the zoom level), encode as quantized-mesh, gzip, write
  4. write layer.json with the exact "available" tile ranges
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

import numpy as np
from osgeo import gdal, osr
from pydelatin import Delatin

from . import qmesh
from .common import fmt_time, gdal_progress, pool_map

gdal.UseExceptions()

# Cesium: TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
#   WGS84, 65, numberOfXTilesAtLevel(0) = 2)  ~= 77067 m
LEVEL0_ERROR = qmesh.WGS84_A * 2.0 * math.pi * 0.25 / (65 * 2)

RESAMPLING = ("bilinear", "cubic", "cubicspline", "lanczos", "average", "near")


def level_error(z):
    """Geometric error Cesium assumes for a tile at level z (metres)."""
    return LEVEL0_ERROR / (1 << z)


def tile_error(z, max_zoom, quality, max_zoom_error=None, min_error=0.1):
    """Max vertical error (m) allowed when simplifying a tile at level z.

    Levels above the deepest use Cesium's own geometric-error estimate (times
    quality), exactly like cesium-terrain-builder. The deepest level is shown
    for every close-up view, so by default it gets 4x tighter tolerance.
    """
    if z == max_zoom:
        err = max_zoom_error if max_zoom_error is not None else quality * level_error(z) / 4.0
    else:
        err = quality * level_error(z)
    return max(err, min_error)


def tile_bounds(z, x, y):
    size = 180.0 / (1 << z)
    west = -180.0 + x * size
    south = -90.0 + y * size
    return west, south, west + size, south + size


def tile_range(z, bounds):
    """Inclusive (x0, y0, x1, y1) range of TMS tiles at level z touching bounds."""
    west, south, east, north = bounds
    size = 180.0 / (1 << z)
    nx, ny = 2 << z, 1 << z
    eps = 1e-9  # don't add a whole row of tiles for a bound that sits on a tile edge
    x0 = int(math.floor((west + 180.0) / size + eps))
    x1 = int(math.ceil((east + 180.0) / size - eps)) - 1
    y0 = int(math.floor((south + 90.0) / size + eps))
    y1 = int(math.ceil((north + 90.0) / size - eps)) - 1
    clamp = lambda val, hi: max(0, min(hi, val))
    return clamp(x0, nx - 1), clamp(y0, ny - 1), clamp(max(x1, x0), nx - 1), clamp(max(y1, y0), ny - 1)


def level_ranges(bounds, max_zoom):
    ranges = []
    for z in range(max_zoom + 1):
        if z == 0:
            ranges.append((0, 0, 1, 0))  # Cesium always needs both level-0 tiles
        else:
            ranges.append(tile_range(z, bounds))
    return ranges


def count_tiles(r):
    return (r[2] - r[0] + 1) * (r[3] - r[1] + 1)


# --------------------------------------------------------------------------
# Source preparation
# --------------------------------------------------------------------------

def is_wgs84_geographic(srs):
    wgs84 = osr.SpatialReference()
    wgs84.ImportFromEPSG(4326)
    return bool(srs.IsGeographic()) and bool(srs.IsSame(wgs84, [
        "IGNORE_DATA_AXIS_TO_SRS_AXIS_MAPPING=YES",
        "CRITERION=EQUIVALENT_EXCEPT_AXIS_ORDER_GEOGCRS",
    ]))


def _overview_factors(xsize, ysize, smallest=256):
    factors, f = [], 2
    while max(xsize, ysize) / f >= smallest:
        factors.append(f)
        f *= 2
    if not factors and max(xsize, ysize) > smallest:
        factors.append(2)
    return factors


def _fingerprint(paths, args):
    items = []
    for p in paths:
        st = os.stat(p)
        items.append([os.path.abspath(p), st.st_size, int(st.st_mtime)])
    return {"sources": items, "nodata": args.nodata, "resampling": args.resampling}


def prepare_source(args):
    """Return (path_to_sample_from, bounds_wgs84, pixel_size_deg)."""
    work = args.work_dir
    os.makedirs(work, exist_ok=True)
    stamp_path = os.path.join(work, "prepared.json")
    prepared = os.path.join(work, "dem_prepared.txt")
    fp = _fingerprint(args.sources, args)

    if os.path.exists(stamp_path) and os.path.exists(prepared):
        with open(stamp_path) as f:
            if json.load(f) == fp:
                with open(prepared) as f2:
                    path = f2.read().strip()
                if os.path.exists(path):
                    print(f"Re-using prepared source in {work}")
                    return _describe(path)
    # different source: start from an empty work dir (stale .ovr files would be reused by GDAL)
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)

    threads = str(args.workers)
    gdal.SetConfigOption("GDAL_NUM_THREADS", threads)

    # 1. single dataset (mosaic VRT if several inputs)
    srcs = args.sources
    first = gdal.Open(srcs[0])
    if first.GetSpatialRef() is None:
        sys.exit(f"ERROR: {srcs[0]} has no coordinate system; assign one with gdal_edit.py -a_srs")
    if len(srcs) > 1:
        ref = first.GetSpatialRef()
        for p in srcs[1:]:
            srs = gdal.Open(p).GetSpatialRef()
            if srs is None or not srs.IsSame(ref):
                sys.exit(f"ERROR: {p} has a different coordinate system than {srcs[0]}; "
                         "reproject the inputs to one CRS first (or run them separately)")
        base = os.path.join(work, "mosaic.vrt")
        print(f"Mosaicking {len(srcs)} inputs -> {base}")
        vrt_opts = {"srcNodata": args.nodata, "VRTNodata": args.nodata} if args.nodata is not None else {}
        gdal.BuildVRT(base, srcs, **vrt_opts).FlushCache()
    else:
        base = srcs[0]
    first = None

    ds = gdal.Open(base)
    band = ds.GetRasterBand(1)
    src_nodata = args.nodata if args.nodata is not None else band.GetNoDataValue()
    gt = ds.GetGeoTransform()
    rotated = gt[2] != 0 or gt[4] != 0 or gt[5] > 0

    # 2. geographic WGS84, north-up
    if not is_wgs84_geographic(ds.GetSpatialRef()) or rotated:
        out = os.path.join(work, "dem_4326.tif")
        print(f"Reprojecting to EPSG:4326 -> {out}  (one-time, can take a while for big files)")
        gdal.Warp(
            out, ds, dstSRS="EPSG:4326", resampleAlg=args.resampling if args.resampling != "average" else "bilinear",
            outputType=gdal.GDT_Float32, srcNodata=src_nodata, dstNodata=-32768.0,
            multithread=True, warpOptions=[f"NUM_THREADS={threads}"], warpMemoryLimit=512,
            creationOptions=["TILED=YES", "COMPRESS=DEFLATE", "PREDICTOR=3", "BIGTIFF=IF_SAFER",
                             f"NUM_THREADS={threads}"],
            callback=gdal_progress("reproject"),
        )
        ds = None
        sample_path = out
    else:
        # Wrap in a VRT so the overviews are written to the work dir, not next to the source
        sample_path = os.path.join(work, "dem.vrt")
        vrt_opts = {"srcNodata": src_nodata, "VRTNodata": src_nodata} if src_nodata is not None else {}
        gdal.BuildVRT(sample_path, [base], **vrt_opts).FlushCache()
        ds = None

    # 3. overviews
    ds = gdal.Open(sample_path)
    factors = _overview_factors(ds.RasterXSize, ds.RasterYSize)
    if factors and ds.GetRasterBand(1).GetOverviewCount() == 0:
        print(f"Building overviews {factors} (average)")
        gdal.SetConfigOption("COMPRESS_OVERVIEW", "DEFLATE")
        gdal.SetConfigOption("PREDICTOR_OVERVIEW", "3" if ds.GetRasterBand(1).DataType in (gdal.GDT_Float32, gdal.GDT_Float64) else "2")
        gdal.SetConfigOption("BIGTIFF_OVERVIEW", "IF_SAFER")
        ds.BuildOverviews("AVERAGE", factors, callback=gdal_progress("overviews"))
    ds = None

    with open(prepared, "w") as f:
        f.write(sample_path)
    with open(stamp_path, "w") as f:
        json.dump(fp, f)
    return _describe(sample_path)


def _describe(path):
    ds = gdal.Open(path)
    gt = ds.GetGeoTransform()
    west, north = gt[0], gt[3]
    east = west + ds.RasterXSize * gt[1]
    south = north + ds.RasterYSize * gt[5]
    res = min(abs(gt[1]), abs(gt[5]))
    return path, (max(west, -180.0), max(south, -90.0), min(east, 180.0), min(north, 90.0)), res


def auto_max_zoom(pixel_deg, grid):
    """Level whose sampling grid spacing is closest to the DEM resolution."""
    z = math.log2(180.0 / ((grid - 1) * pixel_deg))
    return int(max(0, min(20, round(z))))


# --------------------------------------------------------------------------
# Tile worker
# --------------------------------------------------------------------------

_W = {}


def _init_worker(path, opts):
    gdal.UseExceptions()
    gdal.SetCacheMax(opts["cache_mb"] * 1024 * 1024)
    _W["ds"] = gdal.Open(path)
    nd = _W["ds"].GetRasterBand(1).GetNoDataValue()
    _W["src_nodata"] = nd
    _W.update(opts)
    _W["made_dirs"] = set()


def sample_tile(ds, bounds, grid, resampling, fill):
    """DEM heights on a grid x grid lattice; first/last rows+cols lie on the tile edges."""
    west, south, east, north = bounds
    d = (east - west) / (grid - 1)
    mem = gdal.Warp(
        "", ds, format="MEM",
        outputBounds=(west - d / 2, south - d / 2, east + d / 2, north + d / 2),
        width=grid, height=grid, resampleAlg=resampling,
        outputType=gdal.GDT_Float32, dstNodata=float("nan"),
        errorThreshold=0, multithread=False,
    )
    arr = mem.GetRasterBand(1).ReadAsArray()
    mem = None
    bad = ~np.isfinite(arr)
    if bad.any():
        arr[bad] = fill
    return arr


_BOWL_CACHE = {}


def _bowl(bounds, grid):
    """Drop of the ellipsoid below the tile's centre tangent plane, per grid point.

    Cesium draws each triangle as a flat 3D chord, so a big, nearly flat tile
    meshed with only its corners would sag far below the surface (kilometres
    at zoom 0-6). Triangulating h + bowl instead of h makes Delatin add the
    vertices needed to follow the Earth's curvature within the error bound.
    The bowl depends only on latitude and tile size, so it is cached.
    """
    west, south, east, north = bounds
    key = (round(south, 9), round(north - south, 12), grid)
    bowl = _BOWL_CACHE.get(key)
    if bowl is None:
        lon = np.radians(np.linspace(west, east, grid) - (west + east) / 2)
        lat = np.radians(np.linspace(north, south, grid))  # row 0 = north
        lat0 = math.radians((south + north) / 2)
        lo, la = np.meshgrid(lon, lat)
        cos_angle = np.sin(la) * math.sin(lat0) + np.cos(la) * math.cos(lat0) * np.cos(lo)
        bowl = -qmesh.WGS84_A * (1.0 - np.clip(cos_angle, -1.0, 1.0))
        if len(_BOWL_CACHE) > 64:
            _BOWL_CACHE.clear()
        _BOWL_CACHE[key] = bowl
    return bowl


def build_tile(arr, bounds, max_error, normals):
    grid = arr.shape[0]
    tin = Delatin((arr + _bowl(bounds, grid)).astype(np.float32), max_error=max_error)
    verts = tin.vertices
    # pydelatin: x = column, y = rows counted from the bottom (i.e. y up = north)
    col = verts[:, 0].astype(np.int64)
    row_up = verts[:, 1].astype(np.int64)
    heights = arr[grid - 1 - row_up, col].astype(np.float64)
    u = np.rint(col * (qmesh.QMAX / (grid - 1))).astype(np.int64)
    v = np.rint(row_up * (qmesh.QMAX / (grid - 1))).astype(np.int64)
    return qmesh.encode(u, v, heights, tin.triangles, bounds, normals=normals)


def _work(task):
    z, x, y = task
    bounds = tile_bounds(z, x, y)
    arr = sample_tile(_W["ds"], bounds, _W["grid"], _W["resampling"], _W["fill"])
    err = tile_error(z, _W["max_zoom"], _W["quality"], _W["max_zoom_error"], _W["min_error"])
    data = gzip.compress(build_tile(arr, bounds, err, _W["normals"]), compresslevel=6, mtime=0)
    d = os.path.join(_W["out"], str(z), str(x))
    if d not in _W["made_dirs"]:
        os.makedirs(d, exist_ok=True)
        _W["made_dirs"].add(d)
    path = os.path.join(d, f"{y}.terrain")
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return z, len(data)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def _existing_output(out):
    if not os.path.isdir(out):
        return []
    return [n for n in os.listdir(out) if n == "layer.json" or n.isdigit()]


def write_layer_json(out, args, bounds, ranges, max_zoom):
    layer = {
        "tilejson": "2.1.0",
        "name": args.name,
        "description": "Generated by offline-gcs tools (gcs_tools.terrain)",
        "version": args.version,
        "format": "quantized-mesh-1.0",
        "attribution": args.attribution,
        "scheme": "tms",
        "tiles": ["{z}/{x}/{y}.terrain?v={version}"],
        "projection": "EPSG:4326",
        "bounds": [round(b, 9) for b in bounds],
        "minzoom": 0,
        "maxzoom": max_zoom,
        "available": [[{"startX": r[0], "startY": r[1], "endX": r[2], "endY": r[3]}] for r in ranges],
    }
    if not args.no_normals:
        layer["extensions"] = ["octvertexnormals"]
    path = os.path.join(out, "layer.json")
    with open(path + ".tmp", "w") as f:
        json.dump(layer, f, indent=2)
        f.write("\n")
    os.replace(path + ".tmp", path)


def build_parser(p=None):
    p = p or argparse.ArgumentParser(prog="terrain", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("sources", nargs="+", metavar="SRC", help="DEM raster(s): GeoTIFF, VRT, HGT, ... (any GDAL format, any CRS)")
    p.add_argument("out", metavar="OUT_DIR", help="output folder, e.g. data/terrain")
    p.add_argument("--max-zoom", type=int, help="deepest level (default: matched to the DEM resolution)")
    p.add_argument("--quality", type=float, default=1.0,
                   help="mesh error as a fraction of the level's geometric error; lower = more triangles "
                        "(default 1.0, same as cesium-terrain-builder)")
    p.add_argument("--max-zoom-error", type=float, default=None, metavar="METRES",
                   help="max error for the deepest level, which is what you see whenever you are zoomed in "
                        "close (default: a quarter of that level's geometric error, e.g. 9.4 m at z11, "
                        "4.7 m at z12, 2.4 m at z13)")
    p.add_argument("--min-error", type=float, default=0.1, metavar="METRES",
                   help="never simplify below this error (default 0.1 m)")
    p.add_argument("--grid", type=int, default=257, help="samples per tile edge (default 257 = 256 cells)")
    p.add_argument("--resampling", choices=RESAMPLING, default="bilinear", help="DEM resampling (default bilinear)")
    p.add_argument("--nodata", type=float, help="treat this source value as no-data (default: from the file)")
    p.add_argument("--fill", type=float, default=0.0, metavar="METRES",
                   help="height used where there is no data (default 0)")
    p.add_argument("--bounds", type=float, nargs=4, metavar=("W", "S", "E", "N"),
                   help="only generate tiles inside this lon/lat box")
    p.add_argument("--no-normals", action="store_true", help="don't write per-vertex normals (octvertexnormals)")
    p.add_argument("--workers", type=int, default=os.cpu_count() or 1, help="parallel processes (default: all CPUs)")
    p.add_argument("--resume", action="store_true", help="continue an interrupted run: keep existing tiles")
    p.add_argument("--clean", action="store_true", help="delete existing tiles + layer.json in OUT_DIR first")
    p.add_argument("--work-dir", help="scratch folder for reprojection/overviews (default: OUT_DIR/../.work/terrain)")
    p.add_argument("--keep-work", action="store_true", help="keep the work dir afterwards (speeds up re-runs)")
    p.add_argument("--name", default="terrain", help="tileset name in layer.json")
    p.add_argument("--attribution", default="", help="attribution text in layer.json")
    p.add_argument("--version", default=None,
                   help="layer.json version; it is appended to tile URLs so browsers re-fetch after a rebuild "
                        "(default: build timestamp)")
    return p


def main(argv=None, args=None):
    if args is None:
        args = build_parser().parse_args(argv)
    for s in args.sources:
        if not os.path.exists(s) and not s.startswith("/vsi"):
            sys.exit(f"ERROR: input not found: {s}")
    if args.grid < 3:
        sys.exit("ERROR: --grid must be >= 3")
    args.out = os.path.abspath(args.out)
    args.work_dir = os.path.abspath(args.work_dir or os.path.join(os.path.dirname(args.out), ".work", "terrain"))
    args.workers = max(1, args.workers)
    args.version = args.version or time.strftime("1.0.%Y%m%d%H%M%S")

    existing = _existing_output(args.out)
    if existing and not (args.resume or args.clean):
        sys.exit(f"ERROR: {args.out} already contains terrain ({', '.join(sorted(existing)[:5])}...).\n"
                 "       Use --clean to delete it first, or --resume to continue an interrupted run.")
    os.makedirs(args.out, exist_ok=True)
    if existing and args.clean:
        print(f"Removing existing terrain in {args.out}")
        for n in existing:
            p = os.path.join(args.out, n)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)

    t0 = time.time()
    path, bounds, res = prepare_source(args)
    if args.bounds:
        w, s, e, n = args.bounds
        bounds = (max(bounds[0], w), max(bounds[1], s), min(bounds[2], e), min(bounds[3], n))
        if bounds[0] >= bounds[2] or bounds[1] >= bounds[3]:
            sys.exit("ERROR: --bounds does not overlap the DEM")

    native = auto_max_zoom(res, args.grid)
    max_zoom = native if args.max_zoom is None else args.max_zoom
    ranges = level_ranges(bounds, max_zoom)
    total = sum(count_tiles(r) for r in ranges)

    cell_m = 180.0 / (1 << max_zoom) / (args.grid - 1) * 111320.0
    print(f"DEM: {', '.join(args.sources)}")
    print(f"  extent  W {bounds[0]:.5f}  S {bounds[1]:.5f}  E {bounds[2]:.5f}  N {bounds[3]:.5f}")
    print(f"  pixel   {res:.7f} deg (~{res * 111320:.1f} m)  -> native max zoom {native}")
    print(f"Levels 0..{max_zoom} (deepest level grid spacing ~{cell_m:.1f} m), {total} tiles, "
          f"{args.workers} workers -> {args.out}")
    for z, r in enumerate(ranges):
        err = tile_error(z, max_zoom, args.quality, args.max_zoom_error, args.min_error)
        print(f"  z{z:<2} x {r[0]}..{r[2]}  y {r[1]}..{r[3]}  ({count_tiles(r)} tiles, max error {err:.2f} m)")

    skipped = [0]

    def tasks():
        for z, r in enumerate(ranges):
            for x in range(r[0], r[2] + 1):
                for y in range(r[1], r[3] + 1):
                    if args.resume and os.path.exists(os.path.join(args.out, str(z), str(x), f"{y}.terrain")):
                        skipped[0] += 1
                        continue
                    yield (z, x, y)

    opts = {
        "grid": args.grid, "resampling": args.resampling, "fill": args.fill,
        "quality": args.quality, "min_error": args.min_error, "max_zoom": max_zoom,
        "max_zoom_error": args.max_zoom_error, "normals": not args.no_normals,
        "out": args.out, "cache_mb": 256,
    }
    done, nbytes = 0, 0
    last = t1 = time.time()
    ctx = mp.get_context("spawn")
    with ctx.Pool(args.workers, initializer=_init_worker, initargs=(path, opts)) as pool:
        for z, size in pool_map(pool, _work, tasks(), batch=8):
            done += 1
            nbytes += size
            now = time.time()
            if now - last >= 5:
                last = now
                rate = done / max(now - t1, 1e-6)
                seen = done + skipped[0]
                print(f"  {seen}/{total} tiles ({100.0 * seen / total:.1f}%)  z{z}  {rate:.0f} tiles/s  "
                      f"{nbytes / 2**20:.1f} MB  ETA {fmt_time((total - seen) / max(rate, 1e-6))}", flush=True)
    if skipped[0]:
        print(f"  kept {skipped[0]} existing tiles (--resume)")

    write_layer_json(args.out, args, bounds, ranges, max_zoom)
    if not args.keep_work:
        shutil.rmtree(args.work_dir, ignore_errors=True)
        try:
            os.rmdir(os.path.dirname(args.work_dir))  # remove .work if now empty
        except OSError:
            pass
    print(f"Done: {done} tiles written ({nbytes / 2**20:.1f} MB) in {fmt_time(time.time() - t0)}.")
    print(f"layer.json -> {os.path.join(args.out, 'layer.json')}")


if __name__ == "__main__":
    main()
