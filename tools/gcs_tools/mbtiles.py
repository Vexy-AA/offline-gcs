"""Build an .mbtiles file for the map tile server (data/mbtiles/<name>.mbtiles).

Sources:
  raster(s)  GeoTIFF / VRT / JP2 / ... in any CRS (several files are mosaicked).
             Reprojected to Web Mercator, cut into 256 px tiles at the max zoom,
             lower zoom levels built as overviews.
  tile dir   an existing {z}/{x}/{y}.png|jpg|webp folder (e.g. a SAS.Planet export
             or the old open-elevation data/xyz folder), packed as-is.

The tile server serves a tile set as /services/<file name>/tiles/{z}/{x}/{y}.png
(the extension in the URL is ignored, the real image type is sent), so the
logviewer's "custom" layer needs the file to be called custom.mbtiles.
"""

import argparse
import math
import multiprocessing as mp
import errno
import os
import shutil
import sqlite3
import sys
import time

import numpy as np
from osgeo import gdal

from .common import Ticker, check_cancel, fmt_size, fmt_time, gdal_progress, pool_map

gdal.UseExceptions()

EARTH_CIRCUMFERENCE = 2 * math.pi * 6378137.0
# "auto" = JPEG for fully opaque tiles, PNG for tiles with transparent pixels
# (image edges, irregular orthophotos), like GeoPackage TILE_FORMAT=AUTO.
FORMATS = {"auto": "PNG", "jpeg": "JPEG", "jpg": "JPEG", "png": "PNG", "png8": "PNG8", "webp": "WEBP"}


def zoom_resolution(z):
    return EARTH_CIRCUMFERENCE / (256 * (1 << z))


def native_zoom(res):
    return int(max(0, min(22, round(math.log2(EARTH_CIRCUMFERENCE / (256 * res))))))


# --------------------------------------------------------------------------
# Raster -> MBTiles
# --------------------------------------------------------------------------

def _prepare_bands(ds_path, work):
    """Return a dataset path with 8-bit gray/RGB(A) bands (palette expanded)."""
    ds = gdal.Open(ds_path)
    b1 = ds.GetRasterBand(1)
    if b1.DataType != gdal.GDT_Byte:
        sys.exit(f"ERROR: {ds_path} is {gdal.GetDataTypeName(b1.DataType)}; imagery must be 8-bit.\n"
                 "       Convert first, e.g.: gdal_translate -ot Byte -scale in.tif out.tif\n"
                 "       (for a DEM you want 'terrain' or 'elevation', not 'mbtiles')")
    if ds.RasterCount == 1 and b1.GetColorTable() is not None:
        out = os.path.join(work, "expanded.vrt")
        gdal.Translate(out, ds, format="VRT", rgbExpand="rgba").FlushCache()
        return out
    if ds.RasterCount > 4:
        out = os.path.join(work, "rgb.vrt")
        gdal.Translate(out, ds, format="VRT", bandList=[1, 2, 3]).FlushCache()
        return out
    return ds_path


def _has_alpha(ds):
    last = ds.GetRasterBand(ds.RasterCount)
    return last.GetColorInterpretation() == gdal.GCI_AlphaBand or ds.RasterCount in (2, 4)


def work_paths(out):
    """Scratch folder and temporary output for building `out`.

    The tile server loads every .mbtiles file that appears anywhere in its
    folder, so all work happens next to that folder, never inside it:
    data/mbtiles/x.mbtiles -> data/.work/mbtiles-x/.
    The finished file is then moved in with one atomic rename.
    """
    out_dir = os.path.dirname(out)
    base = os.path.dirname(out_dir) if os.path.basename(out_dir) == "mbtiles" else out_dir
    name = os.path.splitext(os.path.basename(out))[0]
    work = os.path.join(base, ".work", f"mbtiles-{name}")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    return work, os.path.join(work, f"{name}.mbtiles")


def install(tmp_out, out):
    try:
        os.replace(tmp_out, out)
    except OSError as e:
        if e.errno != errno.EXDEV:
            raise
        shutil.move(tmp_out, out)  # work dir on another filesystem: copy


def cleanup_work(work):
    shutil.rmtree(work, ignore_errors=True)
    try:
        os.rmdir(os.path.dirname(work))  # .work, if now empty
    except OSError:
        pass


