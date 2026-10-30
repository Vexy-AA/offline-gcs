"""Write the same tiles in the layouts real tools produce, to test add-mbtiles sources.

    python3 make_tile_variants.py SRC.mbtiles OUT_DIR

  OUT_DIR/std.mbtiles       MBTiles as the spec says: TMS rows, plain tiles table
  OUT_DIR/xyzrows.mbtiles   rows written top-down (XYZ) by mistake; bounds metadata correct
  OUT_DIR/dedup.mbtiles     map + images tables with a tiles view (mb-util, TileMill style)
  OUT_DIR/retina.mbtiles    512 x 512 px tiles
  OUT_DIR/vector.mbtiles    gzip'ed vector tiles (format=pbf)
  OUT_DIR/TmsFolder/        {z}/{x}/{y} folder with TMS rows + tilemapresource.xml (gdal2tiles)
  OUT_DIR/sasplanet.mbtiles RMaps/OsmAnd sqlitedb (SAS.Planet "SQLite3"): tiles(x,y,z,s,image), z = 17 - zoom
  OUT_DIR/orux.mbtiles      OruxMaps: tiles(x,y,z,image)
  OUT_DIR/odd #name.mbtiles a '#' in the name (SQLite URIs cut the name there unless it is escaped)
  OUT_DIR/broken-*.mbtiles  half-copied, an HTML page, empty, SQLite without tiles
  OUT_DIR/damaged-index.mbtiles  index pages overwritten ("database disk image is malformed")
  OUT_DIR/damaged-table.mbtiles  some tile pages overwritten
"""
import gzip
import hashlib
import os
import sqlite3
import sys

from osgeo import gdal

gdal.UseExceptions()


def new_db(path, meta):
    if os.path.exists(path):
        os.remove(path)
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
    db.executemany("INSERT INTO metadata VALUES (?,?)", list(meta.items()))
    return db


