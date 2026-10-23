/** Item geometry shared by the board, its thumbnails and the server-side renderer (no DOM here). */
import type { Json } from "../crdt/lww.js";

export const num = (v: Json | undefined, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
  /** rotation in degrees, around the centre */
  r?: number;
}

/** Axis-aligned box around a rotated item. */
export function outerBox(g: Geom): Geom {
  const a = ((g.r ?? 0) * Math.PI) / 180;
  if (!a) return g;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const w = g.w * c + g.h * s, h = g.w * s + g.h * c;
  return { x: g.x + g.w / 2 - w / 2, y: g.y + g.h / 2 - h / 2, w, h };
}
