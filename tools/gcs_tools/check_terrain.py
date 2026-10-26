"""Sanity-check a quantized-mesh terrain folder.

  * layer.json is valid and every tile listed in "available" exists
  * every tile decodes, triangles reference valid vertices, edges are complete
  * optionally (--dem): heights interpolated from the deepest tiles are
    compared with the DEM at random points
"""

import argparse
import gzip
import json
import math
import os
import random
import sys

import numpy as np
from osgeo import gdal, osr

from . import qmesh
from .terrain import tile_bounds

gdal.UseExceptions()


def read_tile(root, z, x, y):
    with open(os.path.join(root, str(z), str(x), f"{y}.terrain"), "rb") as f:
        raw = f.read()
    if raw[:2] != b"\x1f\x8b":
        raise ValueError("tile is not gzip-compressed (terrain/nginx.conf sends Content-Encoding: gzip)")
    return qmesh.decode(gzip.decompress(raw))


def check_tile(t):
    n = t["u"].size
    tris = t["triangles"]
    problems = []
    if tris.size == 0:
        problems.append("no triangles")
    if tris.size and (tris.min() < 0 or tris.max() >= n):
        problems.append("triangle index out of range")
    for name, val in (("u", t["u"]), ("v", t["v"])):
        if val.min() < 0 or val.max() > qmesh.QMAX:
            problems.append(f"{name} out of range")
    exp = {"west": t["u"] == 0, "east": t["u"] == qmesh.QMAX, "south": t["v"] == 0, "north": t["v"] == qmesh.QMAX}
    for edge, mask in exp.items():
        if set(np.nonzero(mask)[0]) != set(t[edge].tolist()):
            problems.append(f"{edge} edge list incomplete")
    if tris.size:
        u, v = t["u"].astype(np.int64), t["v"].astype(np.int64)
        cross = (u[tris[:, 1]] - u[tris[:, 0]]) * (v[tris[:, 2]] - v[tris[:, 0]]) - \
                (v[tris[:, 1]] - v[tris[:, 0]]) * (u[tris[:, 2]] - u[tris[:, 0]])
        if (cross <= 0).any():
            problems.append(f"{int((cross <= 0).sum())} triangles not counter-clockwise")
    return problems


def interpolate(t, uq, vq):
    """Height at quantized (uq, vq) by barycentric interpolation; None if outside."""
    u = t["u"].astype(np.float64)
    v = t["v"].astype(np.float64)
    tri = t["triangles"]
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    det = (v[b] - v[c]) * (u[a] - u[c]) + (u[c] - u[b]) * (v[a] - v[c])
    l1 = ((v[b] - v[c]) * (uq - u[c]) + (u[c] - u[b]) * (vq - v[c])) / det
    l2 = ((v[c] - v[a]) * (uq - u[c]) + (u[a] - u[c]) * (vq - v[c])) / det
    l3 = 1 - l1 - l2
    eps = -1e-9
    inside = np.nonzero((l1 >= eps) & (l2 >= eps) & (l3 >= eps))[0]
    if inside.size == 0:
        return None
    i = inside[0]
    h = t["height"]
    return l1[i] * h[a[i]] + l2[i] * h[b[i]] + l3[i] * h[c[i]]


