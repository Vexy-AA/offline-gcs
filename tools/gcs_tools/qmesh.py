"""Minimal quantized-mesh-1.0 encoder/decoder (Cesium terrain tile format).

Spec: https://github.com/CesiumGS/quantized-mesh

Written for this project instead of using a third-party encoder so that:
  * all geometry maths is done in float64 (lon/lat in float32 is only good to
    ~0.4 m and breaks exact tile-edge detection at high zoom levels),
  * u/v come straight from the sampling grid, so edge vertices are exactly
    0 / 32767 and Cesium can build skirts along every tile edge,
  * vertices are re-ordered for high-water-mark index encoding and triangles
    are forced counter-clockwise (Cesium culls back faces).
"""

import struct

import numpy as np

# WGS84 ellipsoid, same constants as Cesium's Ellipsoid.WGS84
WGS84_A = 6378137.0
WGS84_B = 6356752.3142451793
WGS84_E2 = 1.0 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A)
RADII = np.array([WGS84_A, WGS84_A, WGS84_B])

QMAX = 32767
EXT_OCT_VERTEX_NORMALS = 1


def geodetic_to_ecef(lon_deg, lat_deg, height):
    lon = np.radians(lon_deg)
    lat = np.radians(lat_deg)
    sin_lat = np.sin(lat)
    cos_lat = np.cos(lat)
    n = WGS84_A / np.sqrt(1.0 - WGS84_E2 * sin_lat * sin_lat)
    x = (n + height) * cos_lat * np.cos(lon)
    y = (n + height) * cos_lat * np.sin(lon)
    z = (n * (1.0 - WGS84_E2) + height) * sin_lat
    return np.column_stack([x, y, z])


def _bounding_sphere(points):
    """Smaller of the bounding-box sphere and a Ritter sphere (as Cesium does)."""
    lo = points.min(axis=0)
    hi = points.max(axis=0)
    c1 = (lo + hi) * 0.5
    r1 = float(np.sqrt(((points - c1) ** 2).sum(axis=1)).max())

    # Ritter: start from the two points furthest apart along the widest axis
    axis = int(np.argmax(hi - lo))
    p_min = points[np.argmin(points[:, axis])]
    p_max = points[np.argmax(points[:, axis])]
    c2 = (p_min + p_max) * 0.5
    r2 = float(np.sqrt(((p_max - p_min) ** 2).sum())) * 0.5
    d = np.sqrt(((points - c2) ** 2).sum(axis=1))
    for i in np.nonzero(d > r2)[0]:
        di = float(np.sqrt(((points[i] - c2) ** 2).sum()))
        if di > r2:
            new_r = (r2 + di) * 0.5
            c2 = c2 + (points[i] - c2) * ((new_r - r2) / di)
            r2 = new_r
    r2 = max(r2, float(np.sqrt(((points - c2) ** 2).sum(axis=1)).max()))
    return (c1, r1) if r1 <= r2 else (c2, r2)


def _horizon_occlusion_point(points, direction):
    """Cesium EllipsoidalOccluder.computeHorizonCullingPointFromVertices.

    Returned in ellipsoid-scaled space, as the quantized-mesh header expects.
    """
    scaled_dir = direction / RADII
    norm = np.linalg.norm(scaled_dir)
    if norm == 0:
        return np.zeros(3)
    scaled_dir = scaled_dir / norm

    p = points / RADII
    mag2 = (p * p).sum(axis=1)
    mag = np.sqrt(mag2)
    d = p / mag[:, None]
    mag2 = np.maximum(mag2, 1.0)
    mag = np.maximum(mag, 1.0)
    cos_a = d @ scaled_dir
    sin_a = np.linalg.norm(np.cross(d, scaled_dir), axis=1)
    cos_b = 1.0 / mag
    sin_b = np.sqrt(mag2 - 1.0) * cos_b
    denom = cos_a * cos_b - sin_a * sin_b
    with np.errstate(divide="ignore", invalid="ignore"):
        cand = 1.0 / denom
    cand = cand[np.isfinite(cand) & (cand > 0)]
    m = float(cand.max()) if cand.size else 0.0
    if not np.isfinite(m) or m <= 0:
        # Tile too large for a single culling point (only happens near level 0):
        # put it far out so the tile is culled only from the opposite side.
        m = 1.0e3
    return scaled_dir * m


