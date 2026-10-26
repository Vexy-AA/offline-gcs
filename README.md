# Offline ground-station stack

UAVLogViewer (offline fork) + map tiles + Cesium terrain + ArduPilot WebTools + open-elevation,
all in one `docker compose` stack. No internet required at runtime (only to build the images).

**Start at http://localhost/**, the front page. It links to every app and shows whether each
server is up. It also has:

- the data tools (`/tools`): build map tiles, terrain and elevation pieces from your own rasters,
  check every server, and upload source files
- an elevation viewer (`/elevation`)
- the DataFlash log splitter (`/log-splitter`)

The same tools also run from the command line (`./gcs-tools`, see [tools/README.md](tools/README.md)).

## Layout

```
offline-gcs/                      (this git repo)
  docker-compose.yml
  gcs-tools                       command-line wrapper: runs the tools image
  tools/                          front page + data tools (Python, Dockerfile, web pages)
  logviewer/
    Dockerfile                    nginx + UAVLogViewer release v1.0.3 (downloaded, SHA-256 checked)
    nginx.conf                    proxies /tiles/ and /quantized/ to the other containers
    runtime-config.js             empty config (paths are hardcoded in this build)
  terrain/nginx.conf              serves .terrain with Content-Encoding: gzip
  webtools-nginx.conf
  webtools/                       submodule: Vexy-AA/WebTools (with its own submodules)
  open-elevation/                 submodule: Vexy-AA/open-elevation
  data/                           NOT in git (only the empty folders are)
    src/                          your source rasters (uploads from the tools page land here)
    mbtiles/custom.mbtiles
    terrain/layer.json, 0/, 1/ ...  (NOT terrain/quantized/...)
    elevation/*.tif               (summary.json is created on first start)
```

## Setup

1. Clone with submodules (WebTools needs its own submodules or the tools come up blank):
   ```bash
   git clone --recurse-submodules <repo-url> offline-gcs
   cd offline-gcs
   ```
   Already cloned without them: `git submodule update --init --recursive`.

2. Build and start (the first build needs internet):
   ```bash
   docker compose up -d --build
   docker compose ps
   ```
   Every service has `restart: unless-stopped`, so after a reboot they come back by themselves
   as long as Docker starts at boot (`sudo systemctl enable docker`). `-d` runs them in the
   background; leave it out only to watch the logs (Ctrl+C then stops the stack).

3. Open http://localhost/. Port 80 already taken on this machine? Put `GCS_HTTP_PORT=8095` in a
   `.env` file next to `docker-compose.yml` and use http://localhost:8095/.

4. Put data in place: either copy it from an existing install
   ```bash
   cp /path/to/custom.mbtiles data/mbtiles/
   cp -r /path/to/terrain/. data/terrain/        # layer.json + 0/ 1/ 2/ ... directly inside
   cp /path/to/elevation/*.tif data/elevation/
   ```
   or build it from your own rasters (next section).

**Offline machine:** build the images where there is internet, then copy them over:
```bash
docker compose build
docker save offline-gcs-tools:1.1.0 offline-gcs-elevation offline-gcs-logviewer:v1.0.3 nginx:alpine \
  ghcr.io/consbio/mbtileserver:latest \
  | gzip > gcs-images.tar.gz          # then on the offline machine: docker load < gcs-images.tar.gz
```

## Preparing data from your own rasters

On the front page, choose **Map tiles**, **Terrain** or **Elevation pieces**: upload the file
(or copy it into `data/src/`), tick it, press the button and watch the log. Each job also shows
the matching command line. The same from a terminal:

```bash
./gcs-tools mbtiles   /path/to/ortho.tif   data/mbtiles/custom.mbtiles   # or a z/x/y tile folder
./gcs-tools terrain   /path/to/dem.tif     data/terrain --clean
./gcs-tools elevation /path/to/dem.tif                                   # then: docker compose restart elevation
```

mbtileserver picks up new `.mbtiles` files by itself, terrain is static files (hard-refresh the
browser), and the tools page restarts the elevation server for you after cutting pieces. Inputs
can be any GDAL format and projection. Details and options: [tools/README.md](tools/README.md).

