# Front page and data tools

One Docker image (the `tools` service in `docker-compose.yml`) runs the stack's
front page and the converters that turn source rasters into what the servers
serve. Nothing needs installing on the host.

## Web pages

The `tools` service is always on and publishes port 80 (`GCS_HTTP_PORT` in `.env` to change it).

| Page | What it does |
|------|--------------|
| `/` front page | Buttons for every app, each showing whether its server answers. |
| `/tools` data tools | Diagram of the stack with live status; **Build data** runs the converters below and streams their log (cancel, recent jobs, the matching `./gcs-tools` command); **Files** uploads to `data/src`, unpacks tile zips, and says what each raster is good for; **Health** is the full check (`check` below) with server logs and restart buttons. |
| `/elevation` | Elevation viewer: your imagery as the map, outlines of the elevation pieces and the terrain area, click for a height, draw a line for its profile, or shade an area by height. |
| `/log-splitter` | The DataFlash log splitter (`static/apps/log-splitter.html`): works on the file in your browser, nothing is uploaded. |

Jobs run one at a time, as the owner of the `data` folder (so files aren't
root-owned). Links like `/tools#build=terrain`, `/tools#files` and
`/tools#health` open a tab directly. The page reaches the servers by their
compose names (`mbtiles`, `terrain`, ...). The Docker socket, if mounted, adds
container status, logs and restarts.

## Commands

| Command         | Input                                   | Output                          | Served by         |
|-----------------|-----------------------------------------|---------------------------------|-------------------|
| `mbtiles`       | imagery raster(s), or a `{z}/{x}/{y}` tile folder | `data/mbtiles/<name>.mbtiles` | mbtileserver :8000 |
| `terrain`       | DEM raster(s), any size, any CRS        | `data/terrain/layer.json` + `{z}/{x}/{y}.terrain` | nginx :8011 |
| `elevation`     | DEM raster(s)                           | `data/elevation/<name>_<x>_<y>.tif` | open-elevation :8082 |
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
docker save offline-gcs-tools:1.1.0 | gzip > gcs-tools-image.tar.gz   # connected machine
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
  ```

Without Docker: install GDAL's Python bindings and `pip install pydelatin==0.4.0`,
then run `PYTHONPATH=tools python3 -m gcs_tools <command> ...`.
