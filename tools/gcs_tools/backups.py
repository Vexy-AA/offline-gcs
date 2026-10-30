"""Restore points for the add-* tools, and the command to list / restore / delete them.

Every add-mbtiles, add-terrain and add-elevation run that changes something
first records what it is about to change in data/backups/<id>/:

  manifest.json   which files were added, replaced or removed
  files/...       the previous version of every replaced or removed file

The old files are kept by hard link where possible, so a restore point of a
multi-GB .mbtiles costs no extra disk space until the file is replaced. The
manifest is written before anything is touched, so even an install that was
interrupted half-way can be undone. data/backups is outside every folder a
server reads, so nothing in it is ever served.

    ./gcs-tools backups                      list restore points
    ./gcs-tools backups restore <id>         put the previous files back
    ./gcs-tools backups delete <id>          drop a restore point (frees its space)

Restore points of one target are undone newest first: restoring an older one
while a newer one exists would mix files of two different states, so it is
refused (unless --force).
"""

import argparse
import errno
import json
import os
import shutil
import sys
import time

MANIFEST = "manifest.json"


def root_of(folder):
    """The data folder that holds `folder` (data/terrain -> data): restore points go in data/backups,
    work files in data/.work, next to the served folders but never inside one."""
    return os.path.dirname(os.path.abspath(folder))


