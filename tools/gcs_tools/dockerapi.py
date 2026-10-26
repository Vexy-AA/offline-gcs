"""Tiny Docker Engine API client (unix socket, stdlib only).

Used by the tools page to show the stack's container status and logs and to
restart a server after its data changed. Works only when
/var/run/docker.sock is mounted into the tools container; every function
fails soft (returns None / raises DockerUnavailable) otherwise.
"""

import http.client
import json
import os
import socket
import urllib.parse

SOCKET = os.environ.get("DOCKER_SOCKET", "/var/run/docker.sock")
# Servers the page may restart. The tools container itself is not in the list.
RESTARTABLE = ("mbtiles", "terrain", "elevation", "logviewer", "webtools")


class DockerUnavailable(Exception):
    pass


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=10):
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._path)
        self.sock = s


def _request(method, path, timeout=10):
    if not os.path.exists(SOCKET):
        raise DockerUnavailable("Docker socket not mounted")
    conn = _UnixConnection(SOCKET, timeout=timeout)
    try:
        conn.request(method, path, headers={"Host": "docker"})
        resp = conn.getresponse()
        body = resp.read()
    except PermissionError as e:
        raise DockerUnavailable(f"no permission on {SOCKET}") from e
    except OSError as e:
        raise DockerUnavailable(str(e)) from e
    finally:
        conn.close()
    if resp.status >= 400:
        raise DockerUnavailable(f"Docker API {method} {path}: HTTP {resp.status} {body[:200]!r}")
    return body


def available():
    try:
        _request("GET", "/_ping", timeout=3)
        return True
    except DockerUnavailable:
        return False


def own_project():
    """Compose project name of the container we run in (None if unknown)."""
    try:
        info = json.loads(_request("GET", f"/containers/{socket.gethostname()}/json"))
        return info["Config"]["Labels"].get("com.docker.compose.project")
    except (DockerUnavailable, KeyError, ValueError):
        return os.environ.get("COMPOSE_PROJECT_NAME")


def project_containers(project):
    """{service: {state, status, restart_count, id}} for one compose project."""
    filters = json.dumps({"label": [f"com.docker.compose.project={project}"]})
    items = json.loads(_request("GET", "/containers/json?all=1&filters=" + urllib.parse.quote(filters)))
    out = {}
    for c in items:
        labels = c.get("Labels", {})
        svc = labels.get("com.docker.compose.service")
        if not svc or labels.get("com.docker.compose.oneoff") == "True":
            continue
        out[svc] = {"state": c.get("State"), "status": c.get("Status"), "id": c.get("Id")}
    for svc, info in out.items():
        try:
            detail = json.loads(_request("GET", f"/containers/{info['id']}/json"))
            info["restart_count"] = detail.get("RestartCount", 0)
            info["started_at"] = detail.get("State", {}).get("StartedAt")
        except DockerUnavailable:
            pass
    return out


def _demux(raw):
    """Docker log stream (non-TTY) -> text. Frames: 8-byte header + payload."""
    out, i = [], 0
    while i + 8 <= len(raw):
        size = int.from_bytes(raw[i + 4:i + 8], "big")
        out.append(raw[i + 8:i + 8 + size])
        i += 8 + size
    if i == 0 and raw:  # TTY container: plain stream
        return raw.decode("utf-8", "replace")
    return b"".join(out).decode("utf-8", "replace")


def logs(container_id, tail=80):
    raw = _request("GET", f"/containers/{container_id}/logs?stdout=1&stderr=1&timestamps=0&tail={int(tail)}")
    return _demux(raw)


def restart(container_id, timeout=10):
    _request("POST", f"/containers/{container_id}/restart?t={int(timeout)}", timeout=timeout + 30)
