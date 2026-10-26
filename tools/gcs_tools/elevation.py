"""Split a big DEM into pieces for the open-elevation server (data/elevation).

This is a thin wrapper around open-elevation's own create-tiles.sh (in the
open-elevation submodule), so the pieces are exactly what that project expects.
It adds: any GDAL-readable input (HGT, VRT, ...), the source file is left
untouched and outside data/elevation, an automatic piece count, and removal of
the stale summary.json so the server re-indexes on its next start.
"""

import argparse
import math
import os
import re
import subprocess
import sys

from osgeo import gdal

from .terrain import is_wgs84_geographic

gdal.UseExceptions()

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT_CANDIDATES = [
    os.environ.get("OPEN_ELEVATION_TILES_SCRIPT", ""),
    "/opt/open-elevation/create-tiles.sh",
    os.path.join(HERE, "..", "..", "open-elevation", "create-tiles.sh"),
]


def find_script():
    for path in SCRIPT_CANDIDATES:
        if path and os.path.isfile(path):
            return os.path.abspath(path)
    sys.exit("ERROR: open-elevation/create-tiles.sh not found. Run 'git submodule update --init' "
             "or set OPEN_ELEVATION_TILES_SCRIPT.")


def split(src, out_dir, xtiles, ytiles, piece_px, script, replace=False):
    ds = gdal.Open(src)
    if ds.GetSpatialRef() is None:
        sys.exit(f"ERROR: {src} has no coordinate system")
    geographic = is_wgs84_geographic(ds.GetSpatialRef())
    if not geographic:
        probe = gdal.Warp("", ds, format="VRT", dstSRS="EPSG:4326")
        xs, ys = probe.RasterXSize, probe.RasterYSize
        probe = None
    else:
        xs, ys = ds.RasterXSize, ds.RasterYSize
    ds = None
    xt = xtiles or max(1, math.ceil(xs / piece_px))
    yt = ytiles or max(1, math.ceil(ys / piece_px))
    stem = os.path.splitext(os.path.basename(src))[0]
    link = os.path.join(out_dir, f"{stem}.tif")

    if os.path.abspath(src) == os.path.abspath(link) or os.path.exists(link):
        sys.exit(f"ERROR: {link} already exists in the elevation folder. Keep the big source file "
                 "outside it (e.g. data/src/) - the server would index it too.")
    piece = re.compile(rf"^{re.escape(stem)}_\d+_\d+\.tif$")
    clash = sorted(f for f in os.listdir(out_dir) if piece.match(f))
    if clash and not replace:
        sys.exit(f"ERROR: {out_dir} already has pieces of '{stem}' ({clash[0]}, ...). "
                 "Delete them first, or use --replace.")
    for f in clash:
        os.remove(os.path.join(out_dir, f))
    if clash:
        print(f"  removed {len(clash)} old pieces of '{stem}'")

    print(f"{src}: {xs} x {ys} px -> {xt} x {yt} pieces (~{math.ceil(xs / xt)} x {math.ceil(ys / yt)} px) in {out_dir}")
    # create-tiles.sh writes "<raster without .tif>_<x>_<y>.tif" next to the raster it is given,
    # so hand it a small VRT (any input format works) placed in the output folder.
    if geographic:
        gdal.Translate(link, src, format="VRT").FlushCache()
    else:
        # open-elevation indexes the pieces by their corner coordinates as lat/lon,
        # so they must be in EPSG:4326.
        print("  source is not in EPSG:4326 -> reprojecting the pieces (bilinear)")
        gdal.Warp(link, src, format="VRT", dstSRS="EPSG:4326", resampleAlg="bilinear").FlushCache()
    try:
        subprocess.run(["bash", script, os.path.basename(link), str(xt), str(yt)], cwd=out_dir, check=True)
    finally:
        os.remove(link)
    made = sorted(f for f in os.listdir(out_dir) if piece.match(f))
    print(f"  wrote {len(made)} pieces ({made[0]} ... {made[-1]})")


def build_parser(p=None):
    p = p or argparse.ArgumentParser(prog="elevation", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("sources", nargs="+", metavar="SRC", help="DEM raster(s); each one is split separately")
    p.add_argument("--out", help="elevation folder (default: data/elevation, or ./elevation when run inside data/)")
    p.add_argument("--tiles", type=int, nargs=2, metavar=("X", "Y"),
                   help="number of pieces across and down (default: pieces of about --piece-size px)")
    p.add_argument("--replace", action="store_true", help="delete existing pieces of the same name first")
    p.add_argument("--piece-size", type=int, default=2000,
                   help="target piece size in pixels when --tiles is not given (default 2000)")
    return p


def main(argv=None, args=None):
    if args is None:
        args = build_parser().parse_args(argv)
    script = find_script()
    out = args.out
    if out is None:
        out = next((d for d in ("data/elevation", "elevation") if os.path.isdir(d)), None)
        if out is None:
            sys.exit("ERROR: no data/elevation folder here; pass --out")
    out_dir = os.path.abspath(out)
    os.makedirs(out_dir, exist_ok=True)
    for src in args.sources:
        if not os.path.exists(src):
            sys.exit(f"ERROR: input not found: {src}")
    for src in args.sources:
        xt, yt = args.tiles if args.tiles else (None, None)
        split(os.path.abspath(src), out_dir, xt, yt, args.piece_size, script, args.replace)
    summary = os.path.join(out_dir, "summary.json")
    if os.path.exists(summary):
        os.remove(summary)
        print("Removed summary.json so the server re-indexes the folder.")
    print("Now restart the server: docker compose restart elevation")


if __name__ == "__main__":
    main()
