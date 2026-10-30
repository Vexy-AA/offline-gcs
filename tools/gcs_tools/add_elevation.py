"""Add a new area to the elevation pieces (data/elevation) without changing the existing heights.

    ./gcs-tools add-elevation data/src/northBig.tif
    ./gcs-tools add-elevation data/src/northBig.tif --prefer new --dry-run
    docker compose restart elevation     (the tools page does this for you)

open-elevation answers a point from the piece whose box contains it. When two
pieces overlap it takes whichever the folder listing returns first, so simply
dropping overlapping pieces of a new DEM next to the old ones gives answers
from either file at random. This command keeps pieces from overlapping:

  --prefer existing (default)
      New pieces are cut only from the part of the new DEM that no existing
      piece covers (split into rectangles as needed). Existing pieces are not
      touched, except (--fill-holes, on by default) that their no-data pixels
      inside the new DEM get the new heights: a valid existing height is never
      changed.
  --prefer new
      The new DEM is cut whole. Existing pieces under it are removed, and pieces
      that are only partly under it are cropped (pixel copies, no resampling)
      to the part outside it. Where the new DEM has no data, the old heights
      are copied into the new pieces, so nothing is lost.

Areas are cut in whole pixels of the raster they come from, and a piece may
reach up to one pixel into its neighbour but never leaves a gap. Every piece that is
added, changed or removed is recorded in a restore point (data/backups), and
summary.json is removed so the server re-indexes when it restarts.
"""

import argparse
import math
import os
import re
import shutil
import sys
import time

import numpy as np
from osgeo import gdal, osr

from . import backups, regions, terrain
from .common import check_cancel, fmt_size, fmt_time

gdal.UseExceptions()

NODATA = -32768.0  # what open-elevation treats as "no data" (answers 0)


class Piece:
    def __init__(self, path):
        self.path = path
        self.name = os.path.basename(path)
        ds = gdal.Open(path)
        self.srs_ok = ds.GetSpatialRef() is not None and terrain.is_wgs84_geographic(ds.GetSpatialRef())
        self.gt = ds.GetGeoTransform()
        self.xs, self.ys = ds.RasterXSize, ds.RasterYSize
        band = ds.GetRasterBand(1)
        self.nodata = band.GetNoDataValue()
        self.dtype = band.DataType
        w, n = self.gt[0], self.gt[3]
        self.box = (w, n + self.ys * self.gt[5], w + self.xs * self.gt[1], n)
        ds = None


def to_pixels(box, gt):
    """lon/lat box -> (col0, row0, col1, row1) in a raster's pixel grid (floats)."""
    return ((box[0] - gt[0]) / gt[1], (box[3] - gt[3]) / gt[5],
            (box[2] - gt[0]) / gt[1], (box[1] - gt[3]) / gt[5])


def free_windows(gt, xs, ys, boxes):
    """Disjoint pixel windows (xoff, yoff, xsize, ysize) covering the part of a raster
    that `boxes` (other pieces) don't cover.

    The uncovered area is worked out exactly, then grown outwards to whole pixels:
    the windows tile it without overlapping each other, and reach at most one pixel
    into the neighbouring pieces, so there is never a gap between pieces."""
    holes = [to_pixels(b, gt) for b in boxes]
    free = regions.subtract((0, 0, xs, ys), holes, eps=1e-3)
    snapped = []
    for c0, r0, c1, r1 in free:
        w = (max(0, math.floor(c0 + 1e-3)), max(0, math.floor(r0 + 1e-3)),
             min(xs, math.ceil(c1 - 1e-3)), min(ys, math.ceil(r1 - 1e-3)))
        if w[2] > w[0] and w[3] > w[1]:
            snapped.append(w)
    return [(r[0], r[1], r[2] - r[0], r[3] - r[1]) for r in sorted(regions.merge_rects(snapped), key=lambda r: (r[1], r[0]))]