def _link_or_copy(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        os.link(src, dst)
    except OSError as e:
        if e.errno not in (errno.EXDEV, errno.EPERM, errno.EMLINK, errno.ENOTSUP, errno.EOPNOTSUPP):
            raise
        shutil.copy2(src, dst)


def _move(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    try:
        os.replace(src, dst)
    except OSError as e:
        if e.errno != errno.EXDEV:
            raise
        shutil.copy2(src, dst + ".tmp")
        os.replace(dst + ".tmp", dst)
        os.remove(src)


class Change:
    """A set of file changes under one root (usually data/), installed with a restore point.

    put(live, staged)   live file is replaced by (or created from) the staged file
    remove(live)        live file is removed
    Paths are relative to `root`.
    """

    def __init__(self, kind, root, target, title, backup_dir=None, details=None):
        self.kind, self.root, self.target, self.title = kind, os.path.abspath(root), target, title
        self.backup_dir = os.path.abspath(backup_dir or os.path.join(self.root, "backups"))
        self.details = details or {}
        self.puts, self.removes = [], []

    def put(self, live_rel, staged_abs):
        self.puts.append((live_rel, staged_abs))

    def remove(self, live_rel):
        self.removes.append(live_rel)

    def __len__(self):
        return len(self.puts) + len(self.removes)

    def install(self, log=print):
        """Back up what is replaced/removed, then swap the new files in. Returns the restore point id."""
        stamp = time.strftime("%Y%m%d-%H%M%S")
        rid = f"{stamp}-{self.kind}"
        n = 1
        while os.path.exists(os.path.join(self.backup_dir, rid)):
            n += 1
            rid = f"{stamp}-{self.kind}-{n}"
        bdir = os.path.join(self.backup_dir, rid)
        os.makedirs(os.path.join(bdir, "files"))

        entries = []
        for live, _ in self.puts:
            entries.append({"path": live, "existed": os.path.exists(os.path.join(self.root, live))})
        for live in self.removes:
            entries.append({"path": live, "existed": os.path.exists(os.path.join(self.root, live))})
        manifest = {
            "id": rid, "kind": self.kind, "target": self.target, "title": self.title,
            "created": time.time(), "state": "installing", "details": self.details,
            "added": sum(1 for e in entries if not e["existed"]),
            "replaced": sum(1 for e in entries[:len(self.puts)] if e["existed"]),
            "removed": sum(1 for e in entries[len(self.puts):] if e["existed"]),
            "entries": entries,
        }
        _write_manifest(bdir, manifest)

        # 1. keep the previous version of everything that is about to change
        for e in entries:
            if e["existed"]:
                _link_or_copy(os.path.join(self.root, e["path"]), os.path.join(bdir, "files", e["path"]))
        # 2. swap in (each file atomically)
        for live, staged in self.puts:
            _move(staged, os.path.join(self.root, live))
        for live in self.removes:
            p = os.path.join(self.root, live)
            if os.path.exists(p):
                os.remove(p)
        manifest["state"] = "done"
        _write_manifest(bdir, manifest)
        log(f"Restore point {rid}: {manifest['added']} added, {manifest['replaced']} replaced, "
            f"{manifest['removed']} removed (undo: ./gcs-tools backups restore {rid})")
        return rid


def _write_manifest(bdir, manifest):
    tmp = os.path.join(bdir, MANIFEST + ".tmp")
    with open(tmp, "w") as f:
        json.dump(manifest, f, indent=1)
    os.replace(tmp, os.path.join(bdir, MANIFEST))


def _dir_size(path):
    total = 0
    for dirpath, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass
    return total


def list_points(backup_dir, with_size=True):
    out = []
    if not os.path.isdir(backup_dir):
        return out
    for name in sorted(os.listdir(backup_dir)):
        mpath = os.path.join(backup_dir, name, MANIFEST)
        try:
            with open(mpath) as f:
                m = json.load(f)
        except (OSError, ValueError):
            continue
        m.pop("entries", None)
        m["dir"] = os.path.join(backup_dir, name)
        if with_size:
            m["size"] = _dir_size(os.path.join(backup_dir, name, "files"))
        out.append(m)
    out.sort(key=lambda m: m.get("created", 0))
    newest = {}
    for m in out:
        newest[(m["kind"], m["target"])] = m["id"]
    for m in out:
        m["restorable"] = newest[(m["kind"], m["target"])] == m["id"]
    return out


def _load(backup_dir, rid):
    if not rid or "/" in rid or rid.startswith("."):
        raise ValueError("bad restore point id")
    bdir = os.path.join(backup_dir, rid)
    with open(os.path.join(bdir, MANIFEST)) as f:
        return bdir, json.load(f)


def restore(backup_dir, root, rid, force=False, log=print):
    bdir, m = _load(backup_dir, rid)
    if not force:
        newer = [p["id"] for p in list_points(backup_dir, with_size=False)
                 if p["kind"] == m["kind"] and p["target"] == m["target"] and p["created"] > m["created"]]
        if newer:
            raise ValueError(f"restore the newer restore point(s) of {m['target']} first: {', '.join(newer)}")
    root = os.path.abspath(root)
    put_back = gone = 0
    dirs = set()
    for e in m["entries"]:
        live = os.path.join(root, e["path"])
        if e["existed"]:
            src = os.path.join(bdir, "files", e["path"])
            if os.path.exists(src):
                _move(src, live)
                put_back += 1
        elif os.path.exists(live):
            os.remove(live)
            gone += 1
            dirs.add(os.path.dirname(live))
    # remove folders the change created and that are empty again (terrain z/x folders)
    for d in sorted(dirs, key=len, reverse=True):
        while d.startswith(root + os.sep) and d != root:
            try:
                os.rmdir(d)
            except OSError:
                break
            d = os.path.dirname(d)
    shutil.rmtree(bdir, ignore_errors=True)
    log(f"Restored {rid}: {put_back} files put back, {gone} added files removed.")
    return m


def delete(backup_dir, rid, log=print):
    bdir, m = _load(backup_dir, rid)
    shutil.rmtree(bdir)
    log(f"Deleted restore point {rid}.")
    return m


def fmt_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} GB"


def build_parser(p=None):
    p = p or argparse.ArgumentParser(prog="backups", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("action", nargs="?", choices=["list", "restore", "delete"], default="list")
    p.add_argument("id", nargs="?", help="restore point id (from the list)")
    p.add_argument("--data", default=None, help="data folder (default: ./data, or . when run inside it)")
    p.add_argument("--force", action="store_true", help="restore even if newer restore points exist")
    p.add_argument("--json", action="store_true", help="list as JSON")
    return p


def main(argv=None, args=None):
    if args is None:
        args = build_parser().parse_args(argv)
    root = args.data or next((d for d in ("data", ".") if os.path.isdir(os.path.join(d, "backups"))
                              or os.path.isdir(os.path.join(d, "mbtiles"))), "data")
    root = os.path.abspath(root)
    bdir = os.path.join(root, "backups")
    if args.action == "list":
        points = list_points(bdir)
        if args.json:
            print(json.dumps(points, indent=1))
            return
        if not points:
            print(f"No restore points in {bdir}.")
            return
        for m in points:
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(m["created"]))
            state = "" if m.get("state") == "done" else f"  [{m.get('state')}]"
            print(f"{m['id']}  {when}  {m['title']}  (+{m['added']} ~{m['replaced']} -{m['removed']}, "
                  f"{fmt_size(m['size'])}){'' if m['restorable'] else '  (restore newer first)'}{state}")
        return
    if not args.id:
        sys.exit("ERROR: give the restore point id (see: ./gcs-tools backups)")
    try:
        if args.action == "restore":
            m = restore(bdir, root, args.id, force=args.force)
            if m["kind"] == "elevation":
                summary = os.path.join(root, "elevation", "summary.json")
                if os.path.exists(summary):
                    os.remove(summary)
                print("Removed summary.json; restart the elevation server: docker compose restart elevation")
            elif m["kind"] == "terrain":
                print("Hard-refresh the browser (terrain tiles are cached by version).")
        else:
            delete(bdir, args.id)
    except (OSError, ValueError) as e:
        sys.exit(f"ERROR: {e}")


if __name__ == "__main__":
    main()
