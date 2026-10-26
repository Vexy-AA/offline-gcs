"""Health check of the running stack: is each server up, did it load its data,
and does it answer real requests?

  map tiles   tile sets loaded vs files on disk, a real tile from the middle
              of each set, missing tiles answer 404
  terrain     layer.json, level-0 and deepest tiles are gzip + decode, real heights
  elevation   .tif files vs what the server indexed, answers at the centre of
              each file compared with reading the file directly, carpet query
  log viewer  the app page and its /tiles/, /quantized/ and /extensionv2/ proxies
  WebTools    the page and its submodule files
  containers  state of every compose service (needs the Docker socket)

From the tools container the servers are reached by their compose service
names. Use --host to go through the published ports instead.
"""

import argparse
import glob
import gzip
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

from . import dockerapi, qmesh

SERVICES = ("mbtiles", "terrain", "elevation", "logviewer", "webtools")
INTERNAL = {
    "mbtiles": "http://mbtiles:8000",
    "terrain": "http://terrain:80",
    "elevation": "http://elevation:8080",
    "logviewer": "http://logviewer:80",
    "webtools": "http://webtools:80",
}
PORTS = {"mbtiles": 8000, "terrain": 8011, "elevation": 8082, "logviewer": 8080, "webtools": 8090, "tools": int(os.environ.get("GCS_HTTP_PORT", "80"))}
RANK = {"ok": 0, "info": 0, "warn": 1, "fail": 2}


def endpoints(host=None, overrides=()):
    eps = {k: f"http://{host}:{PORTS[k]}" for k in SERVICES} if host else dict(INTERNAL)
    extra = [o for o in os.environ.get("GCS_ENDPOINTS", "").split(",") if o] + list(overrides or [])
    for item in extra:
        name, _, url = item.partition("=")
        if name in eps and url:
            eps[name] = url.rstrip("/")
    return eps


class Section:
    def __init__(self, sid, title, url=None):
        self.id, self.title, self.url, self.items = sid, title, url, []

    def add(self, status, text, detail=None):
        self.items.append({"status": status, "text": text, "detail": detail})

    def ok(self, text, detail=None):
        self.add("ok", text, detail)

    def warn(self, text, detail=None):
        self.add("warn", text, detail)

    def fail(self, text, detail=None):
        self.add("fail", text, detail)

    def info(self, text, detail=None):
        self.add("info", text, detail)

    @property
    def status(self):
        worst = max((RANK[i["status"]] for i in self.items), default=0)
        return ["ok", "warn", "fail"][worst]

    def as_dict(self):
        return {"id": self.id, "title": self.title, "url": self.url, "status": self.status, "items": self.items}


def get(url, timeout=8, method="GET"):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": "gcs-tools-check"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def reason(exc):
    r = getattr(exc, "reason", exc)
    return str(r)


def xyz_tile(lon, lat, z):
    n = 1 << z
    x = int((lon + 180.0) / 360.0 * n)
    lat = max(min(lat, 85.0511), -85.0511)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def fmt_bytes(n):
    return f"{n / 1024:.1f} KB" if n < 1024 * 1024 else f"{n / 2**20:.1f} MB"


# --------------------------------------------------------------------------

