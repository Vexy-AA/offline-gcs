"""Write two overlapping synthetic DEMs (and shaded-relief imagery of each) for
testing the add-* commands: an "old" area and a "new" area to its north-east.

Both DEMs sample the same landscape, but the new one is 40 m higher everywhere,
so a height read back tells which DEM it came from. The old DEM is in UTM 36N
with a no-data hole; the new one is in EPSG:4326 at a different resolution.

    python3 tools/tests/make_two_areas.py OUT_DIR
      -> OUT_DIR/old.tif  OUT_DIR/old_rgb.tif  OUT_DIR/new.tif  OUT_DIR/new_rgb.tif
"""
import os
import sys

import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()

NEW_OFFSET = 40.0
OLD_CENTER = (33.75, 44.60)       # lon, lat
NEW_BOX = (33.80, 44.62, 34.10, 44.86)  # w, s, e, n: overlaps the old area's north-east corner


def landscape(lon, lat):
    x, y = (lon - 33.6) * 79.0, (lat - 44.4) * 111.0  # km
    h = 400 + 350 * np.sin(x / 6.0) * np.cos(y / 8.0)
    h += 900 * np.exp(-((x - 18) ** 2 + (y - 20) ** 2) / (2 * 9.0 ** 2))
    h += 120 * np.sin(x * 1.3) * np.sin(y * 1.1)
    return np.clip(h, 5, None)


def write(path, arr, gt, srs, nodata, dtype):
    ds = gdal.GetDriverByName("GTiff").Create(path, arr.shape[1], arr.shape[0], 1, dtype,
                                              options=["TILED=YES", "COMPRESS=DEFLATE"])
    ds.SetGeoTransform(gt)
    ds.SetProjection(srs.ExportToWkt())
    b = ds.GetRasterBand(1)
    if nodata is not None:
        b.SetNoDataValue(nodata)
    b.WriteArray(arr)
    ds = None


def rgb(dem, out):
    tmp = out + ".shade.tif"
    gdal.DEMProcessing(tmp, dem, "hillshade")
    gdal.Translate(out, tmp, bandList=[1, 1, 1], options=["-colorinterp", "red,green,blue"])
    os.remove(tmp)


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    wgs = osr.SpatialReference()
    wgs.ImportFromEPSG(4326)
    wgs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    utm = osr.SpatialReference()
    utm.ImportFromEPSG(32636)
    utm.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)

    # old: UTM 36N, 1200 x 1200 px at 30 m around OLD_CENTER, Int16, no-data hole in the SW
    size, px = 1200, 30.0
    e0, n0, _ = osr.CoordinateTransformation(wgs, utm).TransformPoint(*OLD_CENTER)
    ulx, uly = e0 - size * px / 2, n0 + size * px / 2
    cols = ulx + (np.arange(size) + 0.5) * px
    rows = uly - (np.arange(size) + 0.5) * px
    ee, nn = np.meshgrid(cols, rows)
    back = osr.CoordinateTransformation(utm, wgs)
    pts = np.array(back.TransformPoints(np.column_stack([ee.ravel(), nn.ravel()]).tolist()))
    h = landscape(pts[:, 0], pts[:, 1]).reshape(size, size)
    h = np.round(h).astype(np.int16)
    h[-size // 8:, : size // 8] = -32768
    write(os.path.join(out, "old.tif"), h, (ulx, px, 0, uly, 0, -px), utm, -32768, gdal.GDT_Int16)

    # new: EPSG:4326, 0.0004 deg (~40 m), Float32, nodata -9999 in a strip on its east edge
    w, s, e, n = NEW_BOX
    res = 0.0004
    nx, ny = int(round((e - w) / res)), int(round((n - s) / res))
    lon = w + (np.arange(nx) + 0.5) * res
    lat = n - (np.arange(ny) + 0.5) * res
    lo, la = np.meshgrid(lon, lat)
    hn = (landscape(lo, la) + NEW_OFFSET).astype(np.float32)
    hn[:, -nx // 20:] = -9999
    write(os.path.join(out, "new.tif"), hn, (w, res, 0, n, 0, -res), wgs, -9999, gdal.GDT_Float32)

    rgb(os.path.join(out, "old.tif"), os.path.join(out, "old_rgb.tif"))
    rgb(os.path.join(out, "new.tif"), os.path.join(out, "new_rgb.tif"))
    print("wrote old.tif, new.tif and their shaded-relief images in", out)


if __name__ == "__main__":
    main()
