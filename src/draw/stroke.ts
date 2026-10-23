/**
 * Freehand strokes: capture, compact encoding for the CRDT, and rendering.
 *
 * A stroke is stored as one LWW field ("d") on an ink item, so a finished stroke is a
 * single atomic value: two people drawing at once just add two items to the OR-Set.
 *
 * Encoding (all numbers are integers in half-pixel units, relative to the item origin):
 *   "W,H:x,y,p;dx,dy,p;dx,dy,p..."
 * W,H is the stroke's natural size, so a resized ink item scales its points instead of
 * re-encoding them. p is pressure 0..9. Deltas keep long strokes short on the wire.
 *
 * The outline renderer is a small take on the "perfect freehand" idea: pressure and speed
 * set the radius at each point, and the filled outline is built from offset points with
 * round caps, smoothed with quadratic curves through midpoints.
 */

export interface Pt {
  x: number;
  y: number;
  /** pressure 0..1 */
  p: number;
}

export type Brush = "pen" | "marker" | "hl";

export const BRUSH_SIZE: Record<Brush, number> = { pen: 3.2, marker: 9, hl: 22 };

export interface EncodedStroke {
  x: number;
  y: number;
  w: number;
  h: number;
  d: string;
}

const UNIT = 2; // half pixels

/** Drop points that add nothing (Ramer–Douglas–Peucker), keeping pressure on the survivors. */
export function simplify(pts: Pt[], tolerance = 0.6): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
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

