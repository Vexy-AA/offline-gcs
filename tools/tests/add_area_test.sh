#!/usr/bin/env bash
# End-to-end test of the add-* commands on two overlapping synthetic areas.
#
#   docker compose run --rm --entrypoint bash tools /opt/gcs-tools/tests/add_area_test.sh
#   # or natively, from the tools/ folder:  bash tests/add_area_test.sh
#
# 1. builds an "old" area the normal way (terrain, elevation pieces, map tiles), then
#    deletes its source files, as on a machine where only the served data is left
# 2. adds a "new" area that overlaps it (a z/x/y tile folder and a DEM 40 m higher than
#    the old one, so every height read back tells which DEM it came from)
# 3. checks that untouched data is byte-identical, the overlap follows --prefer, and
#    the new area is served; then restores everything and checks it is exactly as before
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="${PYTHONPATH:-$(dirname "$here")}"
py="${PYTHON:-python3}"
work="$(mktemp -d "${TMPDIR:-/tmp}/gcs-add.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cd "$work"
mkdir -p data/src data/mbtiles data/terrain data/elevation
gt() { "$py" -m gcs_tools "$@"; }
check() { "$py" "$here/check_add_area.py" "$@"; }
newest() { ls data/backups | grep "$1" | tail -1; }

echo "== two overlapping synthetic areas"
"$py" "$here/make_two_areas.py" data/src

echo "== old area, built the normal way"
gt terrain data/src/old.tif data/terrain --workers 2 > /dev/null
gt elevation data/src/old.tif --out data/elevation --piece-size 500 > /dev/null
gt mbtiles data/src/old_rgb.tif data/mbtiles/custom.mbtiles --workers 2 > /dev/null
gt mbtiles data/src/new_rgb.tif new.mbtiles --workers 2 --max-zoom 13 > /dev/null
"$py" - <<'EOF'
import os, sqlite3
for z, x, row, data in sqlite3.connect("new.mbtiles").execute(
        "SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles WHERE zoom_level >= 9"):
    d = f"data/src/NorthXYZ/{z}/{x}"
    os.makedirs(d, exist_ok=True)
    ext = "jpg" if data[:2] == b"\xff\xd8" else "png"
    open(f"{d}/{(1 << z) - 1 - row}.{ext}", "wb").write(data)
EOF
rm -f new.mbtiles data/src/old.tif data/src/old_rgb.tif data/src/new_rgb.tif
check snapshot before.json

echo "== dry runs change nothing"
gt add-mbtiles data/src/NorthXYZ data/mbtiles/custom.mbtiles --dry-run > /dev/null
gt add-terrain data/src/new.tif data/terrain --dry-run > /dev/null
gt add-elevation data/src/new.tif --out data/elevation --dry-run > /dev/null
check same before.json

echo "== add, keeping the existing data in the overlap"
gt add-mbtiles data/src/NorthXYZ data/mbtiles/custom.mbtiles --workers 2 | tail -n 3
check mbtiles
cp data/mbtiles/custom.mbtiles from_folder.mbtiles
gt add-terrain data/src/new.tif data/terrain --workers 2 | tail -n 3
gt check-terrain data/terrain | tail -n 1
check terrain existing
gt add-elevation data/src/new.tif --out data/elevation --piece-size 300 | tail -n 3
check elevation existing

echo "== restore everything: exactly as before"
gt backups --data data
gt backups restore "$(newest terrain)" --data data
gt backups restore "$(newest elevation)" --data data
gt backups restore "$(newest mbtiles)" --data data
check same before.json

