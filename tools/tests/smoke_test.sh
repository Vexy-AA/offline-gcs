#!/usr/bin/env bash
# End-to-end self-test of the tools on a synthetic DEM (no real data needed).
#
#   docker compose run --rm --entrypoint bash tools /opt/gcs-tools/tests/smoke_test.sh
#   # or natively, from the tools/ folder:  bash tests/smoke_test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="${PYTHONPATH:-$(dirname "$here")}"
py="${PYTHON:-python3}"
work="$(mktemp -d "${TMPDIR:-/tmp}/gcs-smoke.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cd "$work"

echo "== synthetic DEM (UTM 36N, 1500x1500 px @ 30 m, with a no-data hole)"
"$py" "$here/make_synthetic_dem.py" dem.tif 1500 30

echo "== terrain"
"$py" -m gcs_tools terrain dem.tif out/terrain --workers 2 --version 1.0.0 | tail -n 3
"$py" -m gcs_tools check-terrain out/terrain --dem dem.tif --points 500

echo "== terrain output is deterministic"
"$py" -m gcs_tools terrain dem.tif out/terrain2 --workers 2 --version 1.0.0 > /dev/null
diff -r out/terrain out/terrain2 > /dev/null && echo "identical"

echo "== mbtiles from a shaded-relief image"
gdaldem hillshade -q dem.tif shade.tif
gdal_translate -q -b 1 -b 1 -b 1 -colorinterp red,green,blue shade.tif shade_rgb.tif
"$py" -m gcs_tools mbtiles shade_rgb.tif out/mbtiles/test.mbtiles --workers 2 | tail -n 3

echo "== mbtiles from a {z}/{x}/{y} folder"
"$py" - <<'EOF'
import os, sqlite3
db = sqlite3.connect("out/mbtiles/test.mbtiles")
for z, x, row, data in db.execute("SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles"):
    d = f"xyz/{z}/{x}"
    os.makedirs(d, exist_ok=True)
    ext = "jpg" if data[:2] == b"\xff\xd8" else "png"
    open(f"{d}/{(1 << z) - 1 - row}.{ext}", "wb").write(data)
EOF
"$py" -m gcs_tools mbtiles xyz out/mbtiles/fromdir.mbtiles | tail -n 2
"$py" - <<'EOF'
import sqlite3
q = "SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles ORDER BY 1, 2, 3"
a = sqlite3.connect("out/mbtiles/test.mbtiles").execute(q).fetchall()
b = sqlite3.connect("out/mbtiles/fromdir.mbtiles").execute(q).fetchall()
assert a == b, "tile folder round trip differs"
print("round trip identical:", len(a), "tiles")
EOF

if [[ -n "${OPEN_ELEVATION_TILES_SCRIPT:-}" && -f "${OPEN_ELEVATION_TILES_SCRIPT}" ]] || [[ -f "$here/../../open-elevation/create-tiles.sh" ]]; then
  echo "== elevation pieces (open-elevation/create-tiles.sh)"
  mkdir -p out/elevation
  "$py" -m gcs_tools elevation dem.tif --out out/elevation --piece-size 800 | tail -n 3
  ls out/elevation | head
else
  echo "== elevation: skipped (open-elevation/create-tiles.sh not available)"
fi

plotter="$here/../apps/log-plotter"
if [[ -f "$plotter/build.py" ]]; then
  echo "== log plotter page matches its source"
  "$py" -I "$plotter/build.py" --host-script /log-plotter/config.js --out "$work/plotter" > /dev/null
  cmp "$work/plotter/dataflash-log-plotter.html" "$here/../gcs_tools/static/apps/log-plotter.html" && echo "identical"
fi

echo "SMOKE TEST PASSED"
