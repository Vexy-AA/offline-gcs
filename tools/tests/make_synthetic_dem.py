"""Write a synthetic DEM for testing: mountains in UTM 36N near Sevastopol,
Int16 with a no-data hole, so reprojection, overviews and fill are exercised.

    python3 tools/tests/make_synthetic_dem.py out.tif [size_px] [pixel_m]
"""
import sys

import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()


def heights(e, n, e0, n0):
    x, y = (e - e0) / 1000.0, (n - n0) / 1000.0  # km
    h = 400 + 350 * np.sin(x / 6.0) * np.cos(y / 8.0)
    h += 900 * np.exp(-((x - 10) ** 2 + (y - 5) ** 2) / (2 * 9.0 ** 2))   # big massif
    h += 120 * np.sin(x * 1.3) * np.sin(y * 1.1)                          # small ridges
    return np.clip(h, 0, None)


def main():
    out = sys.argv[1]
    size = int(sys.argv[2]) if len(sys.argv) > 2 else 3000
    px = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0

    utm = osr.SpatialReference()
    utm.ImportFromEPSG(32636)
    wgs = osr.SpatialReference()
    wgs.ImportFromEPSG(4326)
    wgs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    e0, n0, _ = osr.CoordinateTransformation(wgs, utm).TransformPoint(33.75, 44.6)

    ulx = e0 - size * px / 2
    uly = n0 + size * px / 2
    cols = ulx + (np.arange(size) + 0.5) * px
    rows = uly - (np.arange(size) + 0.5) * px
    ee, nn = np.meshgrid(cols, rows)
    h = np.round(heights(ee, nn, e0, n0)).astype(np.int16)
    h[: size // 10, : size // 10] = -32768  # no-data hole in the NW corner

    ds = gdal.GetDriverByName("GTiff").Create(out, size, size, 1, gdal.GDT_Int16,
                                              ["TILED=YES", "COMPRESS=DEFLATE"])
    ds.SetGeoTransform((ulx, px, 0, uly, 0, -px))
    ds.SetSpatialRef(utm)
    b = ds.GetRasterBand(1)
    b.SetNoDataValue(-32768)
    b.WriteArray(h)
    ds = None
    print(f"wrote {out}: {size}x{size} px @ {px} m, heights {h[h > -32768].min()}..{h.max()} m")


if __name__ == "__main__":
    main()