def upscale(blob):
    name = f"/vsimem/in_{id(blob)}"
    gdal.FileFromMemBuffer(name, blob)
    ds = gdal.Open(name)
    arr = ds.ReadAsArray()
    gdal.Unlink(name)
    if arr.ndim == 2:
        arr = arr[None]
    big = arr.repeat(2, axis=1).repeat(2, axis=2)
    mem = gdal.GetDriverByName("MEM").Create("", 512, 512, big.shape[0], gdal.GDT_Byte)
    for i in range(big.shape[0]):
        mem.GetRasterBand(i + 1).WriteArray(big[i])
    ext, drv = ("jpg", "JPEG") if blob[:2] == b"\xff\xd8" else ("png", "PNG")
    out = f"/vsimem/out_{id(blob)}.{ext}"
    gdal.GetDriverByName(drv).CreateCopy(out, mem)
    f = gdal.VSIFOpenL(out, "rb")
    gdal.VSIFSeekL(f, 0, 2)
    n = gdal.VSIFTellL(f)
    gdal.VSIFSeekL(f, 0, 0)
    data = gdal.VSIFReadL(1, n, f)
    gdal.VSIFCloseL(f)
    gdal.Unlink(out)
    return data


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    s = sqlite3.connect(src)
    meta = dict(s.execute("SELECT name, value FROM metadata"))
    tiles = s.execute("SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles").fetchall()

    for name, flip in (("std", False), ("xyzrows", True)):
        db = new_db(os.path.join(out, f"{name}.mbtiles"), meta)
        db.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
        db.executemany("INSERT INTO tiles VALUES (?,?,?,?)",
                       [(z, x, ((1 << z) - 1 - r) if flip else r, d) for z, x, r, d in tiles])
        db.commit()

    db = new_db(os.path.join(out, "dedup.mbtiles"), meta)
    db.executescript("""
        CREATE TABLE map (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_id TEXT);
        CREATE TABLE images (tile_data BLOB, tile_id TEXT);
        CREATE UNIQUE INDEX map_index ON map (zoom_level, tile_column, tile_row);
        CREATE UNIQUE INDEX images_id ON images (tile_id);
        CREATE VIEW tiles AS SELECT map.zoom_level AS zoom_level, map.tile_column AS tile_column,
            map.tile_row AS tile_row, images.tile_data AS tile_data
            FROM map JOIN images ON images.tile_id = map.tile_id;
    """)
    for z, x, r, d in tiles:
        h = hashlib.md5(d).hexdigest()
        db.execute("INSERT OR IGNORE INTO images VALUES (?,?)", (d, h))
        db.execute("INSERT INTO map VALUES (?,?,?,?)", (z, x, r, h))
    db.commit()

    db = new_db(os.path.join(out, "retina.mbtiles"), meta)
    db.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
    db.executemany("INSERT INTO tiles VALUES (?,?,?,?)", [(z, x, r, upscale(bytes(d))) for z, x, r, d in tiles])
    db.commit()

    db = new_db(os.path.join(out, "vector.mbtiles"), dict(meta, format="pbf"))
    db.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
    db.executemany("INSERT INTO tiles VALUES (?,?,?,?)", [(z, x, r, gzip.compress(b"\x1a\x00")) for z, x, r, _ in tiles])
    db.commit()

    db = new_db(os.path.join(out, "sasplanet.mbtiles"), {})
    db.executescript("CREATE TABLE info (maxzoom Int, minzoom Int); "
                     "CREATE TABLE tiles (x int, y int, z int, s int, image blob, PRIMARY KEY (x,y,z,s));")
    db.executemany("INSERT INTO tiles VALUES (?,?,?,0,?)", [(x, (1 << z) - 1 - r, 17 - z, d) for z, x, r, d in tiles])
    db.commit()
    db = new_db(os.path.join(out, "orux.mbtiles"), {})
    db.execute("CREATE TABLE tiles (x int, y int, z int, image blob, PRIMARY KEY (x,y,z))")
    db.executemany("INSERT INTO tiles VALUES (?,?,?,?)", [(x, (1 << z) - 1 - r, z, d) for z, x, r, d in tiles])
    db.commit()
    with open(src, "rb") as f:
        whole = f.read()
    with open(os.path.join(out, "odd #name.mbtiles"), "wb") as f:
        f.write(whole)
    with open(os.path.join(out, "broken-halfcopied.mbtiles"), "wb") as f:
        f.write(whole[:len(whole) // 4])
    with open(os.path.join(out, "broken-html.mbtiles"), "wb") as f:
        f.write(b"<!DOCTYPE html><html><body>404</body></html>")
    open(os.path.join(out, "broken-empty.mbtiles"), "wb").close()
    db = new_db(os.path.join(out, "broken-notiles.mbtiles"), meta)
    db.commit()

    for name, obj, every in (("damaged-index", "tile_index", 1), ("damaged-table", "tiles", 25)):
        path = os.path.join(out, f"{name}.mbtiles")
        db = new_db(path, meta)
        db.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
        db.executemany("INSERT INTO tiles VALUES (?,?,?,?)", tiles)
        db.execute("CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row)")
        db.commit()
        size = db.execute("PRAGMA page_size").fetchone()[0]
        pages = [r[0] for r in db.execute("SELECT pageno FROM dbstat WHERE name=? AND pagetype='leaf'", (obj,))][::every]
        db.close()
        with open(path, "r+b") as f:
            for i, p in enumerate(pages):
                f.seek((p - 1) * size)
                f.write(bytes((i * 37 + k * 11) % 256 for k in range(size)))

    root = os.path.join(out, "TmsFolder")
    for z, x, r, d in tiles:
        os.makedirs(f"{root}/{z}/{x}", exist_ok=True)
        ext = "jpg" if bytes(d[:2]) == b"\xff\xd8" else "png"
        with open(f"{root}/{z}/{x}/{r}.{ext}", "wb") as f:
            f.write(d)
    with open(f"{root}/tilemapresource.xml", "w") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<TileMap version="1.0.0" tilemapservice="http://tms.osgeo.org/1.0.0">\n'
                '  <SRS>EPSG:3857</SRS>\n  <TileFormat width="256" height="256" mime-type="image/png" extension="png" />\n'
                '  <TileSets profile="mercator"></TileSets>\n</TileMap>\n')
    print("wrote", ", ".join(sorted(os.listdir(out))))


if __name__ == "__main__":
    main()