def check_mbtiles(ep, data_dir, ctx):
    sec = Section("mbtiles", "Map tiles", ep)
    try:
        code, _, body = get(ep + "/services")
    except Exception as e:  # noqa: BLE001
        sec.fail(f"mbtileserver not reachable at {ep}: {reason(e)}")
        return sec
    if code != 200:
        sec.fail(f"/services answered HTTP {code}")
        return sec
    sets = json.loads(body)
    ids = [s.get("url", "").rstrip("/").split("/services/", 1)[-1] for s in sets]
    if ids:
        sec.ok(f"{len(ids)} tile set{'' if len(ids) == 1 else 's'} loaded: " + ", ".join(f"{i} ({s.get('imageType')})" for i, s in zip(ids, sets)))
    else:
        sec.fail("no tile sets loaded (no .mbtiles in data/mbtiles, or none could be opened)")

    folder = os.path.join(data_dir, "mbtiles")
    on_disk = sorted(os.path.relpath(p, folder)[:-len(".mbtiles")]
                     for p in glob.glob(os.path.join(folder, "**", "*.mbtiles"), recursive=True))
    not_served = [i for i in on_disk if i not in ids]
    if not_served:
        sec.warn("on disk but not served: " + ", ".join(not_served),
                 "Restart mbtiles. If it is still missing the file is incomplete or not an MBTiles file "
                 "(see the mbtiles container log).")
    if "custom" not in ids:
        sec.warn("no 'custom' tile set", "The log viewer's Local Imagery layer reads /services/custom/..., "
                                          "so the file must be data/mbtiles/custom.mbtiles.")

    for tid in ids[:6]:
        try:
            _, _, tj_raw = get(f"{ep}/services/{tid}")
            tj = json.loads(tj_raw)
            w, s, e, n = tj["bounds"]
            z = int(tj["maxzoom"])
            x, y = xyz_tile((w + e) / 2, (s + n) / 2, z)
            code, h, data = get(f"{ep}/services/{tid}/tiles/{z}/{x}/{y}.png")
            zr = f"zoom {tj.get('minzoom')}-{z}"
            if code == 200 and (h.get("Content-Type") or "").startswith("image/"):
                sec.ok(f"{tid}: {tj.get('format')}, {zr}; centre tile {z}/{x}/{y}: {h.get('Content-Type')}, "
                       f"{fmt_bytes(len(data))}")
                if tid == "custom":
                    ctx["custom_tile"] = (z, x, y)
            else:
                sec.warn(f"{tid}: {zr}, centre tile {z}/{x}/{y} answered HTTP {code}",
                         "Fine if the imagery doesn't cover the middle of its bounding box.")
        except Exception as e:  # noqa: BLE001
            sec.warn(f"{tid}: could not read its metadata ({reason(e)})")

    for tid in ids[:6]:
        try:
            code, _, body = get(f"{ep}/services/{tid}/map")
            if code == 200 and b"/map/static/index.js" in body:
                sec.ok(f"{tid}: preview map page served", f"/services/{tid}/map")
            else:
                sec.info(f"{tid}: preview map answered HTTP {code} (preview may be disabled)")
        except Exception as e:  # noqa: BLE001
            sec.info(f"{tid}: preview map not reachable ({reason(e)})")

    if ids:
        try:
            code, h, _ = get(f"{ep}/services/{ids[0]}/tiles/22/0/0.png")
            if code == 404:
                sec.ok("missing tiles answer 404, so the log viewer enlarges the last zoom level")
            else:
                sec.warn(f"missing tiles answer HTTP {code} ({h.get('Content-Type')})",
                         "Start mbtileserver with --missing-image-tile-404 (docker-compose.yml), otherwise the "
                         "map goes blank when zoomed in past the imagery's last level.")
        except Exception as e:  # noqa: BLE001
            sec.warn(f"missing-tile test failed: {reason(e)}")
    return sec


def _tile(url):
    code, h, raw = get(url)
    if code != 200:
        raise ValueError(f"HTTP {code}")
    gz_header = (h.get("Content-Encoding") or "").lower() == "gzip"
    if raw[:2] != b"\x1f\x8b":
        raise ValueError("not gzip-compressed")
    return gz_header, qmesh.decode(gzip.decompress(raw))


