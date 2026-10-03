"""Trace brand/sumlora-logo-draft.png into clean SVGs.

Each colour (the teal mark, the navy wordmark) is traced on its own. The anti-aliased edge is
upsampled and cut at half coverage; each outline is split at its corners, and every piece between
corners is fitted with as few cubic curves as the tolerance allows (Philip Schneider's method,
"An Algorithm for Automatically Fitting Digitized Curves", Graphics Gems, 1990). Few curves means
smooth edges: the small wobbles in the source image aren't copied.

Run from the repository: python3 brand/trace.py
"""
import math
import numpy as np
import cv2
from PIL import Image

SRC = 'brand/sumlora-logo-draft.png'
TEAL, NAVY = '#11B6A5', '#112A4D'
UP = 4          # trace at 4x
PRE = 0.9       # light smoothing (source px) before fitting
ERR = 0.9       # largest distance (source px) a fitted curve may be from the outline
CORNER = 42     # turns sharper than this (degrees, over ~3 px) stay corners


# ---------- outlines ----------
def masks():
    im = np.array(Image.open(SRC).convert('RGBA')).astype(np.float32)
    a = im[..., 3] / 255.0
    g = im[..., 1]
    return np.where(g > 110, a, 0), np.where(g <= 110, a, 0)


def outlines(cov):
    big = cv2.resize(cov, None, fx=UP, fy=UP, interpolation=cv2.INTER_CUBIC)
    big = cv2.GaussianBlur(big, (0, 0), UP * 0.5)
    bw = (big > 0.5).astype(np.uint8)
    cs, _ = cv2.findContours(bw, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    out = []
    for c in cs:
        if abs(cv2.contourArea(c.astype(np.float32))) < (4 * UP) ** 2:
            continue
        out.append(c[:, 0, :].astype(np.float64) / UP + (0.5 / UP - 0.5))
    return out


def smooth(p, sigma):
    n = len(p)
    step = np.linalg.norm(np.diff(np.vstack([p, p[:1]]), axis=0), axis=1).mean()
    s = max(1, int(round(sigma / max(step, 1e-6))))
    k = np.exp(-0.5 * (np.arange(-3 * s, 3 * s + 1) / s) ** 2)
    k /= k.sum()
    ext = np.vstack([p[-3 * s:], p, p[:3 * s]])
    return np.stack([np.convolve(ext[:, 0], k, 'valid'), np.convolve(ext[:, 1], k, 'valid')], 1)[:n]


def find_corners(p):
    n = len(p)
    step = np.linalg.norm(np.diff(np.vstack([p, p[:1]]), axis=0), axis=1).mean()
    span = max(2, int(round(3.0 / step)))
    ang = np.empty(n)
    for i in range(n):
        v1 = p[i] - p[i - span]
        v2 = p[(i + span) % n] - p[i]
        ang[i] = abs(math.degrees(math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1 @ v2)))
    cs = []
    for i in range(n):
        if ang[i] < CORNER:
            continue
        window = [ang[(i + d) % n] for d in range(-span, span + 1)]
        if ang[i] >= max(window) and all(abs(i - j) > span for j in cs):
            cs.append(i)
    return cs


# ---------- Schneider curve fitting ----------
def bez(ctrl, t):
    t = np.asarray(t)[:, None]
    mt = 1 - t
    return mt ** 3 * ctrl[0] + 3 * mt ** 2 * t * ctrl[1] + 3 * mt * t ** 2 * ctrl[2] + t ** 3 * ctrl[3]


def bez_d(ctrl, t):
    t = np.asarray(t)[:, None]
    mt = 1 - t
    return 3 * mt ** 2 * (ctrl[1] - ctrl[0]) + 6 * mt * t * (ctrl[2] - ctrl[1]) + 3 * t ** 2 * (ctrl[3] - ctrl[2])


def bez_dd(ctrl, t):
    t = np.asarray(t)[:, None]
    return 6 * (1 - t) * (ctrl[2] - 2 * ctrl[1] + ctrl[0]) + 6 * t * (ctrl[3] - 2 * ctrl[2] + ctrl[1])


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


def chord_params(pts):
    d = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    return d / d[-1] if d[-1] > 0 else d