def raster_to_mbtiles(args):
    work, tmp_out = work_paths(args.out)
    try:
        src = args.sources[0]
        if len(args.sources) > 1:
            src = os.path.join(work, "mosaic.vrt")
            print(f"Mosaicking {len(args.sources)} inputs")
            opts = {"srcNodata": args.nodata} if args.nodata is not None else {}
            gdal.BuildVRT(src, args.sources, **opts).FlushCache()
        src = _prepare_bands(src, work)
        ds = gdal.Open(src)
        if ds.GetSpatialRef() is None and not ds.GetGCPCount():
            sys.exit(f"ERROR: {args.sources[0]} has no georeferencing")

        probe = gdal.Warp("", ds, format="VRT", dstSRS="EPSG:3857")
        native = native_zoom(abs(probe.GetGeoTransform()[1]))
        probe = None
        max_zoom = native if args.max_zoom is None else args.max_zoom
        min_zoom = min(args.min_zoom, max_zoom)
        res = zoom_resolution(max_zoom)

        print(f"Source: {', '.join(args.sources)}")
        print(f"  {ds.RasterXSize} x {ds.RasterYSize} px, {ds.RasterCount} band(s); native zoom {native}")
        fmt_label = {"auto": f"JPEG q{args.quality} + PNG where transparent"}.get(
            args.format, args.format.upper() + ("" if args.format.startswith("png") else f" q{args.quality}"))
        print(f"Tiles: zoom {min_zoom}..{max_zoom} ({res:.2f} m/px at the max zoom), {fmt_label} -> {args.out}")
        if max_zoom < 17:
            print(f"  note: the logviewer asks for tiles up to z17; above z{max_zoom} it shows the z{max_zoom} "
                  "tiles enlarged as long as the tile server runs with --missing-image-tile-404 (see docker-compose.yml)")

        warp_kw = dict(
            format="VRT", dstSRS="EPSG:3857", xRes=res, yRes=res, targetAlignedPixels=True,
            resampleAlg=args.resampling, multithread=True,
            warpOptions=["NUM_THREADS=ALL_CPUS", "INIT_DEST=0"],
        )
        if args.nodata is not None:
            warp_kw["srcNodata"] = args.nodata
        if not _has_alpha(ds):
            warp_kw["dstAlpha"] = True  # outside the image stays transparent
        if args.bounds:
            w, s, e, n = args.bounds
            warp_kw["outputBounds"] = (w, s, e, n)
            warp_kw["outputBoundsSRS"] = "EPSG:4326"
        vrt = os.path.join(work, "webmercator.vrt")
        gdal.Warp(vrt, ds, **warp_kw).FlushCache()
        ds = None

        co = [
            f"TILE_FORMAT={FORMATS[args.format]}", f"QUALITY={args.quality}", "ZLEVEL=6",
            f"NAME={args.name}", f"DESCRIPTION={args.description}", "TYPE=baselayer",
            "ZOOM_LEVEL_STRATEGY=AUTO", "RESAMPLING=NEAREST", "BLOCKSIZE=256",
        ]
        t0 = time.time()
        print("Writing max-zoom tiles")
        gdal.SetConfigOption("GDAL_NUM_THREADS", "ALL_CPUS")
        gdal.Translate(tmp_out, vrt, format="MBTILES", creationOptions=co,
                       callback=gdal_progress(f"z{max_zoom}")).FlushCache()

        # pass the tile format again: GDAL otherwise writes overview tiles as PNG for WEBP
        out_ds = gdal.OpenEx(tmp_out, gdal.OF_RASTER | gdal.OF_UPDATE, open_options=[
            f"TILE_FORMAT={FORMATS[args.format]}", f"QUALITY={args.quality}", "ZLEVEL=6"])
        got = int(out_ds.GetMetadataItem("maxzoom") or -1)
        if got != max_zoom:
            sys.exit(f"ERROR: GDAL wrote zoom {got}, expected {max_zoom}")
        factors = [2 ** k for k in range(1, max_zoom - min_zoom + 1)]
        if factors:
            print(f"Building zoom {max_zoom - 1}..{min_zoom} ({args.overview_resampling})")
            out_ds.BuildOverviews(args.overview_resampling.upper(), factors,
                                  callback=gdal_progress("overviews"))
        out_ds = None
        # GDAL stops making overviews once the whole image fits in one tile;
        # build the remaining small levels (a few tiles each) ourselves.
        fill_low_zooms(tmp_out, min_zoom, "png" if args.format == "auto" else args.format, args.quality)
        if args.format == "auto":
            hybridize(tmp_out, args.quality, args.workers)
        install(tmp_out, args.out)
        print(f"Done in {fmt_time(time.time() - t0)}.")
    finally:
        if not args.keep_work:
            cleanup_work(work)


