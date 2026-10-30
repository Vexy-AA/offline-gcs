"""Rectangle arithmetic for adding an area next to (or over) an existing one.

Rectangles are (x0, y0, x1, y1) with x0 < x1 and y0 < y1, half-open: a point on
the right or top edge belongs to the next rectangle. The same functions work for
lon/lat boxes (floats) and for tile ranges (ints, see tiles_to_rect).
"""


def area(r):
    return max(0.0, r[2] - r[0]) * max(0.0, r[3] - r[1])


def intersect(a, b):
    """Overlap of two rectangles, or None."""
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    if x0 < x1 and y0 < y1:
        return (x0, y0, x1, y1)
    return None


def union_bbox(rects):
    rects = [r for r in rects if r]
    if not rects:
        return None
    return (min(r[0] for r in rects), min(r[1] for r in rects),
            max(r[2] for r in rects), max(r[3] for r in rects))


def _edges(values, lo, hi, eps):
    out = []
    for v in sorted({lo, hi, *[v for v in values if lo < v < hi]}):
        if not out or v - out[-1] > eps:
            out.append(v)
        elif v == hi:          # keep the exact outer edge
            out[-1] = hi
    return out


def subtract(rect, holes, eps=0.0):
    """`rect` minus the union of `holes`, as a list of disjoint rectangles.

    Works on a grid made of all the edges inside `rect` (edges closer than
    `eps` are merged, so float noise does not make slivers); cells not inside
    any hole are merged into horizontal runs, and runs with the same x span in
    consecutive rows into taller rectangles.
    """
    holes = [h for h in (intersect(rect, h) for h in holes) if h]
    if not holes:
        return [tuple(rect)]
    xs = _edges([h[0] for h in holes] + [h[2] for h in holes], rect[0], rect[2], eps)
    ys = _edges([h[1] for h in holes] + [h[3] for h in holes], rect[1], rect[3], eps)

    def covered(cx, cy):
        return any(h[0] <= cx < h[2] and h[1] <= cy < h[3] for h in holes)

    rows = []
    for j in range(len(ys) - 1):
        cy = (ys[j] + ys[j + 1]) / 2
        runs, start = [], None
        for i in range(len(xs) - 1):
            free = not covered((xs[i] + xs[i + 1]) / 2, cy)
            if free and start is None:
                start = i
            if not free and start is not None:
                runs.append((xs[start], xs[i]))
                start = None
        if start is not None:
            runs.append((xs[start], xs[-1]))
        rows.append(runs)

    out, open_ = [], {}  # (x0, x1) -> y0 of a rectangle still growing upwards
    for j, runs in enumerate(rows):
        now = {}
        for run in runs:
            now[run] = open_.pop(run, ys[j])
        for (x0, x1), y0 in open_.items():
            out.append((x0, y0, x1, ys[j]))
        open_ = now
    for (x0, x1), y0 in open_.items():
        out.append((x0, y0, x1, ys[-1]))
    return sorted(out, key=lambda r: (r[1], r[0]))


def covered_fraction(rect, holes):
    """Share of `rect`'s area that lies inside the union of `holes` (0..1)."""
    a = area(rect)
    if a <= 0:
        return 0.0
    free = sum(area(r) for r in subtract(rect, holes))
    return max(0.0, min(1.0, 1.0 - free / a))


def merge_rects(rects):
    """Union of rectangles as disjoint rectangles (order-independent)."""
    out = []
    for r in rects:
        pieces = [r]
        for o in out:
            pieces = [p for q in pieces for p in subtract(q, [o])]
        out.extend(pieces)
    return out


# ---- tile ranges: inclusive {startX, startY, endX, endY} <-> half-open ints

def range_to_rect(r):
    return (r["startX"], r["startY"], r["endX"] + 1, r["endY"] + 1)


def rect_to_range(r):
    return {"startX": int(r[0]), "startY": int(r[1]), "endX": int(r[2]) - 1, "endY": int(r[3]) - 1}


def tiles_in(rects):
    for x0, y0, x1, y1 in rects:
        for x in range(int(x0), int(x1)):
            for y in range(int(y0), int(y1)):
                yield x, y


def count_tiles(rects):
    return int(sum(area(r) for r in rects))