def split_window(win, piece_px):
    xoff, yoff, xsize, ysize = win
    nx, ny = max(1, math.ceil(xsize / piece_px)), max(1, math.ceil(ysize / piece_px))
    xs = [xoff + round(i * xsize / nx) for i in range(nx + 1)]
    ys = [yoff + round(j * ysize / ny) for j in range(ny + 1)]
    for i in range(nx):
        for j in range(ny):
            yield i, j, (xs[i], ys[j], xs[i + 1] - xs[i], ys[j + 1] - ys[j])


def window_box(win, gt):
    xoff, yoff, xsize, ysize = win
    w = gt[0] + xoff * gt[1]
    n = gt[3] + yoff * gt[5]
    return (w, n + ysize * gt[5], w + xsize * gt[1], n)


def read_valid(ds, win, nodata):
    arr = ds.GetRasterBand(1).ReadAsArray(*win).astype(np.float64)
    bad = ~np.isfinite(arr) | (arr == NODATA)
    if nodata is not None:
        bad |= arr == nodata
    arr[bad] = np.nan
    return arr


def warp_onto(src_path, win, gt, resampling="bilinear"):
    """Heights of `src_path` on the pixel grid of a window of another raster (NaN = none)."""
    w, s, e, n = window_box(win, gt)
    mem = gdal.Warp("", src_path, format="MEM", outputBounds=(w, s, e, n), width=win[2], height=win[3],
                    dstSRS="EPSG:4326", resampleAlg=resampling, outputType=gdal.GDT_Float32,
                    dstNodata=float("nan"), multithread=False)
    arr = mem.GetRasterBand(1).ReadAsArray().astype(np.float64)
    mem = None
    return arr


def write_piece(path, arr, gt, win, dtype):
    """GeoTIFF piece in EPSG:4326 with no-data = -32768 (what open-elevation expects)."""
    w, _, _, n = window_box(win, gt)
    out = np.where(np.isfinite(arr), arr, NODATA)
    if dtype == gdal.GDT_Int16:
        out = np.clip(np.rint(out), -32768, 32767)
    drv = gdal.GetDriverByName("GTiff")
    ds = drv.Create(path, arr.shape[1], arr.shape[0], 1, dtype)
    ds.SetGeoTransform((w, gt[1], 0.0, n, 0.0, gt[5]))
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    ds.SetProjection(srs.ExportToWkt())
    band = ds.GetRasterBand(1)
    band.SetNoDataValue(NODATA)
    band.WriteArray(out)
    ds.FlushCache()
    ds = None


def unique_name(want, taken):
    stem, ext = os.path.splitext(want)
    name, n = want, 2
    while name in taken:
        name = f"{stem}-{n}{ext}"
        n += 1
    taken.add(name)
    return name


def pieces_vrt(pieces, work):
    """All existing pieces as one Float32 mosaic (no-data -32768), for copying old heights."""
    if not pieces:
        return None
    wrappers = []
    for i, p in enumerate(pieces):
        out = os.path.join(work, f"old{i:05d}.vrt")
        gdal.Translate(out, p.path, format="VRT", outputType=gdal.GDT_Float32,
                       noData=p.nodata if p.nodata is not None else NODATA).FlushCache()
        wrappers.append(out)
    vrt = os.path.join(work, "old.vrt")
    gdal.BuildVRT(vrt, wrappers, resolution="highest", VRTNodata=NODATA).FlushCache()
    return vrt