def generate(pts, u, t1, t2):
    p0, p3 = pts[0], pts[-1]
    A1 = t1[None, :] * (3 * (1 - u) ** 2 * u)[:, None]
    A2 = t2[None, :] * (3 * (1 - u) * u ** 2)[:, None]
    C = np.array([[np.sum(A1 * A1), np.sum(A1 * A2)], [np.sum(A1 * A2), np.sum(A2 * A2)]])
    base = bez(np.array([p0, p0, p3, p3]), u)
    tmp = pts - base
    X = np.array([np.sum(A1 * tmp), np.sum(A2 * tmp)])
    det = C[0, 0] * C[1, 1] - C[0, 1] * C[1, 0]
    seg = np.linalg.norm(p3 - p0)
    a1 = a2 = 0
    if abs(det) > 1e-12:
        a1 = (X[0] * C[1, 1] - X[1] * C[0, 1]) / det
        a2 = (C[0, 0] * X[1] - C[1, 0] * X[0]) / det
    if a1 < 1e-6 * seg or a2 < 1e-6 * seg:
        a1 = a2 = seg / 3
    return np.array([p0, p0 + t1 * a1, p3 + t2 * a2, p3])


def max_error(pts, ctrl, u):
    d = np.sum((bez(ctrl, u) - pts) ** 2, axis=1)
    i = int(np.argmax(d))
    return d[i], i


def reparam(pts, ctrl, u):
    q, q1, q2 = bez(ctrl, u), bez_d(ctrl, u), bez_dd(ctrl, u)
    num = np.sum((q - pts) * q1, axis=1)
    den = np.sum(q1 * q1, axis=1) + np.sum((q - pts) * q2, axis=1)
    with np.errstate(divide='ignore', invalid='ignore'):
        nu = np.where(np.abs(den) > 1e-12, u - num / den, u)
    return np.clip(nu, 0, 1)


def fit_cubic(pts, t1, t2, err2, depth=0):
    if len(pts) == 2:
        d = np.linalg.norm(pts[1] - pts[0]) / 3
        return [np.array([pts[0], pts[0] + t1 * d, pts[1] + t2 * d, pts[1]])]
    u = chord_params(pts)
    ctrl = generate(pts, u, t1, t2)
    e, split = max_error(pts, ctrl, u)
    if e < err2:
        return [ctrl]
    if e < err2 * 4:
        for _ in range(20):
            u = reparam(pts, ctrl, u)
            ctrl = generate(pts, u, t1, t2)
            e, split = max_error(pts, ctrl, u)
            if e < err2:
                return [ctrl]
    split = min(max(split, 1), len(pts) - 2)
    tc = unit(pts[split - 1] - pts[split + 1])
    if depth > 40:
        return [ctrl]
    return fit_cubic(pts[:split + 1], t1, tc, err2, depth + 1) + fit_cubic(pts[split:], -tc, t2, err2, depth + 1)


def end_tangent(pts, forward=True, k=None):
    k = k or max(2, min(len(pts) - 1, 6))
    return unit(pts[k] - pts[0]) if forward else unit(pts[-1 - k] - pts[-1])


STRAIGHT_TOL = 0.3    # source px: points this close to a line make a straight run
STRAIGHT_MIN = 32     # source px: shortest straight run kept as a line
SNAP_DEG = 2.0        # runs this close to vertical or horizontal are made exactly so


def turn_angles(p, span):
    n = len(p)
    v1 = p - np.roll(p, span, axis=0)
    v2 = np.roll(p, -span, axis=0) - p
    return np.abs(np.degrees(np.arctan2(v1[:, 0] * v2[:, 1] - v1[:, 1] * v2[:, 0], np.sum(v1 * v2, axis=1))))


def straight_runs(p):
    """Greedy straight runs on an open sequence of points: list of (start, end) indices."""
    n, runs, i = len(p), [], 0
    while i < n - 2:
        j = i + 2
        best = None
        while j < n:
            a, b = p[i], p[j]
            ab = b - a
            L = np.linalg.norm(ab)
            if L > 1e-9:
                seg = p[i:j + 1] - a
                dist = np.abs(seg[:, 0] * ab[1] - seg[:, 1] * ab[0]) / L
                if dist.max() > STRAIGHT_TOL:
                    break
                best = j
            j += 1
        if best is not None and np.linalg.norm(p[best] - p[i]) >= STRAIGHT_MIN:
            runs.append((i, best))
            i = best
        else:
            i += 1
    return runs