def _decode_rgba(blob):
    """Tile image bytes -> (4, 256, 256) uint8 RGBA array."""
    name = f"/vsimem/dec_{id(blob)}"
    gdal.FileFromMemBuffer(name, bytes(blob))
    try:
        ds = gdal.Open(name)
        arr = ds.ReadAsArray()
        ds = None
    finally:
        gdal.Unlink(name)
    if arr.ndim == 2:
        arr = arr[None]
    bands = arr.shape[0]
    if bands == 1:
        arr = np.concatenate([arr, arr, arr, np.full_like(arr[:1], 255)])
    elif bands == 2:
        arr = np.concatenate([arr[:1], arr[:1], arr[:1], arr[1:2]])
    elif bands == 3:
        arr = np.concatenate([arr, np.full_like(arr[:1], 255)])
    return arr[:4]


def _encode(rgba, fmt, quality):
    h, w = rgba.shape[1:]
    opaque = bool((rgba[3] == 255).all())
    bands = rgba[:3] if (fmt == "jpeg" or opaque) else rgba
    mem = gdal.GetDriverByName("MEM").Create("", w, h, bands.shape[0], gdal.GDT_Byte)
    for i in range(bands.shape[0]):
        mem.GetRasterBand(i + 1).WriteArray(bands[i])
    driver, opts, ext = {
        "jpeg": ("JPEG", [f"QUALITY={quality}"], "jpg"),
        "webp": ("WEBP", [f"QUALITY={quality}"], "webp"),
    }.get(fmt, ("PNG", ["ZLEVEL=6"], "png"))
    name = f"/vsimem/enc_{id(rgba)}.{ext}"
    gdal.GetDriverByName(driver).CreateCopy(name, mem, options=opts)
    try:
        f = gdal.VSIFOpenL(name, "rb")
        gdal.VSIFSeekL(f, 0, 2)
        size = gdal.VSIFTellL(f)
        gdal.VSIFSeekL(f, 0, 0)
        data = gdal.VSIFReadL(1, size, f)
        gdal.VSIFCloseL(f)
    finally:
        gdal.Unlink(name)
        mem = None
    return data


