// Generated from src/draw/stroke.ts by scripts/copy-crdt.mjs. Do not edit.
export const BRUSH_SIZE = { pen: 3.2, marker: 9, hl: 22 };
const UNIT = 2; // half pixels
export function simplify(pts, tolerance = 0.6) {
    if (pts.length < 3)
        return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        let maxD = 0;
        let idx = -1;
        for (let i = a + 1; i < b; i++) {
            const d = segDist(pts[i], pts[a], pts[b]);
            if (d > maxD) {
                maxD = d;
                idx = i;
            }
        }
        if (maxD > tolerance && idx > 0) {
            keep[idx] = 1;
            stack.push([a, idx], [idx, b]);
        }
    }
    return pts.filter((_, i) => keep[i]);
}
export function encodeStroke(world, pad, maxPoints = 900) {
    let pts = simplify(world);
    if (pts.length > maxPoints) {
        const step = pts.length / maxPoints;
        pts = Array.from({ length: maxPoints }, (_, i) => pts[Math.min(pts.length - 1, Math.round(i * step))]);
    }
    if (pts.length === 1)
        pts = [pts[0], { ...pts[0], x: pts[0].x + 0.5 }];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }
    const x = Math.floor(minX - pad), y = Math.floor(minY - pad);
    const w = Math.ceil(maxX + pad) - x, h = Math.ceil(maxY + pad) - y;
    const parts = [];
    let px = 0, py = 0;
    pts.forEach((p, i) => {
        const qx = Math.round((p.x - x) * UNIT), qy = Math.round((p.y - y) * UNIT);
        const q = Math.max(0, Math.min(9, Math.round(p.p * 9)));
        parts.push(i === 0 ? `${qx},${qy},${q}` : `${qx - px},${qy - py},${q}`);
        px = qx;
        py = qy;
    });
    return { x, y, w, h, d: `${w * UNIT},${h * UNIT}:${parts.join(";")}` };
}
const cache = new Map();
export function decodeStroke(d) {
    const hit = cache.get(d);
    if (hit)
        return hit;
    const colon = d.indexOf(":");
    if (colon < 0)
        return null;
    const [W, H] = d.slice(0, colon).split(",").map(Number);
    const pts = [];
    let x = 0, y = 0;
    for (const part of d.slice(colon + 1).split(";")) {
        const [a, b, c] = part.split(",").map(Number);
        if (![a, b, c].every(Number.isFinite))
            return null;
        x += a;
        y += b;
        pts.push({ x: x / UNIT, y: y / UNIT, p: c / 9 });
    }
    const out = { w: W / UNIT, h: H / UNIT, pts };
    if (cache.size > 2000)
        cache.clear();
    cache.set(d, out);
    return out;
}
function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
export function distanceToPolyline(pts, x, y) {
    if (pts.length === 1)
        return Math.hypot(pts[0].x - x, pts[0].y - y);
    let best = Infinity;
    for (let i = 1; i < pts.length; i++)
        best = Math.min(best, segDist({ x, y }, pts[i - 1], pts[i]));
    return best;
}
const f = (n) => Math.round(n * 100) / 100;
export function outlinePath(raw, size, simulatePressure) {
    if (!raw.length)
        return "";
    const input = densify(raw);
    const pts = [{ ...input[0] }];
    for (let i = 1; i < input.length; i++) {
        const prev = pts[pts.length - 1];
        const cur = input[i];
        const k = Math.min(1, 0.62 + Math.hypot(cur.x - prev.x, cur.y - prev.y) / (size * 6));
        pts.push({ x: prev.x + (cur.x - prev.x) * k, y: prev.y + (cur.y - prev.y) * k, p: cur.p });
    }
    pts.push({ ...input[input.length - 1] });
    if (pts.length < 3 || totalLength(pts) < size * 0.6) {
        const c = pts[0];
        const r = (size / 2) * (simulatePressure ? 0.9 : 0.5 + c.p * 0.5);
        return `M${f(c.x - r)},${f(c.y)}a${f(r)},${f(r)} 0 1,0 ${f(r * 2)},0a${f(r)},${f(r)} 0 1,0 ${f(-r * 2)},0Z`;
    }
    const radii = [];
    let prevR = size / 2;
    for (let i = 0; i < pts.length; i++) {
        let pressure;
        if (simulatePressure) {
            const a = pts[Math.max(0, i - 1)], b = pts[i];
            const speed = Math.min(1, Math.hypot(b.x - a.x, b.y - a.y) / (size * 2.2));
            pressure = 1 - speed * 0.55;
        }
        else
            pressure = pts[i].p;
        let r = (size / 2) * (0.35 + 0.65 * Math.max(0.05, pressure));
        r = prevR + (r - prevR) * 0.35; // ease radius changes
        const fromStart = i / 6, fromEnd = (pts.length - 1 - i) / 6;
        r *= Math.min(1, 0.55 + 0.45 * Math.min(fromStart, fromEnd, 1));
        radii.push(r);
        prevR = r;
    }
    const left = [];
    const right = [];
    for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        let dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        const r = radii[i];
        left.push({ x: pts[i].x - dy * r, y: pts[i].y + dx * r });
        right.push({ x: pts[i].x + dy * r, y: pts[i].y - dx * r });
    }
    const endR = radii[radii.length - 1], startR = radii[0];
    let d = `M${f(left[0].x)},${f(left[0].y)}`;
    d += smoothThrough(left);
    const lr = right[right.length - 1];
    d += `A${f(endR)},${f(endR)} 0 0,1 ${f(lr.x)},${f(lr.y)}`;
    d += smoothThrough(right.slice().reverse());
    d += `A${f(startR)},${f(startR)} 0 0,1 ${f(left[0].x)},${f(left[0].y)}Z`;
    return d;
}
function smoothThrough(pts) {
    if (pts.length < 2)
        return "";
    let d = "";
    for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
        d += `Q${f(pts[i].x)},${f(pts[i].y)} ${f(mx)},${f(my)}`;
    }
    const last = pts[pts.length - 1];
    d += `L${f(last.x)},${f(last.y)}`;
    return d;
}
function densify(raw) {
    const out = [raw[0]];
    for (let i = 1; i < raw.length; i++) {
        const a = raw[i - 1], b = raw[i];
        const n = Math.min(64, Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / 6));
        for (let k = 1; k < n; k++) {
            const t = k / n;
            out.push({ ...b, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: (a.p ?? 0.5) + ((b.p ?? 0.5) - (a.p ?? 0.5)) * t });
        }
        out.push(b);
    }
    return out;
}
export function centerPath(raw) {
    if (!raw.length)
        return "";
    const pts = densify(raw);
    if (pts.length === 1)
        return `M${f(pts[0].x)},${f(pts[0].y)}l0.01,0`;
    return `M${f(pts[0].x)},${f(pts[0].y)}` + smoothThrough(pts);
}
function totalLength(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++)
        L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return L;
}
export function arrowPath(a, b, width) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = Math.min(26, Math.max(12, Math.hypot(b.x - a.x, b.y - a.y) * 0.28)) + width;
    const spread = 0.5;
    const p1 = { x: b.x - len * Math.cos(ang - spread), y: b.y - len * Math.sin(ang - spread) };
    const p2 = { x: b.x - len * Math.cos(ang + spread), y: b.y - len * Math.sin(ang + spread) };
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const bow = Math.min(10, L * 0.035);
    const cx = mx - Math.sin(ang) * bow, cy = my + Math.cos(ang) * bow;
    return `M${f(a.x)},${f(a.y)}Q${f(cx)},${f(cy)} ${f(b.x)},${f(b.y)}M${f(p1.x)},${f(p1.y)}L${f(b.x)},${f(b.y)}L${f(p2.x)},${f(p2.y)}`;
}