def main(argv=None, args=None):
    if args is None:
        args = build_parser().parse_args(argv)
    root = args.terrain_dir
    with open(os.path.join(root, "layer.json")) as f:
        layer = json.load(f)
    for key in ("format", "tiles", "available", "projection"):
        if key not in layer:
            sys.exit(f"FAIL: layer.json has no '{key}'")
    if not layer["format"].startswith("quantized-mesh-1."):
        sys.exit(f"FAIL: unexpected format {layer['format']}")
    if layer["projection"] != "EPSG:4326":
        sys.exit(f"FAIL: projection {layer['projection']} (Cesium quantized-mesh expects EPSG:4326)")
    avail = layer["available"]
    max_zoom = len(avail) - 1
    print(f"layer.json OK: {layer.get('name')}  levels 0..{max_zoom}  extensions={layer.get('extensions', [])}")

    total, bad, vcount, tcount = 0, 0, 0, 0
    for z, ranges in enumerate(avail):
        for r in ranges:
            for x in range(r["startX"], r["endX"] + 1):
                for y in range(r["startY"], r["endY"] + 1):
                    total += 1
                    try:
                        t = read_tile(root, z, x, y)
                        problems = check_tile(t)
                        vcount += t["u"].size
                        tcount += t["triangles"].shape[0]
                    except FileNotFoundError:
                        problems = ["missing"]
                    except Exception as e:  # noqa: BLE001
                        problems = [f"decode error: {e}"]
                    if problems:
                        bad += 1
                        if bad <= 20:
                            print(f"  FAIL {z}/{x}/{y}: {'; '.join(problems)}")
    print(f"tiles: {total} checked, {bad} with problems, avg {vcount / max(total, 1):.0f} vertices / "
          f"{tcount / max(total, 1):.0f} triangles per tile")

    if args.dem:
        ds = gdal.Open(args.dem)
        srs = ds.GetSpatialRef()
        wgs = osr.SpatialReference()
        wgs.ImportFromEPSG(4326)
        wgs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        to_src = osr.CoordinateTransformation(wgs, srs)
        gt = ds.GetGeoTransform()
        band = ds.GetRasterBand(1)
        nodata = band.GetNoDataValue()
        w, s, e, n = layer["bounds"]
        rnd = random.Random(1)
        diffs = []
        cache = {}
        size = 180.0 / (1 << max_zoom)
        tries = 0
        while len(diffs) < args.points and tries < args.points * 20:
            tries += 1
            lon, lat = rnd.uniform(w, e), rnd.uniform(s, n)
            sx, sy, _ = to_src.TransformPoint(lon, lat)
            px = (sx - gt[0]) / gt[1] - 0.5
            py = (sy - gt[3]) / gt[5] - 0.5
            i, j = int(math.floor(py)), int(math.floor(px))
            if i < 0 or j < 0 or i + 1 >= ds.RasterYSize or j + 1 >= ds.RasterXSize:
                continue
            win = band.ReadAsArray(j, i, 2, 2).astype(np.float64)
            if nodata is not None and (win == nodata).any():
                continue
            fy, fx = py - i, px - j
            ref = (win[0, 0] * (1 - fx) * (1 - fy) + win[0, 1] * fx * (1 - fy) +
                   win[1, 0] * (1 - fx) * fy + win[1, 1] * fx * fy)
            x = int((lon + 180.0) / size)
            y = int((lat + 90.0) / size)
            key = (x, y)
            if key not in cache:
                try:
                    cache[key] = read_tile(root, max_zoom, x, y)
                except FileNotFoundError:
                    continue
            tw, ts, te, tn = tile_bounds(max_zoom, x, y)
            h = interpolate(cache[key], (lon - tw) / (te - tw) * qmesh.QMAX, (lat - ts) / (tn - ts) * qmesh.QMAX)
            if h is not None:
                diffs.append(h - ref)
        d = np.abs(np.array(diffs))
        print(f"heights vs DEM at {d.size} random points (deepest level {max_zoom}): "
              f"mean |diff| {d.mean():.2f} m, RMS {np.sqrt((d ** 2).mean()):.2f} m, "
              f"95% {np.percentile(d, 95):.2f} m, max {d.max():.2f} m")
    if bad:
        sys.exit(1)
    print("OK")


def build_parser(p=None):
    p = p or argparse.ArgumentParser(prog="check-terrain", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("terrain_dir", help="folder with layer.json, e.g. data/terrain")
    p.add_argument("--dem", help="source DEM to compare heights against")
    p.add_argument("--points", type=int, default=2000, help="random points for --dem (default 2000)")
    return p


if __name__ == "__main__":
    main()