def fit_outline(raw):
    p = smooth(raw, PRE)
    n = len(p)
    step = np.linalg.norm(np.diff(np.vstack([p, p[:1]]), axis=0), axis=1).mean()
    span = max(2, int(round(3.0 / step)))
    ang = turn_angles(p, span)
    # Start at the sharpest point so no straight run is cut in two by the start.
    r = int(np.argmax(ang))
    p, raw, ang = np.roll(p, -r, axis=0), np.roll(raw, -r, axis=0), np.roll(ang, -r)
    cs = [i for i in find_corners(p)]
    for i in cs:
        p[i] = raw[i]
    runs = straight_runs(np.vstack([p, p[:1]]))
    runs = [(a, b % n if b < n else n) for a, b in runs]
    # Snap near-vertical and near-horizontal runs.
    for a, b in runs:
        bb = b % n
        d = p[bb] - p[a]
        deg = abs(math.degrees(math.atan2(d[1], d[0]))) % 180
        if min(deg, 180 - deg) < SNAP_DEG:
            y = (p[a][1] + p[bb][1]) / 2; p[a][1] = y; p[bb][1] = y
        elif abs(deg - 90) < SNAP_DEG:
            x = (p[a][0] + p[bb][0]) / 2; p[a][0] = x; p[bb][0] = x
    run_of = {a: b for a, b in runs}
    breaks = sorted(set([0] + cs + [a for a, _ in runs] + [b for _, b in runs if b < n]))
    err2 = ERR ** 2
    pieces = []  # (kind, start, end, curves)
    for k, a in enumerate(breaks):
        b = breaks[k + 1] if k + 1 < len(breaks) else n
        pieces.append([a, b])
    # Tangents at break points: along an adjoining straight run, else estimated.
    run_dir = {}
    for a, b in runs:
        dvec = unit(p[b % n] - p[a])
        run_dir[a] = dvec; run_dir[b % n] = dvec
    corner_set = set(cs)
    w = max(2, int(round(2.5 / step)))
    # A smooth join (not a corner): both curves leave in the same direction, so there's no kink.
    smooth_tan = lambda i: unit(p[(i + w) % n] - p[(i - w) % n])
    d = [f'M{p[0][0]:.2f} {p[0][1]:.2f}']
    count = 0
    for a, b in pieces:
        bb = b % n
        if a in run_of and run_of[a] % n == bb:
            d.append(f'L{p[bb][0]:.2f} {p[bb][1]:.2f}'); count += 1; continue
        seg = np.vstack([p[a:b], p[bb:bb + 1]])
        if len(seg) < 2:
            continue
        k = max(1, min(len(seg) // 3, 6))
        t1 = run_dir[a] if (a in run_dir and a not in corner_set) else (smooth_tan(a) if a not in corner_set else end_tangent(seg, True, k))
        t2 = -run_dir[bb] if (bb in run_dir and bb not in corner_set) else (-smooth_tan(bb) if bb not in corner_set else end_tangent(seg, False, k))
        for c in fit_cubic(seg, t1, t2, err2):
            d.append('C' + ' '.join(f'{x:.2f} {y:.2f}' for x, y in c[1:])); count += 1
    d.append('Z')
    return ''.join(d), count


def paths(cov):
    ds, total = [], 0
    for raw in outlines(cov):
        d, k = fit_outline(raw)
        ds.append(d)
        total += k
    return ''.join(ds), total


def bbox(cov):
    ys, xs = np.where(cov > 0.5)
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1


if __name__ == '__main__':
    teal, navy = masks()
    tp, tn = paths(teal)
    wp, wn = paths(navy)
    tx0, ty0, tx1, ty1 = bbox(teal)
    nx0, ny0, nx1, ny1 = bbox(navy)
    x0, y0, x1, y1 = min(tx0, nx0), min(ty0, ny0), max(tx1, nx1), max(ty1, ny1)
    pad = round((y1 - y0) * 0.12)
    vb = f'{x0 - pad} {y0 - pad} {x1 - x0 + 2 * pad} {y1 - y0 + 2 * pad}'

    def svg(view, body):
        return ('<?xml version="1.0" encoding="UTF-8"?>\n'
                f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" role="img" aria-label="Sumlora"><title>Sumlora</title>{body}</svg>\n')
    mark = f'<path fill="{TEAL}" fill-rule="evenodd" d="{tp}"/>'
    open('brand/sumlora-logo.svg', 'w').write(svg(vb, mark + f'<path fill="{NAVY}" fill-rule="evenodd" d="{wp}"/>'))
    open('brand/sumlora-logo-white.svg', 'w').write(svg(vb, mark + f'<path fill="#FFFFFF" fill-rule="evenodd" d="{wp}"/>'))
    side = max(tx1 - tx0, ty1 - ty0) * 1.16
    cx, cy = (tx0 + tx1) / 2, (ty0 + ty1) / 2
    open('brand/sumlora-mark.svg', 'w').write(svg(f'{cx - side / 2:.1f} {cy - side / 2:.1f} {side:.1f} {side:.1f}', mark))
    print(f'curves: mark {tn}, wordmark {wn}; viewBox {vb}')
