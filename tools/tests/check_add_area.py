"""Checks for add_area_test.sh. Run from the folder that holds data/.

    python3 check_add_area.py snapshot SNAP.json        record a hash of every served file
    python3 check_add_area.py same SNAP.json            fail unless data/ matches the snapshot
    python3 check_add_area.py mbtiles                   after add-mbtiles (prefer existing)
    python3 check_add_area.py terrain existing|new      after add-terrain
    python3 check_add_area.py elevation existing|new    after add-elevation
    python3 check_add_area.py same-tiles A B [scaled]   two .mbtiles hold the same tiles (scaled: 256 px, close)
"""
import glob
import hashlib
import json
import math
import os
import random
import sqlite3
import sys

import numpy as np
from osgeo import gdal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_two_areas import NEW_BOX, NEW_OFFSET, landscape  # noqa: E402

from gcs_tools import check_terrain as ct, mbtiles, qmesh  # noqa: E402
from gcs_tools.terrain import tile_bounds  # noqa: E402

gdal.UseExceptions()
SERVED = ("data/mbtiles", "data/terrain", "data/elevation")


def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


def hashes():
    out = {}
    for top in SERVED:
        for root, _, files in os.walk(top):
            for f in files:
                p = os.path.join(root, f)
                if f == "summary.json":
                    continue
                with open(p, "rb") as fh:
                    out[p] = hashlib.sha256(fh.read()).hexdigest()
    return out


def old_box():
    with open(sorted(glob.glob("data/backups/*terrain/files/terrain/layer.json"))[0]) as f:
        return json.load(f)["bounds"]


def classify(lon, lat, ob, margin=0.025):
    """'old', 'new', 'overlap' or None (near an edge, or the old DEM's no-data hole)."""
    in_old = ob[0] + margin < lon < ob[2] - margin and ob[1] + margin < lat < ob[3] - margin
    near_old = ob[0] - margin < lon < ob[2] + margin and ob[1] - margin < lat < ob[3] + margin
    in_new = NEW_BOX[0] + 0.01 < lon < NEW_BOX[2] - 0.03 and NEW_BOX[1] + 0.01 < lat < NEW_BOX[3] - 0.01
    near_new = NEW_BOX[0] - 0.01 < lon < NEW_BOX[2] + 0.01 and NEW_BOX[1] - 0.01 < lat < NEW_BOX[3] + 0.01
    if in_old and lon < ob[0] + 0.12 and lat < ob[1] + 0.1:
        return None
    if in_old and in_new:
        return "overlap"
    if in_old and not near_new:
        return "old"
    if in_new and not near_old:
        return "new"
    return None


def score(groups, prefer):
    want = {"old": 0.0, "new": NEW_OFFSET, "overlap": 0.0 if prefer == "existing" else NEW_OFFSET}
    for g, diffs in groups.items():
        d = np.array(diffs)
        share = float(np.mean(np.abs(d - want[g]) < 15))
        print(f"  {g:8s} {d.size:5d} points: {100 * share:5.1f}% from the expected DEM")
        if d.size < 20 or share < 0.99:
            fail(f"{g}: heights don't come from the expected DEM")


def check_mbtiles():
    old = sorted(glob.glob("data/backups/*mbtiles/files/mbtiles/custom.mbtiles"))[-1]
    q = "SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles"
    a = {r[:3]: bytes(r[3]) for r in sqlite3.connect(old).execute(q)}
    b = {r[:3]: bytes(r[3]) for r in sqlite3.connect("data/mbtiles/custom.mbtiles").execute(q)}
    if any(k not in b for k in a):
        fail("tiles of the old file are missing")
    changed = [k for k in a if a[k] != b[k]]
    worst = 0
    for k in changed:
        oa, nb = mbtiles._decode_rgba(a[k]).astype(int), mbtiles._decode_rgba(b[k]).astype(int)
        m = oa[3] == 255
        if m.any():
            worst = max(worst, int(np.abs(oa[:3, m] - nb[:3, m]).max()))
    print(f"  {len(a)} old tiles: {len(a) - len(changed)} untouched, {len(changed)} combined; {len(b) - len(a)} added; "
          f"largest change of an old opaque pixel: {worst}")
    if worst:
        fail("old opaque pixels changed")
    if len(b) <= len(a):
        fail("nothing was added")


def check_terrain(prefer):
    root = "data/terrain"
    with open(os.path.join(root, "layer.json")) as f:
        layer = json.load(f)
    avail = layer["available"]

    def height(lon, lat):
        for z in range(len(avail) - 1, -1, -1):
            size = 180.0 / (1 << z)
            x, y = int((lon + 180) / size), int((lat + 90) / size)
            if any(r["startX"] <= x <= r["endX"] and r["startY"] <= y <= r["endY"] for r in avail[z]):
                t = ct.read_tile(root, z, x, y)
                w, s, e, n = tile_bounds(z, x, y)
                return ct.interpolate(t, (lon - w) / (e - w) * qmesh.QMAX, (lat - s) / (n - s) * qmesh.QMAX)
        return None

    ob = old_box()
    rnd = random.Random(3)
    groups = {"old": [], "new": [], "overlap": []}
    for _ in range(4000):
        lon, lat = rnd.uniform(ob[0], NEW_BOX[2]), rnd.uniform(ob[1], NEW_BOX[3])
        g = classify(lon, lat, ob)
        h = height(lon, lat) if g else None
        if h is not None:
            groups[g].append(h - float(landscape(np.array(lon), np.array(lat))))
    score(groups, prefer)