echo "== the same imagery as .mbtiles (in the layouts tools write) gives the same result"
gt mbtiles data/src/NorthXYZ north.mbtiles > /dev/null
"$py" "$here/make_tile_variants.py" north.mbtiles variants > /dev/null
for v in std.mbtiles xyzrows.mbtiles dedup.mbtiles TmsFolder retina.mbtiles sasplanet.mbtiles orux.mbtiles "odd #name.mbtiles"; do
  echo "-- $v"
  gt add-mbtiles "variants/$v" data/mbtiles/custom.mbtiles --workers 2 | grep -E "rows read|scaled" || true
  if [[ $v == retina.mbtiles ]]; then check same-tiles from_folder.mbtiles data/mbtiles/custom.mbtiles scaled
  else check same-tiles from_folder.mbtiles data/mbtiles/custom.mbtiles; fi
  gt backups restore "$(newest mbtiles)" --data data > /dev/null
done
if ls variants | grep -qx "odd "; then echo "FAIL: a '#' in the name opened (and created) another file"; exit 1; fi
echo "-- inspect says why a file can't be used"
expect() {  # expect <file> <usable|not> <words in the report>
  local out code=0
  out=$(gt inspect "variants/$1" --target data/mbtiles/custom.mbtiles 2>&1) || code=$?
  if [[ $2 == usable && $code != 0 ]] || [[ $2 == not && $code == 0 ]] || ! grep -q "$3" <<<"$out"; then
    echo "FAIL: inspect $1"; echo "$out"; exit 1
  fi
  echo "  $1: $(grep RESULT <<<"$out")"
}
expect std.mbtiles usable "37% of it lies inside custom.mbtiles"
expect sasplanet.mbtiles usable "17 - zoom"
expect broken-halfcopied.mbtiles not "cut short"
expect broken-html.mbtiles not "HTML page"
expect broken-empty.mbtiles not "empty (0 bytes)"
expect broken-notiles.mbtiles not "no 'tiles' table"
expect vector.mbtiles not "vector tiles"
expect damaged-index.mbtiles not "is damaged"
echo "-- a damaged file: the merge stops cleanly, repair saves the tiles"
if gt add-mbtiles variants/damaged-table.mbtiles data/mbtiles/custom.mbtiles > damaged.log 2>&1; then
  echo "FAIL: a damaged file was merged"; exit 1
fi
grep -q "Nothing was changed" damaged.log && ! grep -q Traceback damaged.log || { cat damaged.log; exit 1; }
check same before.json
gt repair variants/damaged-index.mbtiles | grep -E "rows read|RESULT"
gt add-mbtiles variants/damaged-index-repaired.mbtiles data/mbtiles/custom.mbtiles --workers 2 > /dev/null
check same-tiles from_folder.mbtiles data/mbtiles/custom.mbtiles
gt backups restore "$(newest mbtiles)" --data data > /dev/null
gt repair variants/damaged-table.mbtiles | grep -E "rows read|RESULT"
expect damaged-table-repaired.mbtiles usable "tiles at zoom"
gt repair variants/broken-halfcopied.mbtiles | grep -E "cut short|RESULT"
expect broken-halfcopied-repaired.mbtiles usable "tiles at zoom"
echo "-- vector.mbtiles is refused"
if gt add-mbtiles variants/vector.mbtiles data/mbtiles/custom.mbtiles > vector.log 2>&1; then
  echo "FAIL: vector tiles were accepted"; exit 1
fi
grep ERROR vector.log
check same before.json

echo "== add, letting the new data win in the overlap"
gt add-terrain data/src/new.tif data/terrain --workers 2 --prefer new | tail -n 2
check terrain new
gt add-elevation data/src/new.tif --out data/elevation --piece-size 300 --prefer new | tail -n 3
check elevation new
gt backups restore "$(newest elevation)" --data data > /dev/null
gt backups restore "$(newest terrain)" --data data > /dev/null
check same before.json

echo "== terrain from the old tiles alone (no elevation pieces)"
gt add-terrain data/src/new.tif data/terrain --workers 2 --elevation-dir none | tail -n 2
check terrain existing
gt backups restore "$(newest terrain)" --data data > /dev/null
check same before.json

echo "ADD-AREA TEST PASSED"
