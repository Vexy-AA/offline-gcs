"""Tools web page: stack health, building data from source rasters, source files.

    python3 -m gcs_tools serve [--port 8095]

Runs as the always-on "tools" service of docker-compose.yml. Standard library
only. Jobs run one at a time as the same CLI commands (python3 -m gcs_tools
...), as the owner of the data folder, and each job shows the equivalent
./gcs-tools command line.
"""

import argparse
import collections
import concurrent.futures
import glob
import http.server
import json
import mimetypes
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import zipfile

from . import __version__, backups, dockerapi, stackcheck, tilesource

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
DATA = os.path.abspath(os.environ.get("GCS_DATA_DIR", "/data"))
SRC = os.path.join(DATA, "src")
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PCT_RE = re.compile(r"(\d+(?:\.\d+)?)%")
MAX_LOG_LINES = 4000


class ApiError(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.code = code


def data_owner():
    st = os.stat(DATA)
    return st.st_uid, st.st_gid


def chown_like_data(path):
    if os.geteuid() != 0:
        return
    uid, gid = data_owner()
    try:
        os.chown(path, uid, gid)
    except OSError:
        pass


def src_path(rel):
    """Resolve a path given relative to data/src; refuse anything outside it."""
    rel = (rel or "").replace("\\", "/").lstrip("/")
    if rel.startswith("data/src/"):
        rel = rel[len("data/src/"):]
    path = os.path.realpath(os.path.join(SRC, rel))
    if path != os.path.realpath(SRC) and not path.startswith(os.path.realpath(SRC) + os.sep):
        raise ApiError("path must be inside data/src")
    return path


def host_view(arg):
    """/data/x -> data/x, for showing the equivalent ./gcs-tools command."""
    if isinstance(arg, str) and (arg == DATA or arg.startswith(DATA + "/")):
        arg = "data" + arg[len(DATA):]
    return arg if re.match(r"^[\w@%+=:,./-]+$", arg) else "'" + arg.replace("'", "'\\''") + "'"


# --------------------------------------------------------------------------
# Jobs
# --------------------------------------------------------------------------

class Job:
    _ids = 0

    def __init__(self, kind, title, args, after=None, func=None, command=None):
        Job._ids += 1
        self.id = Job._ids
        self.kind, self.title, self.args, self.after, self.func = kind, title, args, after, func
        self.command = command or "./gcs-tools " + " ".join(host_view(a) for a in args)
        self.cancel_requested = False
        self.status = "queued"
        self.created = time.time()
        self.started = self.ended = None
        self.returncode = None
        self.progress = None
        self.lines = []
        self.dropped = 0
        self.proc = None
        self.notes = []

    def log(self, line):
        self.lines.append(line)
        if len(self.lines) > MAX_LOG_LINES:
            cut = len(self.lines) - MAX_LOG_LINES
            del self.lines[:cut]
            self.dropped += cut

    def as_dict(self, since=None):
        d = {k: getattr(self, k) for k in ("id", "kind", "title", "command", "status", "created", "started",
                                           "ended", "returncode", "progress", "notes")}
        if since is not None:
            start = max(0, since - self.dropped)
            d["lines"] = self.lines[start:]
            d["next"] = self.dropped + len(self.lines)
        return d


class Runner(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.jobs = collections.OrderedDict()

    def submit(self, job):
        with self.lock:
            self.jobs[job.id] = job
            while len(self.jobs) > 30:
                oldest = next(iter(self.jobs.values()))
                if oldest.status in ("queued", "running"):
                    break
                self.jobs.popitem(last=False)
        self.wake.set()
        return job

    def cancel(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            raise ApiError("no such job", 404)
        if job.status == "queued":
            job.status = "cancelled"
        elif job.status == "running" and job.func:
            job.cancel_requested = True
            job.log("-- cancelling --")
        elif job.status == "running" and job.proc:
            job.log("-- cancelling --")
            try:
                os.killpg(job.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            threading.Timer(15, self._kill, args=(job,)).start()
        return job

    @staticmethod
    def _kill(job):
        if job.proc and job.proc.poll() is None:
            try:
                os.killpg(job.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def busy(self):
        return any(j.status in ("queued", "running") for j in self.jobs.values())

    def run(self):
        while True:
            self.wake.wait(2)
            self.wake.clear()
            job = next((j for j in list(self.jobs.values()) if j.status == "queued"), None)
            if job:
                self._run(job)

    def _run(self, job):
        job.status, job.started = "running", time.time()
        if job.func:
            try:
                job.func(job)
                job.returncode = 143 if job.cancel_requested else 0
            except Exception as e:  # noqa: BLE001
                job.log(f"ERROR: {e}")
                job.returncode = 1
            job.ended = time.time()
            job.status = {0: "done", 143: "cancelled"}.get(job.returncode, "failed")
            return
        uid, gid = data_owner()
        kw = {}
        if os.geteuid() == 0 and uid != 0:
            kw = {"user": uid, "group": gid, "extra_groups": []}
        pkg_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        pypath = os.pathsep.join(p for p in (pkg_parent, os.environ.get("PYTHONPATH", "")) if p)
        env = dict(os.environ, PYTHONUNBUFFERED="1", HOME="/tmp", PYTHONPATH=pypath)
        try:
            job.proc = subprocess.Popen(
                [sys.executable, "-u", "-m", "gcs_tools", *job.args], cwd=DATA, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                start_new_session=True, text=True, bufsize=1, errors="replace", **kw)
            for line in job.proc.stdout:
                line = line.rstrip("\n")
                job.log(line)
                m = PCT_RE.findall(line)
                if m:
                    job.progress = float(m[-1])
            job.returncode = job.proc.wait()
        except Exception as e:  # noqa: BLE001
            job.log(f"failed to start: {e}")
            job.returncode = -1
        final = "done" if job.returncode == 0 else ("cancelled" if job.returncode in (-15, -9, 143) else "failed")
        if final == "done" and job.after:  # before the status flips, so the page sees the notes
            try:
                job.after(job)
            except Exception as e:  # noqa: BLE001
                job.notes.append(f"after the job: {e}")
        job.ended = time.time()
        if job.status == "running":
            job.status = final
        job.proc = None


RUNNER = Runner()


def restart_service(name):
    if name not in dockerapi.RESTARTABLE:
        raise ApiError(f"'{name}' can't be restarted from here")
    project = dockerapi.own_project()
    conts = dockerapi.project_containers(project) if project else {}
    if name not in conts:
        raise ApiError(f"container for '{name}' not found", 404)
    dockerapi.restart(conts[name]["id"])


def _after_elevation(job):
    if dockerapi.available():
        restart_service("elevation")
        job.notes.append("Restarted the elevation server so it indexes the new pieces.")
    else:
        job.notes.append("Restart the elevation server to index the new pieces: docker compose restart elevation")


def _after_mbtiles(job):
    job.notes.append("mbtileserver loads the new file by itself (ENABLE_FS_WATCH). "
                     "If it doesn't show up, restart mbtiles.")


def _after_terrain(job):
    job.notes.append("Terrain is plain files: hard-refresh the log viewer (Ctrl+Shift+R) to see the change.")


def _after_restore(job):
    kind = getattr(job, "restore_kind", None)
    if kind == "elevation":
        _after_elevation(job)
    elif kind == "mbtiles":
        _after_mbtiles(job)
    elif kind == "terrain":
        _after_terrain(job)


BACKUPS = os.path.join(DATA, "backups")


def tileset_path(name):
    if not NAME_RE.match(name or ""):
        raise ApiError("tile set name: letters, digits, - and _ only")
    path = os.path.join(DATA, "mbtiles", f"{name}.mbtiles")
    if not os.path.isfile(path):
        raise ApiError(f"data/mbtiles/{name}.mbtiles not found", 404)
    return path


def _prefer(p):
    v = p.get("prefer") or "existing"
    if v not in ("existing", "new"):
        raise ApiError("prefer must be existing or new")
    return v


def _num(params, key, lo, hi, cast=float):
    v = params.get(key)
    if v in (None, ""):
        return None
    try:
        v = cast(v)
    except (TypeError, ValueError):
        raise ApiError(f"{key} must be a number")
    if not lo <= v <= hi:
        raise ApiError(f"{key} must be between {lo} and {hi}")
    return v


def build_job(kind, p):
    sources = [src_path(s) for s in (p.get("sources") or [])]
    for s in sources:
        if not os.path.exists(s):
            raise ApiError(f"not found: {host_view(s)}")
    if kind not in ("check-terrain", "restore", "add-mbtiles", "inspect") and not sources:
        raise ApiError("choose at least one source file")

    if kind == "mbtiles":
        name = p.get("name") or "custom"
        if not NAME_RE.match(name):
            raise ApiError("tile set name: letters, digits, - and _ only")
        out = os.path.join(DATA, "mbtiles", f"{name}.mbtiles")
        if os.path.exists(out) and not p.get("overwrite"):
            raise ApiError(f"data/mbtiles/{name}.mbtiles exists; tick 'Replace' to overwrite it", 409)
        args = ["mbtiles", *sources, out]
        fmt = p.get("format") or "auto"
        if fmt not in ("auto", "jpeg", "png", "png8", "webp"):
            raise ApiError("unknown format")
        args += ["--format", fmt]
        q = _num(p, "quality", 1, 100, int)
        if q is not None and fmt in ("auto", "jpeg", "webp"):
            args += ["--quality", str(q)]
        for key, flag in (("max_zoom", "--max-zoom"), ("min_zoom", "--min-zoom")):
            v = _num(p, key, 0, 22, int)
            if v is not None:
                args += [flag, str(v)]
        if p.get("overwrite"):
            args.append("--overwrite")
        return Job(kind, f"Map tiles: {name}.mbtiles", args, _after_mbtiles)

    if kind == "terrain":
        args = ["terrain", *sources, os.path.join(DATA, "terrain")]
        mode = p.get("mode") or "clean"
        if mode not in ("clean", "resume"):
            raise ApiError("mode must be clean or resume")
        args.append(f"--{mode}")
        for key, flag, lo, hi, cast in (("max_zoom", "--max-zoom", 0, 20, int),
                                        ("quality", "--quality", 0.05, 4, float),
                                        ("max_zoom_error", "--max-zoom-error", 0.1, 1000, float)):
            v = _num(p, key, lo, hi, cast)
            if v is not None:
                args += [flag, str(v)]
        return Job(kind, "Terrain", args)

    if kind == "elevation":
        args = ["elevation", *sources, "--out", os.path.join(DATA, "elevation")]
        size = _num(p, "piece_size", 200, 20000, int)
        if size:
            args += ["--piece-size", str(size)]
        if p.get("replace"):
            args.append("--replace")
        return Job(kind, "Elevation pieces", args, _after_elevation if p.get("restart", True) else None)

    if kind == "add-mbtiles":
        name = p.get("target") or "custom"
        if not NAME_RE.match(name):
            raise ApiError("tile set name: letters, digits, - and _ only")
        target = os.path.join(DATA, "mbtiles", f"{name}.mbtiles")
        if not os.path.exists(target):
            raise ApiError(f"data/mbtiles/{name}.mbtiles does not exist; build it on the Build data tab first", 404)
        oname = None
        if not sources and p.get("source_tileset"):
            # another tile set that is already served (data/mbtiles/<name>.mbtiles)
            other = tileset_path(p["source_tileset"])
            if other == target:
                raise ApiError("the new area and the tile set to add it to are the same file")
            sources = [other]
            oname = p["source_tileset"]

        def after(job):
            _after_mbtiles(job)
            if oname:
                job.notes.append(f"{oname}.mbtiles is still in data/mbtiles and served as its own tile set; "
                                 "delete it on the host if you no longer need it.")
        if not sources:
            raise ApiError("choose the new imagery")
        scheme = p.get("scheme") or "auto"
        if scheme not in ("auto", "xyz", "tms"):
            raise ApiError("scheme must be auto, xyz or tms")
        args = ["add-mbtiles", *sources, target, "--prefer", _prefer(p)]
        if scheme != "auto":
            args += ["--scheme", scheme]
        if p.get("lower_zooms") is False:
            args.append("--no-lower-zooms")
        if p.get("black_empty"):
            args.append("--black-empty")
        dry = bool(p.get("dry_run"))
        if dry:
            args.append("--dry-run")
        return Job(kind, f"{'Check: ' if dry else ''}Add to map tiles ({name})", args, None if dry else after)

    if kind == "add-terrain":
        args = ["add-terrain", *sources, os.path.join(DATA, "terrain"), "--prefer", _prefer(p)]
        v = _num(p, "max_zoom", 0, 20, int)
        if v is not None:
            args += ["--max-zoom", str(v)]
        dry = bool(p.get("dry_run"))
        if dry:
            args.append("--dry-run")
        return Job(kind, f"{'Check: ' if dry else ''}Add to terrain", args, None if dry else _after_terrain)

    if kind == "add-elevation":
        args = ["add-elevation", *sources, "--out", os.path.join(DATA, "elevation"), "--prefer", _prefer(p)]
        size = _num(p, "piece_size", 200, 20000, int)
        if size:
            args += ["--piece-size", str(size)]
        if p.get("fill_holes") is False:
            args.append("--no-fill-holes")
        dry = bool(p.get("dry_run"))
        if dry:
            args.append("--dry-run")
        after = None if dry or not p.get("restart", True) else _after_elevation
        return Job(kind, f"{'Check: ' if dry else ''}Add to elevation pieces", args, after)

    if kind == "unpack":
        if len(sources) != 1 or not sources[0].lower().endswith(".zip"):
            raise ApiError("choose one .zip file")
        zpath = sources[0]
        dest = os.path.splitext(zpath)[0]
        if os.path.exists(dest):
            raise ApiError(f"{host_view(dest)} already exists; delete or rename it first", 409)
        return Job(kind, f"Unpack {os.path.basename(zpath)}", [], func=lambda job: unpack_zip(job, zpath, dest),
                   command=f"unzip {host_view(zpath)} -d {host_view(dest)}")

    if kind == "inspect":
        if p.get("tileset"):
            path = tileset_path(p["tileset"])
        elif len(sources) == 1:
            path = sources[0]
        else:
            raise ApiError("choose one file to check")
        args = ["inspect", path]
        tname = p.get("target") or "custom"
        if NAME_RE.match(tname) and os.path.exists(os.path.join(DATA, "mbtiles", f"{tname}.mbtiles")):
            if os.path.abspath(path) != os.path.join(DATA, "mbtiles", f"{tname}.mbtiles"):
                args += ["--target", os.path.join(DATA, "mbtiles", f"{tname}.mbtiles")]
        if p.get("deep"):
            args.append("--deep")
        return Job(kind, f"Check {os.path.basename(path.rstrip('/'))}", args)

    if kind == "repair":
        if len(sources) != 1 or os.path.isdir(sources[0]):
            raise ApiError("choose one tile file to repair")
        from .repair_tiles import default_out
        out = default_out(sources[0])
        args = ["repair", sources[0]]
        if p.get("overwrite"):
            args.append("--overwrite")
        elif os.path.exists(out):
            raise ApiError(f"{host_view(out)} already exists; delete it first (Files tab)", 409)
        return Job(kind, f"Repair {os.path.basename(sources[0])}", args)

    if kind == "restore":
        rid = p.get("id") or ""
        point = next((m for m in backups.list_points(BACKUPS, with_size=False) if m["id"] == rid), None)
        if point is None:
            raise ApiError("no such restore point", 404)
        if not point["restorable"]:
            raise ApiError("restore the newer restore points of the same data first", 409)
        job = Job(kind, f"Restore: {point['title']}", ["backups", "restore", rid, "--data", DATA], _after_restore)
        job.restore_kind = point["kind"]
        return job

    if kind == "check-terrain":
        args = ["check-terrain", os.path.join(DATA, "terrain")]
        if sources:
            args += ["--dem", sources[0]]
        return Job(kind, "Check terrain files", args)

    raise ApiError("unknown job type")


def unpack_zip(job, zpath, dest):
    """Extract a zip into data/src/<name>/ (e.g. a {z}/{x}/{y} tile folder)."""
    tmp = dest + ".unpacking"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    uid, gid = data_owner()
    root = os.path.realpath(tmp)
    try:
        with zipfile.ZipFile(zpath) as z:
            members = [m for m in z.infolist() if not m.is_dir()]
            job.log(f"{len(members)} files in {os.path.basename(zpath)}")
            for i, m in enumerate(members):
                if job.cancel_requested:
                    raise ApiError("cancelled")
                target = os.path.realpath(os.path.join(tmp, m.filename))
                if not target.startswith(root + os.sep):
                    raise ApiError(f"unsafe path in zip: {m.filename}")
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with z.open(m) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out, 1024 * 1024)
                if i % 500 == 0 or i == len(members) - 1:
                    job.progress = 100.0 * (i + 1) / max(len(members), 1)
                    job.log(f"  {i + 1}/{len(members)} ({job.progress:.0f}%)")
        # a zip that holds one top folder: use that folder's contents
        entries = os.listdir(tmp)
        src_dir = os.path.join(tmp, entries[0]) if len(entries) == 1 and os.path.isdir(os.path.join(tmp, entries[0])) else tmp
        os.replace(src_dir, dest)
        if os.geteuid() == 0:
            for dirpath, dirnames, filenames in os.walk(dest):
                for n in [dirpath] + [os.path.join(dirpath, f) for f in filenames]:
                    try:
                        os.chown(n, uid, gid)
                    except OSError:
                        pass
        job.log(f"Unpacked into {host_view(dest)}")
    except ApiError as e:
        if str(e) != "cancelled":
            raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# --------------------------------------------------------------------------
# Data overview
# --------------------------------------------------------------------------

def _size(path):
    if os.path.isfile(path):
        return os.path.getsize(path)
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def mbtiles_info(path):
    info = {"name": os.path.relpath(path, os.path.join(DATA, "mbtiles"))[:-len(".mbtiles")],
            "size": os.path.getsize(path), "mtime": os.path.getmtime(path)}
    try:
        db = tilesource.open_ro(path, timeout=2)
        meta = dict(db.execute("SELECT name, value FROM metadata"))
        db.close()
        info.update({k: meta.get(k) for k in ("format", "minzoom", "maxzoom", "bounds", "description")})
    except sqlite3.Error as e:
        info["error"] = str(e)
    return info


def data_overview():
    out = {"src": [], "mbtiles": [], "terrain": None, "elevation": None}
    if os.path.isdir(SRC):
        side = ("-wal", "-shm", "-journal")
        for name in sorted(os.listdir(SRC)):
            if name.startswith(".") or name.endswith(side):
                continue
            p = os.path.join(SRC, name)
            out["src"].append({"name": name, "dir": os.path.isdir(p),
                               "size": os.path.getsize(p) if os.path.isfile(p) else None,
                               "mtime": os.path.getmtime(p)})
            # a tile file one folder down (copied in with its folder) is listed too
            if os.path.isdir(p) and not any(n.isdigit() for n in os.listdir(p)):
                for inner in sorted(os.listdir(p)):
                    q = os.path.join(p, inner)
                    if inner.lower().endswith(tilesource.SQLITE_EXTS) and os.path.isfile(q):
                        out["src"].append({"name": f"{name}/{inner}", "dir": False, "size": os.path.getsize(q),
                                           "mtime": os.path.getmtime(q), "inner": True})
    for p in sorted(glob.glob(os.path.join(DATA, "mbtiles", "**", "*.mbtiles"), recursive=True)):
        out["mbtiles"].append(mbtiles_info(p))
    layer = os.path.join(DATA, "terrain", "layer.json")
    if os.path.exists(layer):
        try:
            with open(layer) as f:
                lj = json.load(f)
            out["terrain"] = {"levels": len(lj.get("available", [])), "bounds": lj.get("bounds"),
                              "version": lj.get("version"), "mtime": os.path.getmtime(layer),
                              "description": lj.get("description")}
        except (OSError, ValueError) as e:
            out["terrain"] = {"error": str(e)}
    elev = os.path.join(DATA, "elevation")
    tifs = glob.glob(os.path.join(elev, "*.tif"))
    summary = os.path.join(elev, "summary.json")
    indexed = None
    if os.path.exists(summary):
        try:
            with open(summary) as f:
                indexed = len(json.load(f))
        except (OSError, ValueError):
            indexed = None
    out["elevation"] = {"files": len(tifs), "size": sum(os.path.getsize(t) for t in tifs), "indexed": indexed}
    out["backups"] = len(backups.list_points(os.path.join(DATA, "backups"), with_size=False))
    du = shutil.disk_usage(DATA)
    out["disk"] = {"free": du.free, "total": du.total}
    return out


def raster_info(path):
    if path.lower().endswith(".zip") and os.path.isfile(path):
        return {"kind": "zip", "use": ["unpack"],
                "summary": "zip archive: unpack it, then build map tiles from the folder (z/x/y tiles) or the rasters in it"}
    if os.path.isdir(path):
        zooms = sorted(int(d) for d in os.listdir(path) if d.isdigit() and os.path.isdir(os.path.join(path, d)))
        if zooms:
            tms = os.path.exists(os.path.join(path, "tilemapresource.xml"))
            info = {"kind": "tiles", "use": ["mbtiles", "add-mbtiles"], "zooms": [zooms[0], zooms[-1]], "tileish": True,
                    "rows": "tms" if tms else "xyz",
                    "summary": f"tile folder, zoom {zooms[0]}-{zooms[-1]}"
                               + (", TMS rows (gdal2tiles)" if tms else "")}
            b = folder_bounds(path, zooms[-1], tms)
            if b:
                info["bounds"] = b
            return info
        inside = sorted(n for n in os.listdir(path) if n.lower().endswith(tilesource.SQLITE_EXTS))
        return {"kind": "folder", "use": [], "tileish": not inside,  # its tile files are listed on their own
                "summary": f"folder with {', '.join(inside)} in it (listed separately below)" if inside
                else "folder without {z}/{x}/{y} tiles (no zoom-level folders 0/, 1/, ... in it)"}
    if os.path.isfile(path) and (path.lower().endswith(tilesource.SQLITE_EXTS) or tilesource.is_sqlite(path)):
        return mbtiles_source_info(path)
    from osgeo import gdal, osr
    gdal.UseExceptions()
    try:
        ds = gdal.Open(path)
    except RuntimeError as e:
        return {"kind": "unknown", "summary": f"not a raster GDAL can read ({e})", "use": []}
    b1 = ds.GetRasterBand(1)
    dtype = gdal.GetDataTypeName(b1.DataType)
    srs = ds.GetSpatialRef()
    crs = srs.GetName() if srs else "no coordinate system"
    if srs and srs.GetAuthorityCode(None):
        crs += f" (EPSG:{srs.GetAuthorityCode(None)})"
    gt = ds.GetGeoTransform()
    unit = "°" if srs is not None and srs.IsGeographic() else " m"
    info = {"driver": ds.GetDriver().ShortName, "width": ds.RasterXSize, "height": ds.RasterYSize,
            "bands": ds.RasterCount, "type": dtype, "crs": crs,
            "pixel": f"{abs(gt[1]):.6g}{unit}" if gt else None, "nodata": b1.GetNoDataValue()}
    try:
        ext = gdal.Info(ds, format="json").get("wgs84Extent", {}).get("coordinates", [[]])[0]
        if ext:
            lons, lats = [c[0] for c in ext], [c[1] for c in ext]
            info["bounds"] = [round(min(lons), 5), round(min(lats), 5), round(max(lons), 5), round(max(lats), 5)]
    except Exception:  # noqa: BLE001
        pass
    if dtype == "Byte" and (ds.RasterCount in (3, 4) or b1.GetColorTable() is not None or ds.RasterCount == 1):
        info.update(kind="imagery", use=["mbtiles", "add-mbtiles"])
        info["summary"] = f"{ds.RasterCount}-band 8-bit image: use it for map tiles"
    elif ds.RasterCount == 1:
        info.update(kind="dem", use=["terrain", "elevation", "check-terrain", "add-terrain", "add-elevation"])
        info["summary"] = f"1-band {dtype} raster: an elevation model, use it for terrain and elevation"
    else:
        info.update(kind="unknown", use=[])
        info["summary"] = f"{ds.RasterCount}-band {dtype} raster"
    if srs is None:
        info["use"] = []
        info["summary"] += " (has no coordinate system, can't be used)"
    return info


_SOURCE_INFO = {}


def mbtiles_source_info(path):
    """A tile file (.mbtiles, .sqlitedb, ...) as the new area of add-mbtiles: zooms, area and row order,
    as add-mbtiles reads it; or why it can't be used."""
    st = os.stat(path)
    key = (path, st.st_size, st.st_mtime)
    if key not in _SOURCE_INFO:
        r = tilesource.summary(path)
        if "error" in r:
            info = {"kind": "mbtiles", "use": [], "tileish": True, "summary": r["error"], "damaged": r.get("damaged")}
        else:
            fmt = (r.get("format") or "").upper()
            info = {"kind": "mbtiles", "use": ["add-mbtiles"], "tileish": True, "zooms": r["zooms"],
                    "bounds": r["bounds"], "rows": r["scheme"], "layout": r["layout"],
                    "summary": f"{r['label']}, zoom {r['zooms'][0]}-{r['zooms'][1]}, {r['tiles']} tiles"
                               + (f", {fmt}" if fmt else "")
                               + ("" if r["scheme"] == ("tms" if r["layout"] == "mbtiles" else "xyz")
                                  else f", {r['scheme'].upper()} rows ({r['reason']})")
                               + ("" if r["indexed"] else ", no index (slow to read)")
                               + ": add it to an existing tile set"}
        if len(_SOURCE_INFO) > 200:
            _SOURCE_INFO.clear()
        _SOURCE_INFO[key] = info
    return dict(_SOURCE_INFO[key])


_FOLDER_BOUNDS = {}


def folder_bounds(path, z, tms=False):
    """lon/lat box of a {z}/{x}/{y} folder from its deepest level, cached by mtime."""
    zdir = os.path.join(path, str(z))
    try:
        key = (zdir, os.path.getmtime(zdir), tms)
    except OSError:
        return None
    if key in _FOLDER_BOUNDS:
        return _FOLDER_BOUNDS[key]
    xs, ys = [], []
    for xe in os.scandir(zdir):
        if xe.name.isdigit() and xe.is_dir():
            col = [int(n.split(".", 1)[0]) for n in os.listdir(xe.path) if n.split(".", 1)[0].isdigit()]
            if col:
                xs.append(int(xe.name))
                ys += [min(col), max(col)]
    if not xs:
        return None
    if tms:
        ys = [(1 << z) - 1 - y for y in ys]
    from .mbtiles import tile_lonlat
    w, n = tile_lonlat(z, min(xs), min(ys))
    e, s = tile_lonlat(z, max(xs) + 1, max(ys) + 1)
    _FOLDER_BOUNDS[key] = [round(w, 5), round(s, 5), round(e, 5), round(n, 5)]
    return _FOLDER_BOUNDS[key]


_PIECE_BOUNDS = {}


def coverage():
    """What exists now, for the Add area map: tile sets, terrain area, elevation pieces (from the files)."""
    out = elevation_coverage()
    pieces = []
    from osgeo import gdal
    gdal.UseExceptions()
    for path in sorted(glob.glob(os.path.join(DATA, "elevation", "*.tif"))):
        try:
            st = os.stat(path)
        except OSError:
            continue
        key = (path, st.st_mtime, st.st_size)
        b = _PIECE_BOUNDS.get(key)
        if b is None:
            try:
                ds = gdal.Open(path)
                gt = ds.GetGeoTransform()
                w, n = gt[0], gt[3]
                b = [w, n + ds.RasterYSize * gt[5], w + ds.RasterXSize * gt[1], n]
                ds = None
            except RuntimeError:
                continue
            _PIECE_BOUNDS[key] = b
        pieces.append({"name": os.path.basename(path), "bounds": b})
    out["pieces"] = pieces
    layer = os.path.join(DATA, "terrain", "layer.json")
    if out.get("terrain") and os.path.exists(layer):
        try:
            with open(layer) as f:
                lj = json.load(f)
            out["terrain"]["levels"] = len(lj.get("available", []))
        except (OSError, ValueError):
            pass
    return out


# --------------------------------------------------------------------------
# Front page status and elevation viewer helpers
# --------------------------------------------------------------------------

STATUS_PROBES = {
    "mbtiles": "/services",
    "terrain": "/quantized/layer.json",
    "elevation": None,  # see stackcheck.elevation_probe_path
    "logviewer": "/",
    "webtools": "/",
}


def quick_status():
    eps = stackcheck.endpoints()

    def probe(name):
        try:
            path = STATUS_PROBES[name] or stackcheck.elevation_probe_path(DATA)
            code, _, body = stackcheck.get(eps[name] + path, timeout=3)
            # up = answers at all; ok = answered as expected (no points -> HTTP 400 is fine)
            ok = code == 200 or (name == "elevation" and code == 400 and "points=" not in path)
            info = {"up": True, "ok": ok, "code": code}
            if name == "mbtiles" and code == 200:
                info["tilesets"] = [s.get("url", "").rstrip("/").split("/services/", 1)[-1] for s in json.loads(body)]
            return name, info
        except Exception as e:  # noqa: BLE001
            return name, {"up": False, "error": stackcheck.reason(e)}

    with concurrent.futures.ThreadPoolExecutor(len(STATUS_PROBES)) as ex:
        return dict(ex.map(probe, STATUS_PROBES))


def elevation_coverage():
    out = {"pieces": [], "terrain": None, "tilesets": []}
    summary = os.path.join(DATA, "elevation", "summary.json")
    if os.path.exists(summary):
        try:
            with open(summary) as f:
                for e in json.load(f):
                    lat_min, lat_max, lon_min, lon_max = e["coords"]
                    out["pieces"].append({"name": os.path.basename(e["file"]),
                                          "bounds": [lon_min, lat_min, lon_max, lat_max]})
        except (OSError, ValueError, KeyError):
            pass
    layer = os.path.join(DATA, "terrain", "layer.json")
    if os.path.exists(layer):
        try:
            with open(layer) as f:
                out["terrain"] = {"bounds": json.load(f).get("bounds")}
        except (OSError, ValueError):
            pass
    for p in sorted(glob.glob(os.path.join(DATA, "mbtiles", "**", "*.mbtiles"), recursive=True)):
        m = mbtiles_info(p)
        try:
            m["bounds"] = [float(v) for v in (m.get("bounds") or "").split(",")]
        except ValueError:
            m["bounds"] = None
        out["tilesets"].append(m)
    return out


POINT_RE = re.compile(r"^-?\d+(\.\d+)?$")


def _parse_points(raw, limit):
    vals = [v for v in (raw or "").split(",") if v != ""]
    if len(vals) % 2 or not vals or not all(POINT_RE.match(v) for v in vals):
        raise ApiError("points must be lat,lon,lat,lon,...")
    if len(vals) // 2 > limit:
        raise ApiError(f"at most {limit} points")
    return vals


def elevation_points(raw):
    """Proxy to open-elevation in batches (its server limits the URL length)."""
    vals = _parse_points(raw, 2000)
    api = stackcheck.endpoints()["elevation"] + "/elevation/v1/ele/"
    data = []
    for i in range(0, len(vals), 2 * 120):
        chunk = ",".join(vals[i:i + 2 * 120])
        code, _, body = stackcheck.get(f"{api}?points={chunk}", timeout=20)
        if code != 200:
            raise ApiError(f"elevation server answered HTTP {code}", 502)
        data += json.loads(body)["data"]
    return {"status": "success", "data": data}


def elevation_grid(raw_bounds, cols, rows):
    """Heights on a cols x rows lattice over a box, for areas too big for the
    1-arc-second carpet. Rows go south to north, like the carpet."""
    try:
        s, w, n, e = [float(v) for v in raw_bounds.split(",")]
        cols, rows = int(cols), int(rows)
    except ValueError:
        raise ApiError("bounds must be south,west,north,east")
    if not (2 <= cols <= 200 and 2 <= rows <= 200 and cols * rows <= 160 * 160):
        raise ApiError("grid too large (at most 160 x 160 samples)")
    if not (-90 <= s < n <= 90 and -180 <= w < e <= 180) or n - s > 3 or e - w > 3:
        raise ApiError("area must be at most 3 by 3 degrees")
    pts = [f"{s + (n - s) * i / (rows - 1):.6f},{w + (e - w) * j / (cols - 1):.6f}"
           for i in range(rows) for j in range(cols)]
    api = stackcheck.endpoints()["elevation"] + "/elevation/v1/ele/"

    def fetch(chunk):
        code, _, body = stackcheck.get(f"{api}?points={','.join(chunk)}", timeout=30)
        if code != 200:
            raise ApiError(f"elevation server answered HTTP {code}", 502)
        return json.loads(body)["data"]

    chunks = [pts[i:i + 120] for i in range(0, len(pts), 120)]
    with concurrent.futures.ThreadPoolExecutor(4) as ex:
        flat = [v for part in ex.map(fetch, chunks) for v in part]
    grid = [flat[i * cols:(i + 1) * cols] for i in range(rows)]
    return {"status": "success", "data": {"carpet": grid, "stats": {
        "min": min(flat), "max": max(flat), "avg": sum(flat) / len(flat)}}}


def elevation_carpet(raw):
    vals = [float(v) for v in _parse_points(raw, 2)]
    if len(vals) != 4:
        raise ApiError("carpet needs two corners: lat,lon,lat,lon")
    if abs(vals[2] - vals[0]) > 0.1 or abs(vals[3] - vals[1]) > 0.1:
        raise ApiError("area too big: at most 0.1 by 0.1 degrees (about 11 km)")
    api = stackcheck.endpoints()["elevation"] + "/elevation/v1/ele/carpet"
    code, _, body = stackcheck.get(f"{api}?points={raw}", timeout=60)
    if code != 200:
        raise ApiError(f"elevation server answered HTTP {code}", 502)
    return json.loads(body)


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = f"gcs-tools/{__version__}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep the container log for errors and jobs
        if not self.path.startswith(("/api/jobs", "/static", "/api/data")):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # -- helpers
    def _send(self, code, body, ctype="application/json; charset=utf-8", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1_000_000:
            raise ApiError("request too large")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            raise ApiError("invalid JSON")

    def _route(self):
        u = urllib.parse.urlparse(self.path)
        return u.path, urllib.parse.parse_qs(u.query)

    def _dispatch(self, handler):
        try:
            handler()
        except ApiError as e:
            self.close_connection = True  # the request body may not have been read
            self._send(e.code, {"error": str(e)}, headers={"Connection": "close"})
        except dockerapi.DockerUnavailable as e:
            self._send(503, {"error": f"Docker not available: {e}"})
        except BrokenPipeError:
            pass
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

    # -- verbs
    def do_GET(self):
        self._dispatch(self._get)

    def do_HEAD(self):
        self._dispatch(self._get)

    def do_POST(self):
        self._dispatch(self._post)

    def do_PUT(self):
        self._dispatch(self._put)

    def do_DELETE(self):
        self._dispatch(self._delete)

    def _get(self):
        path, q = self._route()
        pages = {"/": "portal.html", "/index.html": "portal.html", "/tools": "tools.html",
                 "/elevation": "elevation.html", "/log-splitter": "apps/log-splitter.html"}
        if path in pages:
            return self._static(pages[path])
        if path in ("/tools/", "/elevation/", "/log-splitter/"):
            return self._send(301, b"", headers={"Location": path.rstrip("/")})
        if path.startswith("/static/"):
            return self._static(path[len("/static/"):])
        if path == "/api/info":
            return self._send(200, {
                "version": __version__, "docker": dockerapi.available(), "ports": stackcheck.PORTS,
                "busy": RUNNER.busy(), "cpus": os.cpu_count(), "data": DATA,
            })
        if path == "/api/check":
            eps = stackcheck.endpoints()
            return self._send(200, stackcheck.run(eps, DATA))
        if path == "/api/data":
            return self._send(200, data_overview())
        if path == "/api/status":
            return self._send(200, quick_status())
        if path == "/api/elevation/coverage":
            return self._send(200, elevation_coverage())
        if path == "/api/coverage":
            return self._send(200, coverage())
        if path == "/api/backups":
            points = backups.list_points(BACKUPS)
            for m in points:
                m.pop("dir", None)
            return self._send(200, points)
        if path == "/api/elevation/points":
            return self._send(200, elevation_points(q.get("points", [""])[0]))
        if path == "/api/elevation/grid":
            return self._send(200, elevation_grid(q.get("bounds", [""])[0], q.get("cols", ["0"])[0],
                                                  q.get("rows", ["0"])[0]))
        if path == "/api/elevation/carpet":
            return self._send(200, elevation_carpet(q.get("points", [""])[0]))
        if path == "/api/src/info":
            if q.get("tileset"):
                return self._send(200, mbtiles_source_info(tileset_path(q["tileset"][0])))
            return self._send(200, raster_info(src_path(q.get("path", [""])[0])))
        if path == "/api/jobs":
            return self._send(200, [j.as_dict() for j in reversed(RUNNER.jobs.values())])
        m = re.match(r"^/api/jobs/(\d+)$", path)
        if m:
            job = RUNNER.jobs.get(int(m.group(1)))
            if not job:
                raise ApiError("no such job", 404)
            return self._send(200, job.as_dict(since=int(q.get("since", ["0"])[0])))
        m = re.match(r"^/api/services/([a-z]+)/logs$", path)
        if m:
            project = dockerapi.own_project()
            conts = dockerapi.project_containers(project) if project else {}
            if m.group(1) not in conts:
                raise ApiError("no such service", 404)
            text = dockerapi.logs(conts[m.group(1)]["id"], tail=int(q.get("tail", ["150"])[0]))
            return self._send(200, {"service": m.group(1), "log": text})
        raise ApiError("not found", 404)

    def _static(self, rel):
        path = os.path.realpath(os.path.join(STATIC, rel))
        if not path.startswith(os.path.realpath(STATIC) + os.sep) or not os.path.isfile(path):
            raise ApiError("not found", 404)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        with open(path, "rb") as f:
            self._send(200, f.read(), ctype)

    def _post(self):
        path, _ = self._route()
        if path == "/api/jobs":
            body = self._json_body()
            job = RUNNER.submit(build_job(body.get("kind"), body.get("params") or {}))
            return self._send(200, job.as_dict(since=0))
        m = re.match(r"^/api/jobs/(\d+)/cancel$", path)
        if m:
            return self._send(200, RUNNER.cancel(int(m.group(1))).as_dict())
        m = re.match(r"^/api/services/([a-z]+)/restart$", path)
        if m:
            restart_service(m.group(1))
            return self._send(200, {"restarted": m.group(1)})
        m = re.match(r"^/api/backups/([A-Za-z0-9_-]+)/restore$", path)
        if m:
            job = RUNNER.submit(build_job("restore", {"id": m.group(1)}))
            return self._send(200, job.as_dict(since=0))
        raise ApiError("not found", 404)

    def _put(self):
        path, q = self._route()
        if path != "/api/upload":
            raise ApiError("not found", 404)
        name = os.path.basename((q.get("name", [""])[0]).replace("\\", "/"))
        if not name or name.startswith(".") or name in ("..",):
            raise ApiError("bad file name")
        length = int(self.headers.get("Content-Length") or -1)
        if length < 0:
            raise ApiError("Content-Length required")
        os.makedirs(SRC, exist_ok=True)
        dest = src_path(name)
        if os.path.exists(dest) and q.get("overwrite", ["0"])[0] != "1":
            raise ApiError(f"data/src/{name} already exists", 409)
        tmp = os.path.join(SRC, f".upload-{os.getpid()}-{threading.get_ident()}-{name}")
        left = length
        try:
            with open(tmp, "wb") as f:
                while left > 0:
                    chunk = self.rfile.read(min(left, 4 * 1024 * 1024))
                    if not chunk:
                        raise ApiError("upload interrupted")
                    f.write(chunk)
                    left -= len(chunk)
            os.replace(tmp, dest)
            chown_like_data(dest)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
        return self._send(200, {"name": name, "size": length})

    def _delete(self):
        path, q = self._route()
        m = re.match(r"^/api/backups/([A-Za-z0-9_-]+)$", path)
        if m:
            if any(j.kind == "restore" and j.status in ("queued", "running") for j in RUNNER.jobs.values()):
                raise ApiError("a restore is running; try again when it is done", 409)
            try:
                backups.delete(BACKUPS, m.group(1), log=lambda *_: None)
            except FileNotFoundError:
                raise ApiError("no such restore point", 404)
            except (OSError, ValueError) as e:
                raise ApiError(str(e))
            return self._send(200, {"deleted": m.group(1)})
        if path != "/api/src":
            raise ApiError("not found", 404)
        target = src_path(q.get("path", [""])[0])
        if target == os.path.realpath(SRC):
            raise ApiError("refusing to delete data/src itself")
        if os.path.isdir(target):
            shutil.rmtree(target)
        elif os.path.exists(target):
            os.remove(target)
        else:
            raise ApiError("not found", 404)
        return self._send(200, {"deleted": q.get("path", [""])[0]})


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def build_parser(p=None):
    p = p or argparse.ArgumentParser(prog="serve", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=int(os.environ.get("GCS_TOOLS_PORT", "8095")))
    p.add_argument("--bind", default="0.0.0.0")
    return p


def main(argv=None, args=None):
    if args is None:
        args = build_parser().parse_args(argv)
    os.makedirs(SRC, exist_ok=True)
    chown_like_data(SRC)
    RUNNER.start()
    srv = Server((args.bind, args.port), Handler)
    print(f"tools page on http://{args.bind}:{args.port}/  (data: {DATA}, "
          f"docker: {'yes' if dockerapi.available() else 'no'})", flush=True)
    def stop(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for job in list(RUNNER.jobs.values()):
            if job.status == "running":
                RUNNER.cancel(job.id)
        srv.server_close()


if __name__ == "__main__":
    main()