## URLs (replace `localhost` with the host's LAN IP from other machines)

| Service          | URL                                                                  |
|------------------|----------------------------------------------------------------------|
| Front page       | http://localhost/                                                    |
| Data tools       | http://localhost/tools                                               |
| Elevation viewer | http://localhost/elevation                                           |
| Log splitter     | http://localhost/log-splitter                                        |
| UAVLogViewer     | http://localhost:8080/                                               |
| Map tiles        | http://localhost:8000/services/custom/tiles/{z}/{x}/{y}.png          |
| Tile map preview | http://localhost:8000/services/custom/map                            |
| Tile list        | http://localhost:8000/services                                       |
| Terrain          | http://localhost:8011/quantized/layer.json                           |
| WebTools         | http://localhost:8090/                                               |
| Elevation API    | http://localhost:8082/elevation/v1/ele/?points=44.6,33.5             |

## Verify

The **Server health** button on the front page (or `./gcs-tools check` in a terminal) checks
every server with real requests: a tile from the middle of each tile set, the deepest terrain
tile decoded, heights compared with the elevation files, the log viewer's proxies, WebTools'
submodules, and the state of every container.

By hand:
```bash
curl -s localhost:8000/services | head -c 300; echo
curl -sI localhost:8011/quantized/0/0/0.terrain | grep -iE "^HTTP|content-encoding"
curl -sI localhost:8080/quantized/layer.json | head -1
curl -s "localhost:8082/elevation/v1/ele/?points=44.6,33.5"; echo
```

## Notes

- **Firewall**: to reach services from other machines, allow TCP 80, 8000, 8011, 8080, 8082, 8090 on the host.
- **Tile set name**: the log viewer's Local Imagery layer reads `custom`, so its file is
  `data/mbtiles/custom.mbtiles`. Other names show up as extra tile sets. To use another name, update
  `services/<name>/tiles/` in `logviewer/nginx.conf`.
- **mbtileserver** runs with `ENABLE_FS_WATCH` (new or replaced files load without a restart) and
  `--missing-image-tile-404` (when zoomed in past the imagery's last level, the log viewer shows that
  level enlarged instead of a blank map).
- **The tools container has the Docker socket** so its page can show container status and logs and
  restart the elevation server. That gives it control over Docker; remove the socket line in
  `docker-compose.yml` if that isn't acceptable on your network (the page then says what to restart).
  The pages have no login, like the other servers here: keep the stack on a trusted network.
- **Updating elevation data by hand**: after changing `.tif` files, delete `data/elevation/summary.json`
  and `docker compose restart elevation`.
- **The log viewer** is the `logviewer.tar.gz` asset of a
  [Vexy-AA/UAVLogViewer release](https://github.com/Vexy-AA/UAVLogViewer/releases), downloaded when
  the image is built and checked against the SHA-256 in `logviewer/Dockerfile`. v1.0.3 is the build of
  the `blueos` branch at `0a6dbc6`. To update: put the new version and its `sha256sum` in
  `logviewer/Dockerfile` and the `image:` tag in `docker-compose.yml`, then
  `docker compose up -d --build logviewer`.
- **CORS**: mbtileserver sends no CORS headers. Desktop apps (QGIS, Mission Planner, QGC) don't need them.
  A browser app on another origin does; use the logviewer proxy (`:8080/tiles/`) or ask to add a CORS front.

## Git

- `data/` is ignored; everything needed to rebuild the stack except the data itself is in the repo.
- WebTools and open-elevation are submodules pinned to exact commits. To move one forward:
  ```bash
  cd webtools && git pull && git submodule update --init --recursive && cd ..
  git add webtools && git commit -m "Update WebTools"
  ```
  Commits made inside `open-elevation/` must be pushed to its own remote
  (`cd open-elevation && git push origin master`) before pushing this repo,
  or other clones can't check out the pinned commit.
- The tools image is pinned (Ubuntu 24.04 GDAL 3.8.4, hash-pinned Python wheel). The server images
  use `ghcr.io/consbio/mbtileserver:latest` and `nginx:alpine`; pin versions in `docker-compose.yml`
  if you need those to stay identical too.