def prepare_new(sources, work, nodata):
    """The new DEM in EPSG:4326, north-up: (path, nodata, dtype)."""
    base = sources[0]
    if len(sources) > 1:
        base = os.path.join(work, "mosaic.vrt")
        opts = {"srcNodata": nodata, "VRTNodata": nodata} if nodata is not None else {}
        gdal.BuildVRT(base, sources, **opts).FlushCache()
    ds = gdal.Open(base)
    if ds.GetSpatialRef() is None:
        sys.exit(f"ERROR: {sources[0]} has no coordinate system")
    band = ds.GetRasterBand(1)
    src_nodata = nodata if nodata is not None else band.GetNoDataValue()
    gt = ds.GetGeoTransform()
    if terrain.is_wgs84_geographic(ds.GetSpatialRef()) and gt[2] == 0 and gt[4] == 0 and gt[5] < 0:
        dtype = band.DataType if band.DataType in (gdal.GDT_Int16, gdal.GDT_Float32) else gdal.GDT_Float32
        return base, src_nodata, dtype
    out = os.path.join(work, "new_4326.tif")
    print(f"Reprojecting the new DEM to EPSG:4326 -> {out}")
    from .common import gdal_progress
    gdal.Warp(out, ds, dstSRS="EPSG:4326", resampleAlg="bilinear", outputType=gdal.GDT_Float32,
              srcNodata=src_nodata, dstNodata=NODATA, multithread=True,
              creationOptions=["TILED=YES", "COMPRESS=DEFLATE", "PREDICTOR=3", "BIGTIFF=IF_SAFER"],
              callback=gdal_progress("reproject"))
    return out, NODATA, gdal.GDT_Float32