def check_elevation(prefer):
    pieces = []
    for p in sorted(glob.glob("data/elevation/*.tif")):
        ds = gdal.Open(p)
        gt = ds.GetGeoTransform()
        pieces.append((p, gt, ds.RasterXSize, ds.RasterYSize, ds.GetRasterBand(1).GetNoDataValue()))
    # previous versions of changed pieces: valid heights must be the same
    for p in sorted(glob.glob("data/backups/*elevation/files/elevation/*.tif")):
        cur = os.path.join("data/elevation", os.path.basename(p))
        if not os.path.exists(cur):
            continue
        da, db = gdal.Open(p), gdal.Open(cur)
        a, b = da.ReadAsArray(), db.ReadAsArray()
        nd = da.GetRasterBand(1).GetNoDataValue()
        valid = a != (nd if nd is not None else -32768)
        if a.shape == b.shape and not (a[valid] == b[valid]).all():
            fail(f"{os.path.basename(p)}: valid heights changed")

    def lookup(lat, lon):
        hits = []
        for p, gt, xs, ys, nd in pieces:
            px, py = math.floor((lon - gt[0]) / gt[1]), math.floor((lat - gt[3]) / gt[5])
            if 0 <= px < xs and 0 <= py < ys:
                ds = gdal.Open(p)
                v = float(ds.GetRasterBand(1).ReadAsArray(px, py, 1, 1)[0, 0])
                hits.append(None if v == -32768 or v == nd else v)
        return hits

    ob = old_box()
    rnd = random.Random(5)
    groups = {"old": [], "new": [], "overlap": []}
    gaps = doubles = 0
    for _ in range(1500):
        lon, lat = rnd.uniform(ob[0], NEW_BOX[2]), rnd.uniform(ob[1], NEW_BOX[3])
        g = classify(lon, lat, ob)
        if not g:
            continue
        hits = lookup(lat, lon)
        gaps += not hits
        doubles += len(hits) > 1
        if hits and hits[0] is not None:
            groups[g].append(hits[0] - float(landscape(np.array(lon), np.array(lat))))
    print(f"  points in no piece: {gaps}, in two or more pieces: {doubles}")
    if gaps or doubles:
        fail("pieces leave gaps or overlap")
    score(groups, prefer)


def same_tiles(a_path, b_path, scaled):
    q = "SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles ORDER BY 1, 2, 3"
    a = sqlite3.connect(a_path).execute(q).fetchall()
    b = sqlite3.connect(b_path).execute(q).fetchall()
    if not scaled:
        print(f"  {len(b)} tiles, identical to the result from the folder: {a == b}")
        if a != b:
            fail("different result")
        return
    ka, kb = {r[:3]: bytes(r[3]) for r in a}, {r[:3]: bytes(r[3]) for r in b}
    if set(ka) != set(kb):
        fail("different tiles")
    worst, sizes = 0.0, set()
    for k in ka:
        x, y = mbtiles._decode_rgba(ka[k]).astype(int), mbtiles._decode_rgba(kb[k]).astype(int)
        sizes.add(y.shape[1])
        worst = max(worst, float(np.abs(x - y).mean()))
    print(f"  {len(kb)} tiles, sizes {sorted(sizes)}, worst mean pixel difference {worst:.2f}")
    if sizes != {256} or worst > 2:
        fail("512 px tiles were not scaled to the file's 256 px")


def main():
    what = sys.argv[1]
    if what == "same-tiles":
        same_tiles(sys.argv[2], sys.argv[3], len(sys.argv) > 4)
        print("  ok")
        return
    if what == "snapshot":
        with open(sys.argv[2], "w") as f:
            json.dump(hashes(), f)
    elif what == "same":
        with open(sys.argv[2]) as f:
            snap = json.load(f)
        now = hashes()
        diff = sorted(set(snap) ^ set(now)) + sorted(p for p in snap if p in now and snap[p] != now[p])
        print(f"  {len(snap)} files, {len(diff)} differ from the snapshot")
        if diff:
            fail("not restored exactly: " + ", ".join(diff[:5]))
    elif what == "mbtiles":
        check_mbtiles()
    elif what == "terrain":
        check_terrain(sys.argv[2])
    elif what == "elevation":
        check_elevation(sys.argv[2])
    print("  ok")


if __name__ == "__main__":
    main()
