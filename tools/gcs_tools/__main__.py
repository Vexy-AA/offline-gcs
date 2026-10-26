"""offline-gcs data tools.

  mbtiles        imagery raster(s) or a {z}/{x}/{y} tile folder -> .mbtiles (mbtileserver)
  terrain        DEM raster(s) -> Cesium quantized-mesh tiles + layer.json (terrain server)
  elevation      split a DEM into pieces for open-elevation (uses its create-tiles.sh)
  check-terrain  validate a terrain folder (and compare it with the DEM)
  check          health check of the running servers (tiles, terrain, elevation, ...)
  serve          the tools web page (runs as the "tools" service)

Run "<command> -h" for the options of each command.
"""

import argparse
import sys

from . import check_terrain, elevation, mbtiles, stackcheck, terrain, web
from .common import install_sigterm, terminating

COMMANDS = {
    "mbtiles": (mbtiles, "imagery -> .mbtiles for mbtileserver"),
    "terrain": (terrain, "DEM -> quantized-mesh terrain tiles"),
    "elevation": (elevation, "split a DEM for open-elevation"),
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