def build_parser(p=None):
    p = p or argparse.ArgumentParser(prog="add-elevation", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("sources", nargs="+", metavar="DEM", help="DEM raster(s) of the new area (any GDAL format and CRS)")
    p.add_argument("--out", help="elevation folder (default: data/elevation)")
    p.add_argument("--prefer", choices=["existing", "new"], default="existing",
                   help="where both have heights: keep the existing pieces (default) or use the new DEM")
    p.add_argument("--no-fill-holes", dest="fill_holes", action="store_false",
                   help="with --prefer existing: leave no-data pixels of existing pieces alone")
    p.add_argument("--piece-size", type=int, default=2000, help="target piece size in pixels (default 2000)")
    p.add_argument("--nodata", type=float, help="treat this value of the new DEM as no-data (default: from the file)")
    p.add_argument("--name", help="name stem for the new pieces (default: the DEM's file name)")
    p.add_argument("--dry-run", action="store_true", help="only report what would change")
    p.add_argument("--keep-work", action="store_true", help=argparse.SUPPRESS)
    return p


def main(argv=None, args=None):
    if args is None:
        args = build_parser().parse_args(argv)
    for s in args.sources:
        if not os.path.exists(s):
            sys.exit(f"ERROR: input not found: {s}")
    out = args.out or next((d for d in ("data/elevation", "elevation") if os.path.isdir(d)), None)
    if out is None:
        sys.exit("ERROR: no data/elevation folder here; pass --out")
    out = os.path.abspath(out)
    for s in args.sources:
        if os.path.dirname(os.path.abspath(s)) == out:
            sys.exit(f"ERROR: {s} is inside the elevation folder; keep the big DEM elsewhere (e.g. data/src)")
    root = backups.root_of(out)
    t0 = time.time()

    pieces, bad = [], []
    for n in sorted(os.listdir(out)):
        if n.lower().endswith(".tif"):
            try:
                pc = Piece(os.path.join(out, n))
            except RuntimeError as e:
                bad.append(f"{n} ({e})")
                continue
            (pieces if pc.srs_ok else bad).append(pc if pc.srs_ok else f"{n} (not EPSG:4326)")
    if bad:
        print(f"WARNING: ignoring {len(bad)} pieces: {', '.join(bad[:5])}")
    old_boxes = [p.box for p in pieces]
    print(f"Existing: {len(pieces)} pieces in {out}" +
          (f", together {', '.join(f'{v:.4f}' for v in regions.union_bbox(old_boxes))}" if pieces else ""))

    work = os.path.join(root, ".work", "add-elevation")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    try:
        new_path, new_nodata, dtype = prepare_new([os.path.abspath(s) for s in args.sources], work, args.nodata)
        nds = gdal.Open(new_path)
        gt, nxs, nys = nds.GetGeoTransform(), nds.RasterXSize, nds.RasterYSize
        new_box = window_box((0, 0, nxs, nys), gt)
        print(f"New DEM: {', '.join(args.sources)}: {nxs} x {nys} px, {abs(gt[1]):.7f} deg, "
              f"area {', '.join(f'{v:.4f}' for v in new_box)}")
        frac = regions.covered_fraction(new_box, old_boxes)
        print(f"  {100 * frac:.1f}% of it is already covered by existing pieces")
        print(f"Overlap rule: {'existing pieces win' if args.prefer == 'existing' else 'the new DEM wins'}")
        if args.prefer == "existing":
            targets = free_windows(gt, nxs, nys, old_boxes)
            under = []
            removed, cropped = [], []
            touched = [p for p in pieces if regions.intersect(p.box, new_box)] if args.fill_holes else []
        else:
            targets = [(0, 0, nxs, nys)]
            under = [p for p in pieces if regions.intersect(p.box, new_box)]
            removed = [p for p in under if not free_windows(p.gt, p.xs, p.ys, [new_box])]
            cropped = [p for p in under if p not in removed]
            touched = []

        stem = re.sub(r"[^A-Za-z0-9_-]+", "_", args.name or os.path.splitext(os.path.basename(args.sources[0]))[0])
        taken = set(os.listdir(out))
        jobs = []  # (name, window)
        for k, win in enumerate(targets):
            for i, j, sub in split_window(win, args.piece_size):
                jobs.append((unique_name(f"{stem}_{k}_{i}_{j}.tif", taken), sub))
        print(f"Plan: {len(targets)} area(s) to cut -> {len(jobs)} new pieces"
              + (f"; {len(removed)} existing pieces removed, {len(cropped)} cropped" if args.prefer == "new" else "")
              + (f"; {len(touched)} existing pieces checked for no-data holes" if touched else ""))
        for k, win in enumerate(targets):
            print(f"  area {k}: {', '.join(f'{v:.5f}' for v in window_box(win, gt))} ({win[2]} x {win[3]} px)")
        if args.dry_run:
            print("Dry run: nothing changed.")
            return

        need = int(sum(w[2] * w[3] for _, w in jobs) * 4 * 1.2) + 32 * 2**20
        free = shutil.disk_usage(root).free
        if free < need:
            sys.exit(f"ERROR: not enough free disk space ({fmt_size(free)} free, about {fmt_size(need)} needed)")

        stage = os.path.join(work, "pieces")
        os.makedirs(stage)
        os.makedirs(os.path.join(work, "oldvrt"))
        old_vrt = pieces_vrt(pieces, os.path.join(work, "oldvrt")) if (pieces and (under or jobs)) else None
        change = backups.Change("elevation", root, os.path.relpath(out, root),
                                f"Elevation: added {', '.join(os.path.basename(s) for s in args.sources)}",
                                details={"sources": [os.path.basename(s) for s in args.sources], "prefer": args.prefer})
        rel = os.path.relpath(out, root)
        written = filled_from_old = skipped_empty = 0
        for n_done, (name, win) in enumerate(jobs, 1):
            check_cancel()
            arr = read_valid(nds, win, new_nodata)
            if old_vrt is not None and not np.isfinite(arr).all():
                box = window_box(win, gt)
                if any(regions.intersect(box, b) for b in old_boxes):
                    old = warp_onto(old_vrt, win, gt)
                    fill = ~np.isfinite(arr) & np.isfinite(old)
                    if fill.any():
                        arr[fill] = old[fill]
                        filled_from_old += int(fill.sum())
            if not np.isfinite(arr).any():
                skipped_empty += 1
                continue
            path = os.path.join(stage, name)
            write_piece(path, arr, gt, win, dtype)
            change.put(os.path.join(rel, name), path)
            written += 1
            if n_done % 10 == 0 or n_done == len(jobs):
                print(f"  new pieces: {n_done}/{len(jobs)} ({100.0 * n_done / len(jobs):.0f}%)", flush=True)
        print(f"  {written} new pieces written" + (f", {skipped_empty} skipped (no data at all)" if skipped_empty else "")
              + (f", {filled_from_old} no-data pixels filled with old heights" if filled_from_old else ""))

        holes = 0
        for p in touched:
            check_cancel()
            pds = gdal.Open(p.path)
            band = pds.GetRasterBand(1)
            arr = band.ReadAsArray().astype(np.float64)
            pnd = p.nodata
            empty = (arr == NODATA) | ~np.isfinite(arr)
            if pnd is not None:
                empty |= arr == pnd
            if not empty.any():
                continue
            win = (0, 0, p.xs, p.ys)
            new_vals = warp_onto(new_path, win, p.gt)
            fill = empty & np.isfinite(new_vals)
            if not fill.any():
                continue
            arr[fill] = new_vals[fill]
            if pnd is not None and pnd != NODATA:
                arr[empty & ~fill] = pnd
            else:
                arr[empty & ~fill] = NODATA
            staged = os.path.join(stage, "filled-" + p.name)
            drv = gdal.GetDriverByName("GTiff")
            outds = drv.CreateCopy(staged, pds)
            ob = outds.GetRasterBand(1)
            if p.dtype in (gdal.GDT_Int16, gdal.GDT_Int32, gdal.GDT_UInt16, gdal.GDT_Byte):
                arr = np.rint(arr)
            ob.WriteArray(arr)
            outds.FlushCache()
            outds = pds = None
            change.put(os.path.join(rel, p.name), staged)
            holes += 1
            print(f"  {p.name}: {int(fill.sum())} no-data pixels filled from the new DEM")
        if touched:
            print(f"  {holes} existing pieces had holes filled (their valid heights are unchanged)")

        for p in cropped:
            check_cancel()
            parts = free_windows(p.gt, p.xs, p.ys, [new_box])
            pds = gdal.Open(p.path)
            for k, win in enumerate(parts):
                name = unique_name(f"{os.path.splitext(p.name)[0]}_c{k}.tif", taken)
                staged = os.path.join(stage, name)
                gdal.Translate(staged, pds, srcWin=list(win), format="GTiff").FlushCache()
                change.put(os.path.join(rel, name), staged)
            pds = None
            change.remove(os.path.join(rel, p.name))
            print(f"  {p.name}: cropped to {len(parts)} piece(s) outside the new DEM")
        for p in removed:
            change.remove(os.path.join(rel, p.name))
        if removed:
            print(f"  {len(removed)} existing pieces lie entirely under the new DEM and are removed")

        nds = None
        if not len(change):
            print("Nothing to change: the new DEM adds no heights.")
            return
        change.install()
        summary = os.path.join(out, "summary.json")
        if os.path.exists(summary):
            os.remove(summary)
            print("Removed summary.json so the server re-indexes the folder.")
        verify(out, new_box)
        print(f"Done in {fmt_time(time.time() - t0)}. Restart the elevation server: docker compose restart elevation")
    finally:
        if not args.keep_work:
            shutil.rmtree(work, ignore_errors=True)
            try:
                os.rmdir(os.path.dirname(work))
            except OSError:
                pass


def verify(out, box, points=400):
    """Every point of the new area must fall inside some piece (no gaps); report overlaps."""
    import random
    boxes = []
    for n in os.listdir(out):
        if n.lower().endswith(".tif"):
            try:
                boxes.append(Piece(os.path.join(out, n)).box)
            except RuntimeError:
                pass
    rnd = random.Random(7)
    gaps = multi = 0
    for _ in range(points):
        lon, lat = rnd.uniform(box[0], box[2]), rnd.uniform(box[1], box[3])
        hits = sum(1 for b in boxes if b[0] <= lon < b[2] and b[1] <= lat < b[3])
        gaps += hits == 0
        multi += hits > 1
    print(f"Check: {points} random points in the new area: {points - gaps} inside a piece, {gaps} in no piece"
          + (f", {multi} on a seam less than a pixel wide that two pieces share" if multi else ""))
    if gaps:
        print("WARNING: some points of the new area are in no piece; the server answers 0 there")


if __name__ == "__main__":
    main()