/** Encode world-space points into an item box + compact string. */
export function encodeStroke(world: Pt[], pad: number, maxPoints = 900): EncodedStroke {
  let pts = simplify(world);
  if (pts.length > maxPoints) {
    const step = pts.length / maxPoints;
    pts = Array.from({ length: maxPoints }, (_, i) => pts[Math.min(pts.length - 1, Math.round(i * step))]);
  }
  if (pts.length === 1) pts = [pts[0], { ...pts[0], x: pts[0].x + 0.5 }];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const x = Math.floor(minX - pad), y = Math.floor(minY - pad);
  const w = Math.ceil(maxX + pad) - x, h = Math.ceil(maxY + pad) - y;
  const parts: string[] = [];
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

export interface DecodedStroke {
  /** natural size in px */
  w: number;
  h: number;
  /** points in px, relative to the item origin at natural size */
  pts: Pt[];
}

const cache = new Map<string, DecodedStroke>();

export function decodeStroke(d: string): DecodedStroke | null {
  const hit = cache.get(d);
  if (hit) return hit;
  const colon = d.indexOf(":");
  if (colon < 0) return null;
  const [W, H] = d.slice(0, colon).split(",").map(Number);
  const pts: Pt[] = [];
  let x = 0, y = 0;
  for (const part of d.slice(colon + 1).split(";")) {
    const [a, b, c] = part.split(",").map(Number);
    if (![a, b, c].every(Number.isFinite)) return null;
    x += a;
    y += b;
    pts.push({ x: x / UNIT, y: y / UNIT, p: c / 9 });
  }
  const out = { w: W / UNIT, h: H / UNIT, pts };
  if (cache.size > 2000) cache.clear();
  cache.set(d, out);
  return out;
}

// ------------------------------------------------------------------ geometry

function segDist(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Smallest distance from (x, y) to a polyline. */
export function distanceToPolyline(pts: { x: number; y: number }[], x: number, y: number): number {
  if (pts.length === 1) return Math.hypot(pts[0].x - x, pts[0].y - y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, segDist({ x, y }, pts[i - 1], pts[i]));
  return best;
}

const f = (n: number) => Math.round(n * 100) / 100;

/**
 * Filled outline for a pen or marker stroke. `size` is the full width at pressure 1.
 * `simulatePressure` thins fast strokes when the device gives no pressure (mouse, finger).
 */
export function outlinePath(input: Pt[], size: number, simulatePressure: boolean): string {
  if (!input.length) return "";
  // streamline: follow the pointer a little lazily, which removes hand jitter
  const pts: Pt[] = [{ ...input[0] }];
  for (let i = 1; i < input.length; i++) {
    const prev = pts[pts.length - 1];
    const cur = input[i];
    // only small moves are jitter; after simplification the points are far apart and are real corners
    const k = Math.min(1, 0.62 + Math.hypot(cur.x - prev.x, cur.y - prev.y) / (size * 6));
    pts.push({ x: prev.x + (cur.x - prev.x) * k, y: prev.y + (cur.y - prev.y) * k, p: cur.p });
  }
  pts.push({ ...input[input.length - 1] });

  if (pts.length < 3 || totalLength(pts) < size * 0.6) {
    const c = pts[0];
    const r = (size / 2) * (simulatePressure ? 0.9 : 0.5 + c.p * 0.5);
    return `M${f(c.x - r)},${f(c.y)}a${f(r)},${f(r)} 0 1,0 ${f(r * 2)},0a${f(r)},${f(r)} 0 1,0 ${f(-r * 2)},0Z`;
  }

  // radius per point
  const radii: number[] = [];
  let prevR = size / 2;
  for (let i = 0; i < pts.length; i++) {
    let pressure: number;
    if (simulatePressure) {
      const a = pts[Math.max(0, i - 1)], b = pts[i];
      const speed = Math.min(1, Math.hypot(b.x - a.x, b.y - a.y) / (size * 2.2));
      pressure = 1 - speed * 0.55;
    } else pressure = pts[i].p;
    let r = (size / 2) * (0.35 + 0.65 * Math.max(0.05, pressure));
    r = prevR + (r - prevR) * 0.35; // ease radius changes
    // taper the first and last few pixels a little, like a real nib
    const fromStart = i / 6, fromEnd = (pts.length - 1 - i) / 6;
    r *= Math.min(1, 0.55 + 0.45 * Math.min(fromStart, fromEnd, 1));
    radii.push(r);
    prevR = r;
  }

  const left: { x: number; y: number }[] = [];
  const right: { x: number; y: number }[] = [];
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

/** Quadratic curves through midpoints: smooth, and passes near every point. */
function smoothThrough(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = "";
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    d += `Q${f(pts[i].x)},${f(pts[i].y)} ${f(mx)},${f(my)}`;
  }
  const last = pts[pts.length - 1];
  d += `L${f(last.x)},${f(last.y)}`;
  return d;
}

/** Centre-line path, used for the highlighter (stroked, not filled). */
export function centerPath(pts: { x: number; y: number }[]): string {
  if (!pts.length) return "";
  if (pts.length === 1) return `M${f(pts[0].x)},${f(pts[0].y)}l0.01,0`;
  return `M${f(pts[0].x)},${f(pts[0].y)}` + smoothThrough(pts);
}

function totalLength(pts: { x: number; y: number }[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

/** Arrowhead for a line from a to b, as two short strokes at the tip. */
export function arrowPath(a: { x: number; y: number }, b: { x: number; y: number }, width: number): string {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const len = Math.min(26, Math.max(12, Math.hypot(b.x - a.x, b.y - a.y) * 0.28)) + width;
  const spread = 0.5;
  const p1 = { x: b.x - len * Math.cos(ang - spread), y: b.y - len * Math.sin(ang - spread) };
  const p2 = { x: b.x - len * Math.cos(ang + spread), y: b.y - len * Math.sin(ang + spread) };
  // a very slight bow makes the shaft read as drawn by hand
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const bow = Math.min(10, L * 0.035);
  const cx = mx - Math.sin(ang) * bow, cy = my + Math.cos(ang) * bow;
  return `M${f(a.x)},${f(a.y)}Q${f(cx)},${f(cy)} ${f(b.x)},${f(b.y)}M${f(p1.x)},${f(p1.y)}L${f(b.x)},${f(b.y)}L${f(p2.x)},${f(p2.y)}`;
}
