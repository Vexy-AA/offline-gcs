"""Test the tile server (gcs_tools.tileserver): same answers as mbtileserver, and it keeps
answering while files are replaced, copied over, broken or slow to read.

    python3 tests/tileserver_test.py                       # from the tools/ folder
    docker compose run --rm --entrypoint python3 tools /opt/gcs-tools/tests/tileserver_test.py
    MBTILESERVER=/path/to/mbtileserver python3 tests/tileserver_test.py   # also compare with it

Exits non-zero on the first failure.
"""
import base64
import gzip
import http.client
import json
import os
import random
import shutil
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)
PY = os.environ.get("PYTHON", sys.executable)
FAILS = []


def check(cond, what):
    print(("  ok    " if cond else "  FAIL  ") + what, flush=True)
    if not cond:
        FAILS.append(what)
        raise SystemExit(f"FAILED: {what}")


# ----- tile files -----

def png(color, size=256):
    """A real (decodable) single-colour PNG."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = (b"\x00" + bytes(color) * size) * size
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


# a real 8x8 baseline JPEG (grey); the server reads its width from the SOF0 header, so patch it to 256
JPEG_8 = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19i"
    "Z2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj"
    "Y2NjY2NjY2P/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUF"
    "BAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW"
    "V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi"
    "4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC"
    "AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVm"
    "Z2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq"
    "8vP09fb3+Pn6/9oADAMBAAIRAxEAPwAooooA/9k=")


def jpeg(size=256):
    b = bytearray(JPEG_8)
    i = b.index(b"\xff\xc0")
    b[i + 5:i + 7] = struct.pack(">H", size)
    b[i + 7:i + 9] = struct.pack(">H", size)
    return bytes(b)


def tile_range(z, west=30.0, south=49.0, east=30.6, north=49.5):
    import math
    def tx(lon):
        return int((lon + 180) / 360 * (1 << z))
    def ty(lat):
        r = math.radians(lat)
        return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * (1 << z))
    return range(tx(west), tx(east) + 1), range(ty(north), ty(south) + 1)


def make_set(path, maxz=10, tile=lambda z, x, y: png((z * 20 % 256, x % 256, y % 256)), meta=None, layout="plain",
             index=True, extra_rows=0):
    if os.path.exists(path):
        os.remove(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=OFF")
    db.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
    m = {"name": os.path.splitext(os.path.basename(path))[0], "format": "png", "minzoom": "0",
         "maxzoom": str(maxz), "bounds": "30,49,30.6,49.5", "center": "30.3,49.25,8", "attribution": "test"}
    m.update(meta or {})
    db.executemany("INSERT INTO metadata VALUES (?,?)", [(k, v) for k, v in m.items() if v is not None])
    rows = []
    for z in range(maxz + 1):
        xs, ys = tile_range(z)
        for x in xs:
            for y in ys:
                rows.append((z, x, (1 << z) - 1 - y, tile(z, x, y)))
    if layout == "plain":
        db.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
        db.executemany("INSERT INTO tiles VALUES (?,?,?,?)", rows)
        if extra_rows:  # far away, to make a file without an index slow to search
            db.execute("INSERT INTO tiles SELECT 22, v % 4000000, v / 4000000, x'00' FROM (WITH RECURSIVE "
                       "c(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM c WHERE v < ?) SELECT v FROM c)", (extra_rows,))
        if index:
            db.execute("CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row)")
    else:  # deduplicated: map + images + tiles view
        db.executescript("""
            CREATE TABLE map (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_id TEXT);
            CREATE TABLE images (tile_data BLOB, tile_id TEXT);
            CREATE UNIQUE INDEX map_index ON map (zoom_level, tile_column, tile_row);
            CREATE UNIQUE INDEX images_id ON images (tile_id);
            CREATE VIEW tiles AS SELECT map.zoom_level AS zoom_level, map.tile_column AS tile_column,
                map.tile_row AS tile_row, images.tile_data AS tile_data FROM map JOIN images ON images.tile_id = map.tile_id;
        """)
        seen = set()
        for z, x, r, data in rows:
            tid = str(zlib.crc32(data))
            db.execute("INSERT INTO map VALUES (?,?,?,?)", (z, x, r, tid))
            if tid not in seen:
                seen.add(tid)
                db.execute("INSERT INTO images VALUES (?,?)", (data, tid))
    db.commit()
    db.close()
    return rows


# ----- servers -----

def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def wait_up(port, proc, what):
    for _ in range(100):
        if proc.poll() is not None:
            raise SystemExit(f"{what} exited: see its log")
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/services", timeout=1).read()
            return
        except OSError:
            time.sleep(0.1)
    raise SystemExit(f"{what} did not start")


def start_ours(folder, port, logf, *extra):
    env = dict(os.environ, PYTHONPATH=TOOLS)
    proc = subprocess.Popen([PY, "-m", "gcs_tools.tileserver", "--dir", folder, "--port", str(port),
                             "--host", "127.0.0.1", "--missing-image-tile-404", *extra],
                            stdout=logf, stderr=subprocess.STDOUT, env=env)
    wait_up(port, proc, "the tile server")
    return proc


def get(port, path, timeout=30, headers=None):
    """(status, headers, body); headers lower-cased."""
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        c.request("GET", path, headers=headers or {})
        r = c.getresponse()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
    finally:
        c.close()


def status(port):
    return json.loads(get(port, "/status")[2])


class Load:
    """Threads asking for tiles over kept-alive connections (like map views); new connections now and then."""

    def __init__(self, port, urls, threads=8, new_conn_every=20):
        self.port, self.urls, self.stop = port, urls, threading.Event()
        self.codes, self.lock, self.slowest = {}, threading.Lock(), 0.0
        self.bodies = {}
        self.ts = [threading.Thread(target=self._run, args=(new_conn_every,), daemon=True) for _ in range(threads)]
        for t in self.ts:
            t.start()

    def _run(self, every):
        c, n = None, 0
        while not self.stop.is_set():
            if c is None or n % every == 0:
                if c:
                    c.close()
                c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
            n += 1
            url = random.choice(self.urls)
            t = time.monotonic()
            try:
                c.request("GET", url)
                r = c.getresponse()
                body, code = r.read(), r.status
            except OSError:
                code, body, c = "conn", b"", None
            with self.lock:
                self.codes[code] = self.codes.get(code, 0) + 1
                self.slowest = max(self.slowest, time.monotonic() - t)
                if code == 200:
                    self.bodies[url] = body

    def take(self):
        with self.lock:
            codes, self.codes, slowest, self.slowest = self.codes, {}, self.slowest, 0.0
        return codes, slowest

    def end(self):
        self.stop.set()
        for t in self.ts:
            t.join()


def replace(src, dst, work):
    """What add-mbtiles / a restore do: copy aside, then one rename."""
    tmp = os.path.join(work, os.path.basename(dst) + ".new")
    shutil.copyfile(src, tmp)
    os.replace(tmp, dst)


# ----- tests -----

def compare_with_mbtileserver(binary, folder, ours, base_urls):
    port = free_port()
    with open(os.path.join(folder, "..", "mbtileserver.log"), "w") as logf:
        proc = subprocess.Popen([binary, "--dir", folder, "-p", str(port), "--missing-image-tile-404"],
                                stdout=logf, stderr=subprocess.STDOUT)
        try:
            wait_up(port, proc, "mbtileserver")
            for url in base_urls:
                a = get(port, url, headers={"Origin": "http://example.com"})
                b = get(ours, url, headers={"Origin": "http://example.com"})
                ba = a[2].replace(str(port).encode(), b"PORT")
                bb = b[2].replace(str(ours).encode(), b"PORT")
                same = (a[0], a[1].get("content-type"), ba) == (b[0], b[1].get("content-type"), bb)
                if not same:
                    print(f"     mbtileserver: {a[0]} {a[1].get('content-type')} {ba[:200]!r}")
                    print(f"     ours:         {b[0]} {b[1].get('content-type')} {bb[:200]!r}")
                check(same, f"same answer as mbtileserver: {url}")
        finally:
            proc.terminate()
            proc.wait()


def main():
    work = tempfile.mkdtemp(prefix="tileserver-test.")
    folder = os.path.join(work, "mbtiles")
    side = os.path.join(work, "side")  # where new versions are prepared (like data/.work)
    os.makedirs(side)
    print("== tile sets in the layouts tools write")
    rows = make_set(os.path.join(folder, "custom.mbtiles"))
    make_set(os.path.join(folder, "photo.mbtiles"), maxz=8, tile=lambda z, x, y: jpeg(),
             meta={"format": "jpg", "minzoom": None, "maxzoom": None, "json": '{"extra": [1, 2]}'})
    make_set(os.path.join(folder, "sub", "dedup.mbtiles"), maxz=8, layout="dedup")
    make_set(os.path.join(folder, "odd #name.mbtiles"), maxz=6)
    make_set(os.path.join(folder, "retina.mbtiles"), maxz=5, tile=lambda z, x, y: png((9, 9, 9), 512))
    make_set(os.path.join(folder, "vector.mbtiles"), maxz=4, tile=lambda z, x, y: gzip.compress(b"\x1a\x00" * 20),
             meta={"format": "pbf"})
    z, x, r, data = rows[len(rows) // 2]
    y = (1 << z) - 1 - r
    tile_url = f"/services/custom/tiles/{z}/{x}/{y}.png"

    logpath = os.path.join(work, "tileserver.log")
    logf = open(logpath, "w")
    port = free_port()
    proc = start_ours(folder, port, logf, "--queue-wait", "2", "--read-limit", "1.5", "--slots", "4")
    try:
        urls = ["/services", "/services/", "/services/custom", "/services/custom?key=abc", tile_url,
                tile_url[:-4], tile_url.replace(".png", ".jpg"), "/services/custom/tiles/3/0/0.png",
                f"/services/custom/tiles/3/{1 << 3}/0.png", "/services/custom/tiles/a/b/c.png",
                "/services/photo", "/services/photo/tiles/8/149/86.jpg", "/services/sub/dedup",
                f"/services/sub/dedup/tiles/{z if z <= 8 else 8}/0/0.png",
                "/services/odd%20%23name", "/services/retina", "/services/vector", "/services/vector/tiles/0/0/0.pbf",
                "/services/vector/tiles/4/1/1.pbf", "/services/nope", "/services/nope/tiles/1/1/1.png", "/nothing"]
        print("== answers")
        code, h, body = get(port, tile_url)
        check(code == 200 and body == data and h["content-type"] == "image/png", "a tile comes back byte for byte")
        check(get(port, "/services/custom/tiles/3/0/0.png")[0] == 404, "a missing tile is 404")
        tj = json.loads(get(port, "/services/custom")[2])
        check(tj["tiles"][0].endswith("/services/custom/tiles/{z}/{x}/{y}.png") and tj["bounds"] == [30, 49, 30.6, 49.5]
              and tj["maxzoom"] == 10 and tj["tilesize"] == 256 and tj["map"].endswith("/services/custom/map"),
              "TileJSON: tiles URL, bounds, zooms, tile size, map")
        tj = json.loads(get(port, "/services/photo")[2])
        check(tj["format"] == "jpg" and (tj["minzoom"], tj["maxzoom"]) == (0, 8) and tj["extra"] == [1, 2]
              and tj["tilesize"] == 256, "JPEG set: zooms read from the tiles, 'json' metadata merged")
        check(json.loads(get(port, "/services/retina")[2])["tilesize"] == 512, "512 px tiles are detected")
        names = sorted(s["name"] for s in json.loads(get(port, "/services")[2]))
        check(names == ["custom", "dedup", "odd #name", "photo", "retina", "vector"], f"all sets listed: {names}")
        code, h, body = get(port, "/services/vector/tiles/0/0/0.pbf")
        check(code == 200 and h.get("content-encoding") == "gzip", "vector tiles: gzip encoding")
        code, h, body = get(port, "/services/custom/map")
        check(code == 200 and b"leaflet" in body and get(port, "/_static/leaflet/leaflet.js")[0] == 200,
              "preview map page and its Leaflet")
        check(get(port, tile_url, headers={"Origin": "http://x"})[1].get("access-control-allow-origin") == "*", "CORS")
        if os.environ.get("MBTILESERVER"):
            print("== compared with mbtileserver")
            compare_with_mbtileserver(os.environ["MBTILESERVER"], folder, port, urls)

        print("== a new version renamed in while maps are loading (add-mbtiles, a restore)")
        all_tiles = [f"/services/custom/tiles/{z}/{x}/{(1 << z) - 1 - r}.png" for z, x, r, _ in rows if z >= 6]
        load = Load(port, all_tiles)
        time.sleep(1)
        load.take()
        v2 = os.path.join(side, "v2.mbtiles")
        rows2 = make_set(v2, tile=lambda z, x, y: png((200, z, 7)))
        t_replace = time.monotonic()
        replace(v2, os.path.join(folder, "custom.mbtiles"), side)
        new = dict(((z, x, r), d) for z, x, r, d in rows2)[(z, x, r)]
        while get(port, tile_url)[2] != new and time.monotonic() - t_replace < 10:
            time.sleep(0.05)
        took = time.monotonic() - t_replace
        time.sleep(1)
        codes, slowest = load.take()
        check(took < 2.5, f"the new version is served {took:.1f} s after the rename")
        check(set(codes) == {200}, f"no request failed meanwhile: {codes}, slowest {slowest:.2f} s")

        print("== a broken file renamed in: the previous version is still served")
        cut = os.path.join(side, "cut.mbtiles")
        with open(v2, "rb") as f, open(cut, "wb") as g:
            g.write(f.read(os.path.getsize(v2) // 3))
        os.replace(cut, os.path.join(folder, "custom.mbtiles"))
        time.sleep(2.5)
        codes, slowest = load.take()
        st = status(port)
        cs = next(t for t in st["tilesets"] if t["id"] == "custom")
        check(set(codes) == {200}, f"all requests still answered: {codes}")
        check(get(port, tile_url)[2] == new, "with the previous version's tiles")
        check("shorter than its header" in (cs["problem"] or ""), f"/status says why: {cs['problem']}")
        replace(v2, os.path.join(folder, "custom.mbtiles"), side)
        time.sleep(1.5)
        st = status(port)
        check(next(t for t in st["tilesets"] if t["id"] == "custom")["problem"] is None, "a good file clears it")

        print("== copied over in place (a copy into data/mbtiles): served again once the copy is done")
        v3 = os.path.join(side, "v3.mbtiles")
        rows3 = make_set(v3, tile=lambda z, x, y: png((5, 200, z)))
        new3 = dict(((z, x, r), d) for z, x, r, d in rows3)[(z, x, r)]
        with open(v3, "rb") as f, open(os.path.join(folder, "custom.mbtiles"), "r+b") as g:
            g.truncate(0)
            while True:
                b = f.read(256 * 1024)
                if not b:
                    break
                g.write(b)
                g.flush()
                time.sleep(0.02)
        t = time.monotonic()
        while get(port, tile_url)[2] != new3 and time.monotonic() - t < 10:
            time.sleep(0.1)
        check(get(port, tile_url)[2] == new3, f"the copied file is served {time.monotonic() - t:.1f} s after the copy")
        load.take()
        time.sleep(1)
        codes, _ = load.take()
        check(set(codes) == {200}, f"and every request is answered after it: {codes}")
        load.end()

        print("== files appear and disappear")
        make_set(os.path.join(side, "late.mbtiles"), maxz=3)
        os.replace(os.path.join(side, "late.mbtiles"), os.path.join(folder, "late.mbtiles"))
        time.sleep(2.5)
        check(any(s["name"] == "late" for s in json.loads(get(port, "/services")[2])), "a new file is listed")
        os.remove(os.path.join(folder, "late.mbtiles"))
        time.sleep(2.5)
        check(not any(s["name"] == "late" for s in json.loads(get(port, "/services")[2])), "a removed one is not")

        print("== a -journal next to the file (a writer in the middle of a change)")
        open(os.path.join(folder, "custom.mbtiles-journal"), "wb").write(b"x" * 512)
        os.utime(os.path.join(folder, "custom.mbtiles"))
        time.sleep(1.5)
        get(port, tile_url)
        cs = next(t for t in status(port)["tilesets"] if t["id"] == "custom")
        check("-journal" in (cs["problem"] or ""), "reported in /status")
        # SQLite won't read past a leftover journal (it must roll it back first): tiles fail until it is gone
        os.remove(os.path.join(folder, "custom.mbtiles-journal"))
        os.utime(os.path.join(folder, "custom.mbtiles"))
        time.sleep(1.5)
        get(port, tile_url)
        check(next(t for t in status(port)["tilesets"] if t["id"] == "custom")["problem"] is None
              and get(port, tile_url)[0] == 200, "cleared, and tiles answered again, once it is gone")
    finally:
        proc.terminate()
        proc.wait()

    print("== a file without an index, a map asking for tiles it doesn't have, clients giving up")
    slow = os.path.join(work, "slow")
    make_set(os.path.join(slow, "custom.mbtiles"), maxz=6, index=False, extra_rows=3_000_000)
    port = free_port()
    proc = start_ours(slow, port, logf, "--queue-wait", "2", "--read-limit", "1.5", "--slots", "4")
    try:
        t = time.monotonic()
        get(port, "/services/custom/tiles/12/1/1.png")
        one = time.monotonic() - t
        print(f"     one missing tile takes {one:.2f} s (whole-file search)")

        def give_up():
            try:
                c = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                c.request("GET", f"/services/custom/tiles/12/{random.randint(0, 4000)}/{random.randint(0, 4000)}.png")
                c.getresponse().read()
            except OSError:
                pass
        threads = [threading.Thread(target=give_up) for _ in range(150)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        t = time.monotonic()
        code = get(port, "/services/custom/map", timeout=60)[0]
        took = time.monotonic() - t
        check(code == 200 and took < 1, f"the map page still answers at once ({took:.2f} s)")
        t = time.monotonic()
        code = get(port, "/services", timeout=60)[0]
        check(code == 200 and time.monotonic() - t < 1, "and the tile set list")
        t = time.monotonic()
        code = get(port, "/services/custom/tiles/12/2/2.png", timeout=60)[0]
        took = time.monotonic() - t
        check(code in (404, 503) and took < 2 + 1.5 + 1, f"a tile answers {code} within the limits ({took:.1f} s)")
        time.sleep(2.5)
        t = time.monotonic()
        code = get(port, "/services/custom/tiles/12/3/3.png", timeout=60)[0]
        check(code == 404, f"after the burst a tile is answered normally ({code}, {time.monotonic() - t:.2f} s)")
        st = status(port)
        cs = st["tilesets"][0]
        check(cs["indexed"] is False and st["counts"].get("busy", 0) > 0, "/status: no index, requests turned away")
    finally:
        proc.terminate()
        proc.wait()
        logf.close()

    print("== log")
    with open(logpath) as f:
        for line in f:
            if any(w in line for w in ("loaded", "reloaded", "shorter", "journal", "busy", "slow", "no index",
                                       "gone", "error")):
                print("     " + line.rstrip()[:200])
    shutil.rmtree(work, ignore_errors=True)
    print("TILESERVER TEST PASSED")


if __name__ == "__main__":
    main()