def _oct_encode(normals):
    """Cesium AttributeCompression.octEncodeInRange(v, 255) for unit vectors."""
    n = normals / np.abs(normals).sum(axis=1)[:, None]
    x = n[:, 0].copy()
    y = n[:, 1].copy()
    neg = n[:, 2] < 0
    ox, oy = x[neg], y[neg]
    x[neg] = (1.0 - np.abs(oy)) * np.where(ox < 0, -1.0, 1.0)
    y[neg] = (1.0 - np.abs(ox)) * np.where(oy < 0, -1.0, 1.0)
    ex = np.round((np.clip(x, -1, 1) * 0.5 + 0.5) * 255).astype(np.uint8)
    ey = np.round((np.clip(y, -1, 1) * 0.5 + 0.5) * 255).astype(np.uint8)
    return np.column_stack([ex, ey]).ravel()


def _vertex_normals(ecef, tris):
    """Area-weighted vertex normals in ECEF (relative-to-centre for precision)."""
    p = ecef - ecef.mean(axis=0)
    a, b, c = p[tris[:, 0]], p[tris[:, 1]], p[tris[:, 2]]
    face = np.cross(b - a, c - a)
    acc = np.zeros_like(p)
    for k in range(3):
        np.add.at(acc, tris[:, k], face)
    length = np.linalg.norm(acc, axis=1)
    # Degenerate (shouldn't happen): fall back to the ellipsoid surface normal
    bad = length == 0
    if bad.any():
        geo = ecef[bad] / (RADII * RADII)
        acc[bad] = geo
        length[bad] = np.linalg.norm(geo, axis=1)
    return acc / length[:, None]


def _zigzag_delta(values):
    v = values.astype(np.int32)
    delta = np.diff(v, prepend=0)
    return ((delta << 1) ^ (delta >> 31)).astype(np.uint16)


def encode(u, v, heights, triangles, bounds, normals=True):
    """Encode one tile.

    u, v       integer arrays 0..32767 (u = west->east, v = south->north)
    heights    float array, metres
    triangles  (M, 3) int array of vertex indices
    bounds     (west, south, east, north) in degrees
    Returns the uncompressed tile bytes.
    """
    u = np.asarray(u, dtype=np.int64)
    v = np.asarray(v, dtype=np.int64)
    heights = np.asarray(heights, dtype=np.float64)
    tris = np.asarray(triangles, dtype=np.int64).reshape(-1, 3)

    # Drop degenerate triangles and force counter-clockwise winding in u/v
    du1, dv1 = u[tris[:, 1]] - u[tris[:, 0]], v[tris[:, 1]] - v[tris[:, 0]]
    du2, dv2 = u[tris[:, 2]] - u[tris[:, 0]], v[tris[:, 2]] - v[tris[:, 0]]
    cross = du1 * dv2 - dv1 * du2
    tris = tris[cross != 0]
    cw = cross[cross != 0] < 0
    tris[cw] = tris[cw][:, [0, 2, 1]]

    # Re-order vertices by first use (required by high-water-mark encoding)
    flat = tris.ravel()
    uniq, first = np.unique(flat, return_index=True)
    order = uniq[np.argsort(first)]
    remap = np.full(u.shape[0], -1, dtype=np.int64)
    remap[order] = np.arange(order.size)
    tris = remap[tris]
    u, v, heights = u[order], v[order], heights[order]
    n_vert = int(order.size)

    west, south, east, north = bounds
    lon = west + (east - west) * (u / QMAX)
    lat = south + (north - south) * (v / QMAX)
    ecef = geodetic_to_ecef(lon, lat, heights)

    h_min = float(heights.min())
    h_max = float(heights.max())
    if h_max > h_min:
        hq = np.round((heights - h_min) / (h_max - h_min) * QMAX).astype(np.int64)
    else:
        hq = np.zeros(n_vert, dtype=np.int64)

    center = (ecef.min(axis=0) + ecef.max(axis=0)) * 0.5
    bs_center, bs_radius = _bounding_sphere(ecef)
    hop = _horizon_occlusion_point(ecef, bs_center)

    out = bytearray()
    out += struct.pack("<3d", *center)
    out += struct.pack("<2f", h_min, h_max)
    out += struct.pack("<4d", *bs_center, bs_radius)
    out += struct.pack("<3d", *hop)

    out += struct.pack("<I", n_vert)
    out += _zigzag_delta(u).tobytes()
    out += _zigzag_delta(v).tobytes()
    out += _zigzag_delta(hq).tobytes()

    index_32 = n_vert > 65536
    idx_type = np.uint32 if index_32 else np.uint16
    align = 4 if index_32 else 2
    if len(out) % align:
        out += b"\x00" * (align - len(out) % align)

    # High-water-mark encoding. With first-use vertex order, the "highest"
    # counter before element i is simply max(flat[:i]) + 1.
    flat = tris.ravel()
    highest = np.maximum.accumulate(np.concatenate([[0], flat[:-1] + 1]))
    encoded = highest - flat
    if (encoded < 0).any():  # cannot happen after the re-ordering above
        raise ValueError("vertex order is not suitable for high-water-mark encoding")
    out += struct.pack("<I", tris.shape[0])
    out += encoded.astype(idx_type).tobytes()

    for edge in (u == 0, v == 0, u == QMAX, v == QMAX):  # west, south, east, north
        ids = np.nonzero(edge)[0].astype(idx_type)
        out += struct.pack("<I", ids.size)
        out += ids.tobytes()

    if normals:
        oct_ = _oct_encode(_vertex_normals(ecef, tris))
        out += struct.pack("<BI", EXT_OCT_VERTEX_NORMALS, oct_.size)
        out += oct_.tobytes()

    return bytes(out)