def fill_low_zooms(path, min_zoom, fmt, quality):
    db = sqlite3.connect(path)
    have = db.execute("SELECT MIN(zoom_level) FROM tiles").fetchone()[0]
    if have is None or have <= min_zoom:
        db.close()
        return
    if fmt == "jpg":
        fmt = "jpeg"
    for z in range(have - 1, min_zoom - 1, -1):
        children = db.execute("SELECT tile_column, tile_row FROM tiles WHERE zoom_level=?", (z + 1,)).fetchall()
        parents = sorted({(c // 2, r // 2) for c, r in children})
        for pc, pr in parents:
            check_cancel()
            canvas = np.zeros((4, 512, 512), dtype=np.float64)
            for dx in (0, 1):
                for dy in (0, 1):
                    row = db.execute("SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                                     (z + 1, 2 * pc + dx, 2 * pr + dy)).fetchone()
                    if row is None:
                        continue
                    img = _decode_rgba(row[0]).astype(np.float64)
                    oy = 0 if dy == 1 else 256  # TMS rows grow northwards; north half is on top
                    canvas[:, oy:oy + 256, dx * 256:dx * 256 + 256] = img
            a = canvas[3].reshape(256, 2, 256, 2)
            a_sum = a.sum(axis=(1, 3))
            if not a_sum.any():
                continue
            out = np.zeros((4, 256, 256))
            for b in range(3):
                c = (canvas[b] * canvas[3]).reshape(256, 2, 256, 2).sum(axis=(1, 3))
                out[b] = np.where(a_sum > 0, c / np.maximum(a_sum, 1e-9), 0)
            out[3] = a_sum / 4.0
            data = _encode(np.clip(np.rint(out), 0, 255).astype(np.uint8), fmt, quality)
            db.execute("INSERT OR REPLACE INTO tiles VALUES (?,?,?,?)", (z, pc, pr, sqlite3.Binary(data)))
    db.execute("UPDATE metadata SET value=? WHERE name='minzoom'", (str(min_zoom),))
    db.commit()
    db.close()


_HQ = {}


def _hybrid_init(quality):
    gdal.UseExceptions()
    _HQ["q"] = quality


def _hybrid_one(item):
    rowid, blob = item
    rgba = _decode_rgba(blob)
    alpha = rgba[3]
    if not alpha.any():
        return rowid, None
    if (alpha == 255).all():
        return rowid, _encode(rgba, "jpeg", _HQ["q"])
    return rowid, bytes(blob)


def hybridize(path, quality, workers):
    """Re-encode fully opaque PNG tiles as JPEG; keep PNG where there is transparency."""
    db = sqlite3.connect(path)
    rowids = [r[0] for r in db.execute("SELECT rowid FROM tiles ORDER BY rowid")]
    print(f"Encoding {len(rowids)} tiles (JPEG where opaque, PNG where transparent)")
    tick = Ticker()
    n_jpg = n_png = n_drop = 0
    ctx = mp.get_context("spawn")
    with ctx.Pool(max(1, workers), initializer=_hybrid_init, initargs=(quality,)) as pool:
        for i in range(0, len(rowids), 512):
            chunk = rowids[i:i + 512]
            marks = ",".join("?" * len(chunk))
            items = db.execute(f"SELECT rowid, tile_data FROM tiles WHERE rowid IN ({marks})", chunk).fetchall()
            for rowid, data in pool_map(pool, _hybrid_one, items, batch=16):
                if data is None:
                    db.execute("DELETE FROM tiles WHERE rowid=?", (rowid,))
                    n_drop += 1
                    continue
                if data[:2] == b"\xff\xd8":
                    n_jpg += 1
                else:
                    n_png += 1
                db.execute("UPDATE tiles SET tile_data=? WHERE rowid=?", (sqlite3.Binary(data), rowid))
            db.commit()
            if tick.due():
                print(f"  {min(i + 512, len(rowids))}/{len(rowids)}", flush=True)
    print(f"  {n_jpg} JPEG, {n_png} PNG" + (f", {n_drop} empty dropped" if n_drop else ""))
    # mbtileserver took the Content-Type of all tiles from the first row (gcs-tools' tile server
    # reads each tile's), so put a JPEG first (browsers and GDAL go by the bytes anyway).
    db.executescript("""
        CREATE TABLE tiles_sorted (zoom_level INTEGER NOT NULL, tile_column INTEGER NOT NULL,
            tile_row INTEGER NOT NULL, tile_data BLOB NOT NULL, UNIQUE (zoom_level, tile_column, tile_row));
        INSERT INTO tiles_sorted SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles
            ORDER BY substr(tile_data, 1, 2) = X'FFD8' DESC, zoom_level, tile_column, tile_row;
        DROP TABLE tiles;
        ALTER TABLE tiles_sorted RENAME TO tiles;
    """)
    first = db.execute("SELECT substr(tile_data, 1, 2) FROM tiles LIMIT 1").fetchone()[0]
    db.execute("UPDATE metadata SET value=? WHERE name='format'", ("jpg" if first == b"\xff\xd8" else "png",))
    db.commit()
    db.execute("VACUUM")
    db.close()


# --------------------------------------------------------------------------
# {z}/{x}/{y} folder -> MBTiles
# --------------------------------------------------------------------------

def detect_format(head):
    if head.startswith(b"\x89PNG"):
        return "png"
    if head.startswith(b"\xff\xd8"):
        return "jpg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head.startswith(b"\x1f\x8b") or head[:1] == b"\x1a":
        return "pbf"
    return None


def _iter_tiles(root):
    for zname in sorted(os.listdir(root), key=lambda n: (len(n), n)):
        zdir = os.path.join(root, zname)
        if not (zname.isdigit() and os.path.isdir(zdir)):
            continue
        z = int(zname)
        with os.scandir(zdir) as xs:
            for xe in xs:
                if not (xe.name.isdigit() and xe.is_dir()):
                    continue
                x = int(xe.name)
                with os.scandir(xe.path) as ys:
                    for ye in ys:
                        stem = ye.name.split(".", 1)[0]
                        if stem.isdigit() and ye.is_file():
                            yield z, x, int(stem), ye.path


def tile_lonlat(z, x, y):
    """NW corner of an XYZ tile."""
    n = 1 << z
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def dir_to_mbtiles(args):
    root = args.sources[0]
    work, tmp_out = work_paths(args.out)
    try:
        _pack_dir(args, root, tmp_out)
        install(tmp_out, args.out)
    finally:
        cleanup_work(work)


def _pack_dir(args, root, tmp_out):
    db = sqlite3.connect(tmp_out)
    db.executescript("""
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        CREATE TABLE metadata (name TEXT, value TEXT);
        CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
    """)
    formats, count, nbytes = {}, 0, 0
    zmin, zmax, rng = 99, -1, {}
    tick = Ticker()
    batch = []
    print(f"Packing {root} ({args.scheme.upper()} rows) -> {args.out}")
    for z, x, y, path in _iter_tiles(root):
        check_cancel()
        with open(path, "rb") as f:
            data = f.read()
        if not data:
            continue
        fmt = detect_format(data[:16]) or os.path.splitext(path)[1].lstrip(".").lower()
        formats[fmt] = formats.get(fmt, 0) + 1
        xyz_y = y if args.scheme == "xyz" else (1 << z) - 1 - y
        row = (1 << z) - 1 - xyz_y  # MBTiles stores TMS rows
        batch.append((z, x, row, sqlite3.Binary(data)))
        count += 1
        nbytes += len(data)
        zmin, zmax = min(zmin, z), max(zmax, z)
        r = rng.setdefault(z, [x, x, xyz_y, xyz_y])
        r[0], r[1], r[2], r[3] = min(r[0], x), max(r[1], x), min(r[2], xyz_y), max(r[3], xyz_y)
        if len(batch) >= 2000:
            db.executemany("INSERT INTO tiles VALUES (?,?,?,?)", batch)
            batch.clear()
        if tick.due():
            print(f"  {count} tiles, {fmt_size(nbytes)}", flush=True)
    if batch:
        db.executemany("INSERT INTO tiles VALUES (?,?,?,?)", batch)
    if not count:
        db.close()
        sys.exit(f"ERROR: no {{z}}/{{x}}/{{y}} tiles found in {root}")
    print("  indexing")
    try:
        db.execute("CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row)")
    except sqlite3.IntegrityError:
        db.close()
        sys.exit("ERROR: duplicate tiles (same z/x/y with different extensions?)")

    main_fmt = max(formats, key=formats.get)
    if len(formats) > 1:
        print(f"WARNING: mixed tile formats {formats}; mbtileserver would label all of them as {main_fmt} "
              "(gcs-tools' tile server labels each tile by its own type)")
    x0, x1, y0, y1 = rng[zmax]
    west, north = tile_lonlat(zmax, x0, y0)
    east, south = tile_lonlat(zmax, x1 + 1, y1 + 1)
    meta = {
        "name": args.name, "description": args.description, "type": "baselayer", "version": "1.1",
        "format": main_fmt, "minzoom": str(zmin), "maxzoom": str(zmax),
        "bounds": f"{west:.8f},{south:.8f},{east:.8f},{north:.8f}",
        "center": f"{(west + east) / 2:.8f},{(south + north) / 2:.8f},{min(zmax, max(zmin, 10))}",
    }
    db.executemany("INSERT INTO metadata VALUES (?,?)", list(meta.items()))
    db.commit()
    db.close()
    print(f"Done: {count} tiles, zoom {zmin}..{zmax}, format {main_fmt}.")


# --------------------------------------------------------------------------

def summarize(path):
    from .tilesource import open_ro
    db = open_ro(path)
    meta = dict(db.execute("SELECT name, value FROM metadata"))
    rows = db.execute("SELECT zoom_level, COUNT(*) FROM tiles GROUP BY zoom_level ORDER BY zoom_level").fetchall()
    mix = db.execute("SELECT hex(substr(tile_data, 1, 2)), COUNT(*) FROM tiles GROUP BY 1").fetchall()
    db.close()
    names = {"FFD8": "jpeg", "8950": "png", "5249": "webp"}
    if len(mix) > 1:
        meta["format"] = f"{meta.get('format')} (" + ", ".join(f"{n} {names.get(h, h)}" for h, n in mix) + ")"
    print(f"{os.path.basename(path)}: {fmt_size(os.path.getsize(path))}, format={meta.get('format')}, "
          f"bounds={meta.get('bounds')}")
    print("  tiles per zoom: " + ", ".join(f"z{z}:{n}" for z, n in rows))


def build_parser(p=None):
    p = p or argparse.ArgumentParser(prog="mbtiles", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("sources", nargs="+", metavar="SRC", help="raster file(s), or one {z}/{x}/{y} tile folder")
    p.add_argument("out", metavar="OUT.mbtiles", help="e.g. data/mbtiles/custom.mbtiles")
    p.add_argument("--format", choices=["auto", "jpeg", "png", "png8", "webp"], default="auto",
                   help="tile image format for raster input. auto (default): JPEG, but PNG for tiles with "
                        "transparent pixels so image edges are not black. jpeg: smallest, black outside the "
                        "image. png: lossless, big. webp: small + transparent, browsers only")
    p.add_argument("--quality", type=int, default=85, help="JPEG/WEBP quality 1-100 (default 85)")
    p.add_argument("--max-zoom", type=int, help="deepest zoom (default: closest to the image resolution). "
                                                "The logviewer requests at most z17")
    p.add_argument("--min-zoom", type=int, default=0, help="shallowest zoom (default 0)")
    p.add_argument("--resampling", default="bilinear",
                   choices=["near", "bilinear", "cubic", "cubicspline", "lanczos", "average"],
                   help="resampling when reprojecting to the max zoom (default bilinear)")
    p.add_argument("--overview-resampling", default="average",
                   choices=["nearest", "average", "bilinear", "cubic", "lanczos"],
                   help="resampling for lower zoom levels (default average)")
    p.add_argument("--nodata", type=float, help="source pixel value to make transparent (default: from file)")
    p.add_argument("--bounds", type=float, nargs=4, metavar=("W", "S", "E", "N"),
                   help="only tile this lon/lat box")
    p.add_argument("--scheme", choices=["xyz", "tms"], default="xyz",
                   help="row order of a tile-folder source (default xyz = Google/OSM style)")
    p.add_argument("--name", help="tileset name in metadata (default: output file name)")
    p.add_argument("--description", default="", help="tileset description in metadata")
    p.add_argument("--workers", type=int, default=os.cpu_count() or 1,
                   help="processes for tile re-encoding (default: all CPUs)")
    p.add_argument("--overwrite", action="store_true", help="replace OUT if it exists")
    p.add_argument("--keep-work", action="store_true", help=argparse.SUPPRESS)
    return p


def main(argv=None, args=None):
    if args is None:
        args = build_parser().parse_args(argv)
    for s in args.sources:
        if not os.path.exists(s) and not s.startswith("/vsi"):
            sys.exit(f"ERROR: input not found: {s}")
    if not args.out.lower().endswith(".mbtiles"):
        sys.exit("ERROR: output must end with .mbtiles (the tile server only loads *.mbtiles)")
    if os.path.exists(args.out) and not args.overwrite:
        sys.exit(f"ERROR: {args.out} exists; use --overwrite to replace it")
    args.out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    args.name = args.name or os.path.splitext(os.path.basename(args.out))[0]
    if args.max_zoom is not None and not 0 <= args.max_zoom <= 22:
        sys.exit("ERROR: --max-zoom must be 0..22")

    if len(args.sources) == 1 and os.path.isdir(args.sources[0]):
        dir_to_mbtiles(args)
    else:
        if any(os.path.isdir(s) for s in args.sources):
            sys.exit("ERROR: give either raster files or a single tile folder")
        raster_to_mbtiles(args)
    summarize(args.out)
    tileset = os.path.splitext(os.path.basename(args.out))[0]
    print(f"Tile set id '{tileset}': /services/{tileset}/tiles/{{z}}/{{x}}/{{y}}.png "
          "(the tile server picks it up by itself within a few seconds)")


if __name__ == "__main__":
    main()
