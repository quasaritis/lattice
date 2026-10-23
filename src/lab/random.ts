/** Seeded randomness and random editing, shared by the test suite and the in-browser lab. */
import type { Doc, Op } from "../crdt/doc.js";
import { BRUSH_SIZE, encodeStroke, type Brush, type Pt } from "../draw/stroke.js";

export type Rng = () => number;

/** mulberry32: tiny, fast, good enough for fuzzing, and reproducible from a seed. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

export const COLORS = ["sun", "mint", "sky", "rose", "lilac", "paper"] as const;
const WORDS = ["merge", "lattice", "join", "replica", "offline", "sync", "commute", "idempotent", "causal", "tombstone", "ok", "ship it"];

let itemCounter = 0;
export function newItemId(r?: Rng): string {
  const rand = r ? Math.floor(r() * 1e9).toString(36) : Math.random().toString(36).slice(2, 9);
  return `i${(itemCounter++).toString(36)}${rand}`;
}

/**
 * Make one random local edit on `doc`, the way a busy user would:
 * add notes, drag them, recolour, delete, and type or delete text, sometimes in the
 * middle of a word. Returns the ops it produced.
 */
export function randomEdit(doc: Doc, r: Rng): Op[] {
  const items = doc.itemIds();
  const roll = r();
  if (roll < 0.05) return randomStroke(doc, r);
  if (!items.length || roll < 0.12) {
    return doc.createItem(newItemId(r), { kind: pick(r, ["note", "rect", "ellipse"]), x: int(r, 0, 900), y: int(r, 0, 500), w: 180, h: 140, color: pick(r, COLORS), z: int(r, 0, 100) }, r() < 0.5 ? pick(r, WORDS) : "");
  }
  const item = pick(r, items);
  if (roll < 0.35) return doc.setProps(item, { x: int(r, 0, 900), y: int(r, 0, 500) });
  if (roll < 0.42) return doc.setProps(item, { color: pick(r, COLORS) });
  if (roll < 0.47) return doc.deleteItem(item);
  // text edit: insert, delete, or replace a span
  const cur = Array.from(doc.text(item));
  const at = int(r, 0, cur.length);
  const kind = r();
  if (kind < 0.55 || !cur.length) {
    cur.splice(at, 0, ...Array.from((r() < 0.5 ? " " : "") + pick(r, WORDS)));
  } else if (kind < 0.85) {
    cur.splice(Math.min(at, cur.length - 1), int(r, 1, 4));
  } else {
    cur.splice(Math.min(at, cur.length - 1), int(r, 1, 3), ...Array.from(pick(r, WORDS)));
  }
  return doc.editText(item, cur.join(""));
}

export const INK_COLORS = ["ink", "blue", "red", "green", "orange", "violet"] as const;

/** A random scribble, encoded exactly like a real pen stroke. */
export function randomStroke(doc: Doc, r: Rng): Op[] {
  const brush = pick(r, ["pen", "marker", "hl"] as Brush[]);
  const pts: Pt[] = [];
  let x = int(r, 0, 900), y = int(r, 0, 500);
  for (let i = 0, n = int(r, 1, 60); i < n; i++) {
    x += r() * 16 - 8;
    y += r() * 16 - 8;
    pts.push({ x, y, p: r() });
  }
  const s = encodeStroke(pts, BRUSH_SIZE[brush] / 2 + 2);
  return doc.createItem(newItemId(r), { kind: "ink", brush, color: pick(r, INK_COLORS), x: s.x, y: s.y, w: s.w, h: s.h, d: s.d, z: int(r, 0, 100) });
}