def _zigzag_decode(arr):
    a = arr.astype(np.int32)
    return np.cumsum((a >> 1) ^ (-(a & 1)))


def decode(data):
    """Decode an (uncompressed) tile. Used by the self-checks and tests."""
    off = 0
    center = struct.unpack_from("<3d", data, off); off += 24
    h_min, h_max = struct.unpack_from("<2f", data, off); off += 8
    sphere = struct.unpack_from("<4d", data, off); off += 32
    hop = struct.unpack_from("<3d", data, off); off += 24
    (n,) = struct.unpack_from("<I", data, off); off += 4
    u = _zigzag_decode(np.frombuffer(data, np.uint16, n, off)); off += 2 * n
    v = _zigzag_decode(np.frombuffer(data, np.uint16, n, off)); off += 2 * n
    h = _zigzag_decode(np.frombuffer(data, np.uint16, n, off)); off += 2 * n
    idx_type, size = (np.uint32, 4) if n > 65536 else (np.uint16, 2)
    if off % size:
        off += size - off % size
    (tcount,) = struct.unpack_from("<I", data, off); off += 4
    enc = np.frombuffer(data, idx_type, tcount * 3, off).astype(np.int64); off += size * tcount * 3
    idx = np.empty_like(enc)
    highest = 0
    for i, code in enumerate(enc):
        idx[i] = highest - code
        if code == 0:
            highest += 1
    edges = []
    for _ in range(4):
        (c,) = struct.unpack_from("<I", data, off); off += 4
        edges.append(np.frombuffer(data, idx_type, c, off).astype(np.int64)); off += size * c
    extensions = {}
    while off < len(data):
        ext_id, length = struct.unpack_from("<BI", data, off); off += 5
        extensions[ext_id] = data[off:off + length]; off += length
    heights = h_min + (h_max - h_min) * (h / QMAX)
    return {
        "center": center, "min_height": h_min, "max_height": h_max,
        "bounding_sphere": sphere, "horizon_occlusion_point": hop,
        "u": u, "v": v, "height": heights, "triangles": idx.reshape(-1, 3),
        "west": edges[0], "south": edges[1], "east": edges[2], "north": edges[3],
        "extensions": extensions,
    }
