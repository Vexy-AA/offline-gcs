"""Give an .mbtiles file the index a tile server needs to find tiles quickly.

    ./gcs-tools index-mbtiles data/mbtiles/custom.mbtiles

Without an index on tiles(zoom_level, tile_column, tile_row), every tile the
file doesn't have means reading the whole file: as soon as a map shows ground
outside the imagery (or zooms past its last level) the tile server spends its
time reading gigabytes, and maps stop loading. Files made by this stack have
the index; files from other tools sometimes don't.

Like add-mbtiles, nothing is changed in place: the file is copied to
data/.work, indexed and checked there, then swapped in with one atomic rename,
and the previous file becomes a restore point. A deduplicated file (map +
images tables behind a tiles view) is stored as a plain tiles table on the way,
as add-mbtiles does.
"""

import argparse
import os
import re
import shutil
import sqlite3
import sys
import time

from . import add_mbtiles, backups
from .common import fmt_size, fmt_time
from .tilesource import open_ro

QUERY = "SELECT tile_data FROM tiles WHERE zoom_level=1 AND tile_column=1 AND tile_row=1"


def has_index(path):
    """True if a tile lookup in the file uses an index (no full scan anywhere in the plan)."""
    db = open_ro(path)
    try:
        plan = " | ".join(r[-1] for r in db.execute("EXPLAIN QUERY PLAN " + QUERY))
    finally:
        db.close()
    return not re.search(r"\bSCAN\b", plan)


def build_parser(p=None):
    p = p or argparse.ArgumentParser(prog="index-mbtiles", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("target", help="the .mbtiles file (usually data/mbtiles/custom.mbtiles)")
    p.add_argument("--dry-run", action="store_true", help="only say whether it needs an index")
    return p


def main(argv=None, args=None):
    if args is None:
        args = build_parser().parse_args(argv)
    t0 = time.time()
    target = os.path.abspath(args.target)
    if not os.path.isfile(target):
        sys.exit(f"ERROR: {args.target} not found")
    try:
        indexed = has_index(target)
    except sqlite3.Error as e:
        sys.exit(f"ERROR: {args.target} can't be read ({e}); run 'gcs-tools inspect' on it")
    if indexed:
        print(f"{os.path.basename(target)} already has an index on its tile numbers: nothing to do.")
        return
    size = os.path.getsize(target)
    print(f"{os.path.basename(target)} ({fmt_size(size)}) has no index on its tile numbers.")
    root = backups.root_of(os.path.dirname(target))
    need = int(size * 1.25) + 64 * 2**20
    free = shutil.disk_usage(root).free
    print(f"  disk: needs about {fmt_size(need)} in {os.path.join(root, '.work')}, {fmt_size(free)} free")
    if args.dry_run:
        print("Dry run: nothing changed.")
        return
    if free < need:
        sys.exit(f"ERROR: not enough free disk space ({fmt_size(free)} free, about {fmt_size(need)} needed)")
    name = os.path.splitext(os.path.basename(target))[0]
    work = os.path.join(root, ".work", f"index-{name}")
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    try:
        out = os.path.join(work, os.path.basename(target))
        print(f"Copying {args.target} to {out}")
        add_mbtiles._copy(target, out)
        db = sqlite3.connect(out)
        db.execute("PRAGMA journal_mode=OFF")
        db.execute("PRAGMA synchronous=OFF")
        add_mbtiles._prepare_target(db)
        print("Checking it")
        check = db.execute("PRAGMA quick_check").fetchone()[0]
        db.close()
        if check != "ok":
            sys.exit(f"ERROR: the indexed copy failed SQLite's check ({check}); nothing was changed")
        if not has_index(out):
            sys.exit("ERROR: the copy still has no usable index; nothing was changed")
        change = backups.Change("mbtiles", root, os.path.relpath(target, root),
                                f"Map tiles: indexed {os.path.basename(target)}")
        change.put(os.path.relpath(target, root), out)
        change.install()
        print(f"Done in {fmt_time(time.time() - t0)}: {os.path.basename(target)} is indexed "
              f"({fmt_size(os.path.getsize(target))}).")
    finally:
        shutil.rmtree(work, ignore_errors=True)
        try:
            os.rmdir(os.path.dirname(work))
        except OSError:
            pass


if __name__ == "__main__":
    main()
