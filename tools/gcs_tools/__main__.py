"""offline-gcs data tools.

  mbtiles        imagery raster(s) or a {z}/{x}/{y} tile folder -> .mbtiles (mbtileserver)
  terrain        DEM raster(s) -> Cesium quantized-mesh tiles + layer.json (terrain server)
  elevation      split a DEM into pieces for open-elevation (uses its create-tiles.sh)
  add-mbtiles    add a new area to an existing .mbtiles (keeps what is there)
  add-terrain    add a new area to existing terrain (only tiles touching it are remade)
  add-elevation  add a new area to the elevation pieces (no overlapping pieces)
  backups        list / restore / delete the restore points the add-* commands make
  inspect        explain what a tile file / tile folder holds and why it can or can't be used
  repair         copy every readable tile of a damaged tile file into a new .mbtiles
  check-terrain  validate a terrain folder (and compare it with the DEM)
  check          health check of the running servers (tiles, terrain, elevation, ...)
  serve          the tools web page (runs as the "tools" service)

Run "<command> -h" for the options of each command.
"""

import argparse
import sys

from . import (add_elevation, add_mbtiles, add_terrain, backups, check_terrain, elevation, inspect_tiles,
               mbtiles, repair_tiles, stackcheck, terrain, web)
from .common import install_sigterm, terminating

COMMANDS = {
    "mbtiles": (mbtiles, "imagery -> .mbtiles for mbtileserver"),
    "terrain": (terrain, "DEM -> quantized-mesh terrain tiles"),
    "elevation": (elevation, "split a DEM for open-elevation"),
    "add-mbtiles": (add_mbtiles, "add a new area to an existing .mbtiles"),
    "add-terrain": (add_terrain, "add a new area to existing terrain"),
    "add-elevation": (add_elevation, "add a new area to the elevation pieces"),
    "backups": (backups, "list / restore / delete restore points"),
    "inspect": (inspect_tiles, "check a tile file or tile folder step by step"),
    "repair": (repair_tiles, "save the readable tiles of a damaged tile file"),
    "check-terrain": (check_terrain, "validate a terrain folder"),
    "check": (stackcheck, "health check of the running servers"),
    "serve": (web, "run the tools web page"),
}


def main(argv=None):
    parser = argparse.ArgumentParser(prog="gcs-tools", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", metavar="<command>")
    for name, (module, help_) in COMMANDS.items():
        sp = sub.add_parser(name, help=help_, description=module.__doc__,
                            formatter_class=argparse.RawDescriptionHelpFormatter)
        module.build_parser(sp)
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 2
    if args.command != "serve":
        install_sigterm()
    try:
        COMMANDS[args.command][0].main(args=args)
    except BaseException:
        if terminating():  # cancelled: cleanup has run while unwinding
            print("Cancelled.", flush=True)
            return 143
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