def check_terrain(ep, data_dir, ctx):
    base = ep + "/quantized"
    sec = Section("terrain", "Terrain", base + "/layer.json")
    try:
        code, _, body = get(base + "/layer.json")
    except Exception as e:  # noqa: BLE001
        sec.fail(f"terrain server not reachable at {ep}: {reason(e)}")
        return sec
    if code != 200:
        sec.fail(f"layer.json answered HTTP {code}",
                 "data/terrain must contain layer.json and the 0/ 1/ 2/ ... folders directly.")
        return sec
    try:
        layer = json.loads(body)
    except ValueError:
        sec.fail("layer.json is not valid JSON")
        return sec
    avail = layer.get("available") or []
    fmt = layer.get("format", "?")
    if not fmt.startswith("quantized-mesh"):
        sec.fail(f"format is {fmt}, expected quantized-mesh-1.0")
    if layer.get("projection", "EPSG:4326") != "EPSG:4326":
        sec.warn(f"projection {layer.get('projection')}: Cesium's quantized-mesh terrain expects EPSG:4326")
    if not avail:
        sec.fail("layer.json lists no available tiles")
        return sec
    maxz = len(avail) - 1
    ext = ", ".join(layer.get("extensions", [])) or "none"
    sec.ok(f"layer.json: levels 0-{maxz}, extensions {ext}, version {layer.get('version', '?')}")
    ctx["terrain_ok"] = True

    try:
        gz, t = _tile(base + "/0/0/0.terrain")
        if gz:
            sec.ok(f"level-0 tile decodes ({t['u'].size} vertices) and is sent with Content-Encoding: gzip")
        else:
            sec.fail("tiles are sent without Content-Encoding: gzip, browsers can't read them",
                     "Use terrain/nginx.conf, which adds the header for .terrain files.")
    except Exception as e:  # noqa: BLE001
        sec.fail(f"level-0 tile 0/0/0: {reason(e)}")

    r = avail[maxz][0]
    x, y = (r["startX"] + r["endX"]) // 2, (r["startY"] + r["endY"]) // 2
    try:
        _, t = _tile(f"{base}/{maxz}/{x}/{y}.terrain")
        lo, hi = t["min_height"], t["max_height"]
        msg = f"deepest tile {maxz}/{x}/{y}: {t['u'].size} vertices, heights {lo:.0f} to {hi:.0f} m"
        if lo == hi == 0:
            sec.warn(msg, "All heights are 0: the tile is outside the DEM, or the DEM was read as no-data.")
        else:
            sec.ok(msg)
    except Exception as e:  # noqa: BLE001
        sec.fail(f"deepest tile {maxz}/{x}/{y}: {reason(e)}")
    return sec


def _read_pixel(path, lat, lon):
    """Value at lat/lon read the way open-elevation does (truncated pixel index)."""
    from osgeo import gdal, osr
    gdal.UseExceptions()
    ds = gdal.Open(path)
    srs = ds.GetSpatialRef()
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    wgs = osr.SpatialReference()
    wgs.ImportFromEPSG(4326)
    wgs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    x, y, _ = osr.CoordinateTransformation(wgs, srs).TransformPoint(lon, lat)
    gt = ds.GetGeoTransform()
    px, py = int((x - gt[0]) / gt[1]), int((y - gt[3]) / gt[5])
    band = ds.GetRasterBand(1)
    val = float(band.ReadAsArray(px, py, 1, 1)[0, 0])
    nodata = band.GetNoDataValue()
    return None if val == -32768 or (nodata is not None and val == nodata) else val


def probe_point(coords):
    """A point well inside a piece, deliberately off its centre: piece centres
    often fall exactly on a pixel edge, where rounding picks either pixel."""
    lat_min, lat_max, lon_min, lon_max = coords
    lat = round(lat_min + 0.4137 * (lat_max - lat_min), 6)
    lon = round(lon_min + 0.5871 * (lon_max - lon_min), 6)
    return lat, lon


def elevation_probe_path(data_dir):
    """A cheap request that open-elevation answers without logging an error:
    a point inside the first indexed piece, or no point at all (HTTP 400)."""
    try:
        with open(os.path.join(data_dir, "elevation", "summary.json")) as f:
            first = json.load(f)[0]
        lat, lon = probe_point(first["coords"])
        return f"/elevation/v1/ele/?points={lat:.6f},{lon:.6f}"
    except (OSError, ValueError, IndexError, KeyError):
        return "/elevation/v1/ele/"


