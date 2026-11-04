# Front page and data tools

One Docker image (the `tools` service in `docker-compose.yml`) runs the stack's
front page and the converters that turn source rasters into what the servers
serve. Nothing needs installing on the host.

## Web pages

The `tools` service is always on and publishes port 80 (`GCS_HTTP_PORT` in `.env` to change it).

| Page | What it does |
|------|--------------|
| `/` front page | Buttons for every app, each showing whether its server answers. |
| `/tools` data tools | Diagram of the stack with live status; **Build data** runs the converters below and streams their log (cancel, recent jobs, the matching `./gcs-tools` command); **Add area** merges a new region into the existing tiles, terrain and elevation pieces, with a map of both areas, a dry run and restore points (see [Adding an area](#adding-an-area)); **Files** uploads to `data/src`, unpacks tile zips, and says what each raster is good for; **Health** is the full check (`check` below) with server logs and restart buttons. |
| `/elevation` | Elevation viewer: your imagery as the map, outlines of the elevation pieces and the terrain area, click for a height, draw a line for its profile, or shade an area by height. |
| `/log-splitter` | The DataFlash log splitter (`static/apps/log-splitter.html`): works on the file in your browser, nothing is uploaded. |
| `/log-plotter` | The DataFlash log plotter (`static/apps/log-plotter.html`, source in `tools/apps/log-plotter`): plot any logged value, formulas, spectra, and the flight in 3D. Works on the file in your browser, nothing is uploaded. Its 3D map and terrain default to this station's own (every `.mbtiles` is a Map choice), through `/tiles/<set>/{z}/{x}/{y}.png` and `/quantized/` on this server. |

Jobs run one at a time, as the owner of the `data` folder (so files aren't
root-owned). Links like `/tools#build=terrain`, `/tools#add`, `/tools#files` and
`/tools#health` open a tab directly. The page reaches the servers by their
compose names (`mbtiles`, `terrain`, ...). The Docker socket, if mounted, adds
container status, logs and restarts.

## Commands

| Command         | Input                                   | Output                          | Served by         |
|-----------------|-----------------------------------------|---------------------------------|-------------------|
| `mbtiles`       | imagery raster(s), or a `{z}/{x}/{y}` tile folder | `data/mbtiles/<name>.mbtiles` | mbtileserver :8000 |
| `terrain`       | DEM raster(s), any size, any CRS        | `data/terrain/layer.json` + `{z}/{x}/{y}.terrain` | nginx :8011 |
| `elevation`     | DEM raster(s)                           | `data/elevation/<name>_<x>_<y>.tif` | open-elevation :8082 |
| `add-mbtiles`   | tile folder, .mbtiles or imagery raster(s) | adds to an existing `.mbtiles` | mbtileserver :8000 |
| `add-terrain`   | DEM raster(s) of a new area             | adds to `data/terrain`          | nginx :8011       |
| `add-elevation` | DEM raster(s) of a new area             | adds pieces to `data/elevation` | open-elevation :8082 |
| `backups`       | restore points in `data/backups`        | list / restore / delete         |                   |
| `inspect`       | a tile file or tile folder              | step-by-step report: can it be added, and if not why | |
| `repair`        | a damaged tile file                     | `<name>-repaired.mbtiles` with every readable tile | |
| `check-terrain` | a terrain folder (+ optionally the DEM) | report                          |                   |
| `check`         | the running stack                       | report (exit code 1 on failure) |                   |
| `serve`         |                                         | the web pages above             |                   |

## Running

```bash
./gcs-tools <command> [args]          # wrapper, Linux/macOS
./gcs-tools terrain --help            # options of one command
```

The wrapper runs `docker compose run --rm tools ...` with the current folder and
the folders of any input files mounted at the same paths. So host paths work as
they are, and outputs must go inside this repo (normally under `data/`).
Files are created as your user. The image is built on first use; to build it
explicitly: `docker compose build tools`.

Without the wrapper (e.g. on Windows), put inputs under `data/src/` and use the
paths as the container sees them (`./data` is `/data`):

```bash
docker compose run --rm tools terrain /data/src/dem.tif /data/terrain
```

**Offline machine:** build the image where there is internet, then move it:

```bash
docker save offline-gcs-tools:1.2.0 | gzip > gcs-tools-image.tar.gz   # connected machine
docker load < gcs-tools-image.tar.gz                                   # offline machine
```

## mbtiles: imagery to MBTiles

```bash
./gcs-tools mbtiles ~/maps/ortho.tif data/mbtiles/custom.mbtiles
./gcs-tools mbtiles ~/maps/a.tif ~/maps/b.tif data/mbtiles/custom.mbtiles   # mosaic
./gcs-tools mbtiles ~/sasplanet/export/ data/mbtiles/custom.mbtiles         # tile folder
docker compose restart mbtiles
```

- The file name is the tile set id: the logviewer's *Local Imagery* layer reads
  `/services/custom/tiles/...`, so it needs `custom.mbtiles`. Other names show
  up at `http://<host>:8000/services`.
- Raster input: any GDAL format and CRS, 8-bit gray/RGB/RGBA or paletted. It is
  reprojected to Web Mercator, cut at the max zoom (default: the zoom closest to
  the image resolution, `--max-zoom` to override), and every lower zoom down to
  `--min-zoom` (default 0) is built from it.
- `--format auto` (default) writes JPEG tiles, except tiles that contain
  transparent pixels (image edges, irregular drone orthophotos), which stay PNG
  so they are not black around the image. `jpeg`, `png`, `png8`, `webp` force one
  format. mbtileserver ignores the `.png` in the URL and serves the real type.
- Tile folder input is packed as-is. Rows are read as XYZ (OSM/Google);
  use `--scheme tms` for TMS folders.
- The logviewer requests zoom levels up to 17. If the imagery stops lower, say
  at 14, mbtileserver answers 404 for 15-17 (the `--missing-image-tile-404` flag
  in `docker-compose.yml`) and Cesium enlarges the zoom-14 tiles instead of
  showing nothing.
- The file is built in `data/.work/` and moved into `data/mbtiles` when it is complete, so
  mbtileserver (with `ENABLE_FS_WATCH`) loads it straight away and never sees a half-written file.
  Without fs-watch, restart mbtiles.
- A zip of a tile folder: unpack it on the tools page (**Files**, Unpack), then build from the folder.

## terrain: DEM to Cesium quantized-mesh

```bash
./gcs-tools terrain ~/dem/crimea.tif data/terrain --clean
./gcs-tools check-terrain data/terrain --dem ~/dem/crimea.tif
```

No restart is needed (static files). Hard-refresh the browser.

What it does:

1. Several inputs are mosaicked. Anything not in EPSG:4326 is reprojected once
   into a work folder (`data/.work/terrain`, removed at the end). Overviews are
   built there too, so low zoom levels read a few pixels instead of the whole
   DEM. The source file is never modified.
2. Each tile is sampled on a 257 x 257 grid whose outer rows and columns lie
   exactly on the tile edges, so neighbouring tiles share their edge heights.
   The grid is triangulated with Delatin to a maximum error and encoded as
   quantized-mesh 1.0 with vertex normals, gzip-compressed.
3. `layer.json` lists exactly which tiles exist, so Cesium never asks for
   missing ones and refines from the parent tile outside the DEM.

The layout and tiling are what cesium-terrain-builder produces (geographic
EPSG:4326 grid, TMS rows, two tiles at level 0, gzip `.terrain`), so
`terrain/nginx.conf` serves it unchanged.

Detail and accuracy:

- **Levels**: 0 up to the zoom whose grid spacing is closest to the DEM pixel
  size (30 m DEM: z11, 38 m spacing). Override with `--max-zoom`.
- **Error**: levels above the deepest use Cesium's own geometric-error estimate
  for that level, like cesium-terrain-builder. The deepest level is what you
  see whenever you are zoomed in close, so it gets a quarter of that: 9.4 m at
  z11, 4.7 m at z12, 2.4 m at z13. Use `--max-zoom-error 2` for a fixed value in
  metres, `--quality 0.5` for denser meshes at every level.
- Large, flat tiles get extra vertices so they follow the Earth's curvature
  instead of cutting through it.
- **No-data** areas and everything outside the DEM get `--fill` metres (0).
- **Heights** are written as stored in the DEM (normally metres above mean sea
  level), as cesium-terrain-builder does.

Other options: `--bounds W S E N` to cut out an area, `--workers N` (default
all CPUs), `--resume` to continue an interrupted run, `--no-normals`,
`--nodata VALUE` when the file doesn't declare it.

Speed: about 45-50 tiles per second per CPU core. A 30 m DEM covering
2.2 x 2.2 degrees (8000 x 8000 px) is about 1000 tiles: 14 s on 2 cores.

Cancel (on the page, Ctrl+C or `docker stop`) stops cleanly; build again with
`--resume` (**Continue an interrupted build** on the page) to keep the tiles already written.

`check-terrain` reads every tile listed in `layer.json`, checks it decodes and
that edges and winding are valid, and with `--dem` compares interpolated heights
with the DEM at random points.

## elevation: DEM to open-elevation pieces

```bash
./gcs-tools elevation ~/dem/crimea.tif
docker compose restart elevation
```

This runs open-elevation's own `create-tiles.sh` (from the `open-elevation`
submodule), with these additions:

- any GDAL-readable input; non-EPSG:4326 sources are reprojected, because the
  server indexes pieces by their corner coordinates as lat/lon
- the big source file stays where it is (keep it outside `data/elevation`)
- pieces of about 2000 x 2000 px by default (`--piece-size`, or `--tiles X Y`)
- deletes the stale `summary.json` so the server re-indexes on restart

## Adding an area

The build commands above *replace* their output. To put a second region next to (or
partly over) the first one without rebuilding it, and without the first one's source
files, use the `add-*` commands, or the **Add area** tab on the tools page, which runs
them for you (map tiles, then terrain, then elevation) and shows both areas on a map.

```bash
./gcs-tools add-mbtiles   data/src/NorthXYZ     data/mbtiles/custom.mbtiles   # a z/x/y folder
./gcs-tools add-mbtiles   data/src/north.mbtiles data/mbtiles/custom.mbtiles  # or an .mbtiles
./gcs-tools add-terrain   data/src/northBig.tif data/terrain
./gcs-tools add-elevation data/src/northBig.tif           # then: docker compose restart elevation
./gcs-tools backups                                        # restore points; backups restore <id> undoes one
```

Each takes `--dry-run` (report only) and `--prefer existing|new`, the rule for the overlap:

| | `--prefer existing` (default) | `--prefer new` |
|---|---|---|
| **Map tiles** | Old pixels stay on top; the new tile shows only through their transparent parts. Opaque (JPEG) old tiles are kept as they are. | New pixels on top; old ones show through the new tiles' transparent parts. |
| **Terrain** | Old heights win; the new DEM fills only where the old one had none. | The new DEM wins wherever it has data. |
| **Elevation** | New pieces only where no piece exists. No-data holes of old pieces under the new DEM are filled (`--no-fill-holes` to skip); valid heights never change. | Old pieces under the new DEM are removed, or cropped (pixel copies) where they stick out of it; old heights are copied into the new DEM's no-data holes. |

What happens in each case:

- **The new imagery** can be a `{z}/{x}/{y}` folder, a tile file, an imagery GeoTIFF, or (on
  the page) another tile set already in `data/mbtiles`. Tile files are recognised by their
  tables, whatever the extension: MBTiles (also deduplicated), RMaps/OsmAnd `.sqlitedb`
  (what SAS.Planet exports as "SQLite3", zoom stored as 17 - zoom) and OruxMaps. A tile file
  one folder down in `data/src` is listed too. All of them are read the same way and give
  the same result:
  - *Row order* (`--scheme auto|xyz|tms`, **Tile rows** on the page). `auto`: a folder is
    XYZ (Google, OSM, SAS.Planet) unless it holds gdal2tiles' `tilemapresource.xml` (TMS);
    an `.mbtiles` is TMS, as the standard says, unless its metadata has `scheme=xyz` or its
    `bounds` only match its tiles read top-down (some exporters write XYZ rows). The run
    prints which order it used, and warns when the other order would put the area over the
    existing one. On the page the outline on the map moves when you change it.
  - 512 px tiles are scaled to the file's tile size (256 px) instead of being mixed in.
  - Deduplicated `.mbtiles` (`map` + `images` tables) work as they are.
  - Vector `.mbtiles` (`format=pbf`) are refused: the log viewer needs images.
- **add-mbtiles** copies the file to `data/.work`, adds the tiles it doesn't have, and
  combines tiles both have (alpha compositing; PNG output whenever a PNG went in, so old
  pixels come out exactly as they were). If the new tiles start at a deeper zoom than the
  file (a tile folder with zoom 12-17, say), the zoomed-out levels are built for the new
  area and merged too (`--no-lower-zooms` to skip). The copy is checked
  (`PRAGMA quick_check`) and swapped in with one rename; mbtileserver reloads it by itself.
  A raster source is cut into tiles first, exactly as `mbtiles` does.
- **add-terrain** remakes only the tiles that touch the new DEM (and, deeper than the new
  DEM's last level, only the old tiles it reaches into). The other tiles stay byte-for-byte
  as they are. Those border and zoomed-out tiles need the *old* heights too: they come from
  the elevation pieces (cut from the same old DEM, so they are the old DEM), and where no
  piece covers a spot of the old terrain area, from decoding the old terrain tiles
  (accurate to their mesh error). Pieces that `add-elevation` added are ignored, so the
  order of the two commands doesn't matter. An existing tile whose heights would not change
  is not rewritten. `layer.json` lists both areas and gets a new `version`, so browsers fetch
  the changed tiles.
- **add-elevation** keeps pieces from overlapping. open-elevation answers a point from the
  first piece whose box contains it, in folder-listing order, so overlapping pieces would
  give answers from either file at random. Areas are cut in whole pixels; a piece may reach
  less than a pixel into its neighbour but never leaves a gap.

**Restore points.** Every change first writes `data/backups/<id>/manifest.json` (what it is
about to add, replace or remove) and keeps the previous version of every replaced file
there, by hard link where possible, so a restore point of a big `.mbtiles` costs no extra
space until the file is replaced. `./gcs-tools backups restore <id>` (or **Restore** on the
page) puts the old files back exactly and removes the added ones; changes to the same data
are undone newest first. `backups delete <id>` drops a restore point and frees its space.
Nothing in `data/backups` or `data/.work` is served.

Disk space: `add-mbtiles` needs room for a copy of the file plus the new tiles; the others
need about the size of what they write. Each run checks first.

**Elevation server.** A patch to the `open-elevation` submodule (branch `expandable-regions`)
makes it pick among overlapping pieces deterministically (finest resolution first, falling
through to the next piece on no-data) and answer 0 outside every piece. Before, a point
outside all pieces read a pixel through a wrapped-around array index and came back with a
height from somewhere else. The `add-*` tools don't need the patch, but it is worth having.

## inspect: why can't a tile file be used?

```bash
./gcs-tools inspect data/src/north.mbtiles --target data/mbtiles/custom.mbtiles
./gcs-tools inspect data/src/north.mbtiles --deep        # also reads the whole file for damage
```

On the page: **Check** next to the file on the Files tab, or **Check it** under the Imagery
list on the Add area tab (files that can't be used are listed there with the reason). It
goes through the file step by step (SQLite header, layout, index, metadata, tiles per zoom,
image types, tile size, row order, where the area lies) and ends with `RESULT: usable` or
`RESULT: not usable: <why and what to do>`. Typical reasons: a half-copied file (copy it
again), an HTML page saved as .mbtiles (a failed download), vector tiles, an SQLite file
with tables this tool doesn't know.

## repair: save the tiles of a damaged file

A file that reports `database disk image is malformed` is damaged. `inspect` says which of
two things happened, because an SQLite file records its own size in its header:

- **cut short** (`X of the Y its header says it has`): the copy or download did not finish.
  Copy it again and compare the size.
- **full size**: it was copied while the program that made it was still writing, or the
  export or the disk is bad. Close that program, copy it again, compare a checksum
  (`sha256sum` on Linux, `certutil -hashfile <file> SHA256` on Windows).

If a good copy can't be had:

```bash
./gcs-tools repair data/src/north.mbtiles        # -> data/src/north-repaired.mbtiles
```

On the page: **Make a repaired copy** in the Check dialog, or next to the file under the
Imagery list. The original is only read. The tiles are read straight from the table, not
through the index (a damaged index is the most common case, and then every tile is saved);
around damaged pages the rows are read in smaller and smaller batches, so only rows that
really can't be read are lost. The copy is plain MBTiles (RMaps/OsmAnd/OruxMaps files come
out as MBTiles too), checked with `PRAGMA quick_check`, and listed under Imagery straight
away. About 6 s per GB on an SSD.

## check: is everything working?

```bash
./gcs-tools check                 # from the repo folder; exit code 1 if something fails
./gcs-tools check --json          # machine-readable
python3 -m gcs_tools check --host localhost   # without Docker, through the published ports
```

| Server | What is checked |
|--------|-----------------|
| Map tiles | tile sets loaded vs `.mbtiles` on disk; a real tile from the middle of each set; the preview map page; missing tiles answer 404; a `custom` set exists |
| Terrain | `layer.json`; level-0 and deepest tiles are gzip, sent with `Content-Encoding: gzip`, and decode with real heights |
| Elevation | `.tif` files vs what the server indexed; a height from each piece compared with reading the file directly; a carpet query |
| Log viewer | the app page and its `/tiles/`, `/quantized/` and `/extensionv2/` proxies |
| WebTools | the page and a file from its submodules |
| Containers | state and restart count of every compose service (needs the Docker socket) |

## Repeatability

- The image is pinned: Ubuntu 24.04 release packages (GDAL 3.8.4, numpy 1.26.4)
  and a hash-pinned `pydelatin` wheel.
- Terrain output is byte-identical for the same inputs and options. Only
  `layer.json`'s `version` changes per run (it busts browser caches); pass
  `--version 1.0.0` to fix it.
- Self-test on a synthetic DEM, no data needed:

  ```bash
  docker compose run --rm --entrypoint bash tools /opt/gcs-tools/tests/smoke_test.sh
  docker compose run --rm --entrypoint bash tools /opt/gcs-tools/tests/add_area_test.sh
  ```

  `add_area_test.sh` builds an old area, deletes its sources, adds an overlapping new one
  (40 m higher, so every height read back tells which DEM it came from) with both
  `--prefer` rules, checks what is served, and checks every restore gives back the exact
  files. It also adds the same imagery as `.mbtiles` in the layouts other tools write
  (standard, XYZ rows, deduplicated, 512 px, a gdal2tiles TMS folder) and checks each gives
  the same file as the folder, and that a vector `.mbtiles` is refused.

Without Docker: install GDAL's Python bindings and `pip install pydelatin==0.4.0`,
then run `PYTHONPATH=tools python3 -m gcs_tools <command> ...`.