def check_elevation(ep, data_dir, ctx):
    api = ep + "/elevation/v1/ele/"
    sec = Section("elevation", "Elevation", api + "?points=44.6,33.5")
    folder = os.path.join(data_dir, "elevation")
    tifs = sorted(os.path.basename(p) for p in glob.glob(os.path.join(folder, "*.tif")))
    if not tifs:
        sec.warn("no .tif files in data/elevation")
    summary_path = os.path.join(folder, "summary.json")
    summary = []
    if os.path.exists(summary_path):
        with open(summary_path) as f:
            summary = json.load(f)
    elif tifs:
        sec.warn("summary.json is missing", "The server builds it when it starts: restart elevation.")
    indexed = {os.path.basename(e["file"]) for e in summary}
    if tifs or summary:
        msg = f"{len(tifs)} .tif files, {len(indexed)} indexed by the server"
        if set(tifs) == indexed:
            sec.ok(msg)
        else:
            new, gone = sorted(set(tifs) - indexed), sorted(indexed - set(tifs))
            detail = []
            if new:
                detail.append("not indexed: " + ", ".join(new[:8]) + (" ..." if len(new) > 8 else ""))
            if gone:
                detail.append("indexed but deleted: " + ", ".join(gone[:8]) + (" ..." if len(gone) > 8 else ""))
            sec.warn(msg, "; ".join(detail) + ". Delete data/elevation/summary.json and restart elevation.")

    try:
        get(ep + elevation_probe_path(data_dir), timeout=8)
    except Exception as e:  # noqa: BLE001
        sec.fail(f"elevation server not reachable at {ep}: {reason(e)}")
        return sec

    step = max(1, len(summary) // 5)
    for e in summary[::step][:5]:
        name = os.path.basename(e["file"])
        lat, lon = probe_point(e["coords"])
        try:
            _, _, body = get(f"{api}?points={lat:.6f},{lon:.6f}")
            value = json.loads(body)["data"][0]
        except Exception as ex:  # noqa: BLE001
            sec.fail(f"{name}: query at {lat:.5f},{lon:.5f} failed: {reason(ex)}")
            continue
        direct = None
        path = os.path.join(folder, name)
        if os.path.exists(path):
            try:
                direct = _read_pixel(path, lat, lon)
            except Exception:  # noqa: BLE001
                direct = None
        where = f"{name} at {lat:.5f},{lon:.5f}"
        if value == 99:
            sec.fail(f"{where}: server returned 99 (lookup error)", "See the elevation container log.")
        elif direct is None and value == 0:
            sec.warn(f"{where}: 0 m (no data at this point)")
        elif direct is not None and int(direct) == value:
            sec.ok(f"{where}: {value} m, same as reading the file directly")
        elif direct is not None:
            sec.warn(f"{where}: server {value} m, file {direct:.0f} m")
        else:
            sec.ok(f"{where}: {value} m")
    if summary:
        lat, lon = probe_point(summary[0]["coords"])
        try:
            _, _, body = get(f"{api}carpet?points={lat:.6f},{lon:.6f},{lat + 0.002:.6f},{lon + 0.002:.6f}")
            c = json.loads(body)
            st = c["data"]["stats"]
            sec.ok(f"carpet query: {len(c['data']['carpet'])} rows, {st['min']} to {st['max']} m")
        except Exception as ex:  # noqa: BLE001
            sec.fail(f"carpet query failed: {reason(ex)}")
    return sec


def check_logviewer(ep, data_dir, ctx):
    sec = Section("logviewer", "Log viewer", ep + "/")
    try:
        code, _, body = get(ep + "/")
    except Exception as e:  # noqa: BLE001
        sec.fail(f"log viewer not reachable at {ep}: {reason(e)}")
        return sec
    if code == 200 and b'id="app"' in body or b"id=app" in body:
        sec.ok("app page served")
    else:
        sec.fail(f"app page answered HTTP {code}",
                 "The logviewer image has no app in it: docker compose build --no-cache logviewer")
    paths = []
    if "custom_tile" in ctx:
        z, x, y = ctx["custom_tile"]
        paths += [f"/tiles/{z}/{x}/{y}.png", f"/extensionv2/mbtiles/services/custom/tiles/{z}/{x}/{y}.png"]
    else:
        sec.info("map tile proxy not tested (no 'custom' tile set)")
    if ctx.get("terrain_ok"):
        paths += ["/quantized/layer.json", "/extensionv2/terrain/quantized/layer.json"]
    for p in paths:
        try:
            code, h, _ = get(ep + p)
            if code == 200:
                sec.ok(f"proxy {p}: {h.get('Content-Type')}")
            else:
                sec.fail(f"proxy {p}: HTTP {code}", "Check logviewer/nginx.conf.")
        except Exception as e:  # noqa: BLE001
            sec.fail(f"proxy {p}: {reason(e)}")
    return sec


def check_webtools(ep, data_dir, ctx):
    sec = Section("webtools", "WebTools", ep + "/")
    try:
        code, _, body = get(ep + "/")
    except Exception as e:  # noqa: BLE001
        sec.fail(f"WebTools not reachable at {ep}: {reason(e)}")
        return sec
    if code == 200 and b"Web Tools" in body:
        sec.ok("page served")
    else:
        sec.fail(f"page answered HTTP {code}", "The webtools folder is empty: git submodule update --init --recursive")
        return sec
    try:
        code, _, _ = get(ep + "/modules/plotly.js/dist/plotly.min.js", method="HEAD")
        if code == 200:
            sec.ok("submodule files present (plotly.js)")
        else:
            sec.fail("submodule files missing, the tools will open blank",
                     "Run: git submodule update --init --recursive")
    except Exception as e:  # noqa: BLE001
        sec.warn(f"submodule check failed: {reason(e)}")
    return sec


def check_containers():
    sec = Section("containers", "Containers")
    if not dockerapi.available():
        sec.info("container status needs the Docker socket (mounted for the tools service in docker-compose.yml)")
        return sec, None
    project = dockerapi.own_project()
    if not project:
        sec.info("not running under docker compose: container status unknown")
        return sec, None
    try:
        conts = dockerapi.project_containers(project)
    except dockerapi.DockerUnavailable as e:
        sec.info(f"container status unavailable: {e}")
        return sec, None
    for svc in SERVICES + ("tools",):
        c = conts.get(svc)
        if not c:
            sec.fail(f"{svc}: not created", "Run docker compose up -d")
        elif c["state"] != "running":
            sec.fail(f"{svc}: {c['state']} ({c['status']})", f"See: docker compose logs {svc}")
        elif c.get("restart_count", 0) > 2:
            sec.warn(f"{svc}: {c['status']}, restarted {c['restart_count']} times", f"See: docker compose logs {svc}")
        else:
            sec.ok(f"{svc}: {c['status']}")
    return sec, conts


CHECKS = (
    ("mbtiles", check_mbtiles),
    ("terrain", check_terrain),
    ("elevation", check_elevation),
    ("logviewer", check_logviewer),
    ("webtools", check_webtools),
)


def run(eps, data_dir="/data", only=None):
    t0 = time.time()
    ctx, sections = {}, []
    for name, fn in CHECKS:
        if only and name not in only:
            continue
        try:
            sections.append(fn(eps[name], data_dir, ctx))
        except Exception as e:  # noqa: BLE001
            s = Section(name, name)
            s.fail(f"check crashed: {e}")
            sections.append(s)
    cont_sec, conts = check_containers()
    sections.append(cont_sec)
    out = [s.as_dict() for s in sections]
    worst = max((RANK[s["status"]] for s in out), default=0)
    return {"status": ["ok", "warn", "fail"][worst], "sections": out, "containers": conts,
            "seconds": round(time.time() - t0, 1), "time": time.strftime("%Y-%m-%d %H:%M:%S")}


MARK = {"ok": "[ ok ]", "warn": "[warn]", "fail": "[FAIL]", "info": "[info]"}


def print_report(result):
    for s in result["sections"]:
        print(f"\n{s['title']}  {s['status'].upper()}")
        for it in s["items"]:
            print(f"  {MARK[it['status']]} {it['text']}")
            if it.get("detail") and it["status"] != "ok":
                print(f"         {it['detail']}")
    print(f"\nOverall: {result['status'].upper()} ({result['seconds']} s)")


def build_parser(p=None):
    p = p or argparse.ArgumentParser(prog="check", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", help="check through the published ports of this host (e.g. localhost) "
                                  "instead of the compose service names")
    p.add_argument("--url", action="append", default=[], metavar="NAME=URL",
                   help="override one server's base URL, e.g. elevation=http://10.0.0.5:8082")
    p.add_argument("--data", default=None, help="data folder (default: /data in the container, else ./data)")
    p.add_argument("--only", action="append", choices=[c[0] for c in CHECKS], help="run only these checks")
    p.add_argument("--json", action="store_true", help="print the result as JSON")
    return p


def main(argv=None, args=None):
    if args is None:
        args = build_parser().parse_args(argv)
    data = args.data or ("/data" if os.path.isdir("/data/mbtiles") else "data")
    result = run(endpoints(args.host, args.url), data, args.only)
    if args.json:
        json.dump(result, sys.stdout, indent=2)
        print()
    else:
        print_report(result)
    if result["status"] == "fail":
        sys.exit(1)


if __name__ == "__main__":
    main()
