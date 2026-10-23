/**
 * A small SVG sketch of a board for the "Your boards" list. Built from the CRDT state, so it
 * matches what's on the board, and kept tiny (strokes simplified, text as lines).
 * It is shown through <img>, which never runs scripts and never loads outside resources.
 */
import type { Doc } from "../crdt/doc.js";
import { BRUSH_SIZE, arrowPath, centerPath, decodeStroke, outlinePath, simplify, type Brush } from "../draw/stroke.js";
import { inkHex, paperHex } from "./palette.js";
import { num } from "./view.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function boardPreview(doc: Doc, maxBytes = 55000): string | null {
  const ids = doc.itemIds().sort((a, b) => num(doc.prop(a, "z"), 0) - num(doc.prop(b, "z"), 0));
  if (!ids.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const geo = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const id of ids) {
    const g = { x: num(doc.prop(id, "x"), 0), y: num(doc.prop(id, "y"), 0), w: Math.max(4, num(doc.prop(id, "w"), 200)), h: Math.max(4, num(doc.prop(id, "h"), 150)) };
    geo.set(id, g);
    x0 = Math.min(x0, g.x); y0 = Math.min(y0, g.y);
    x1 = Math.max(x1, g.x + g.w); y1 = Math.max(y1, g.y + g.h);
  }
  const pad = 40;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  // keep a pleasant 4:3 frame
  let w = x1 - x0, h = y1 - y0;
  if (w / h > 4 / 3) {
    const nh = w * 0.75;
    y0 -= (nh - h) / 2;
    h = nh;
  } else {
    const nw = h * (4 / 3);
    x0 -= (nw - w) / 2;
    w = nw;
  }
  const r = (n: number) => Math.round(n);
  const parts: string[] = [];
  for (const id of ids) {
    const g = geo.get(id)!;
    const kind = String(doc.prop(id, "kind") ?? "note");
    const color = doc.prop(id, "color");
    const X = r(g.x - x0), Y = r(g.y - y0);
    if (kind === "ink" || kind === "arrow") {
      const s = decodeStroke(String(doc.prop(id, "d") ?? ""));
      if (!s) continue;
      const brush = (String(doc.prop(id, "brush") ?? "pen") as Brush) in BRUSH_SIZE ? (String(doc.prop(id, "brush")) as Brush) : "pen";
      const pts = simplify(s.pts, 1.5);
      const sx = g.w / s.w, sy = g.h / s.h;
      const tf = `translate(${X} ${Y}) scale(${sx.toFixed(3)} ${sy.toFixed(3)})`;
      const hex = inkHex(color);
      if (kind === "arrow") parts.push(`<path transform="${tf}" d="${arrowPath(pts[0], pts[pts.length - 1], 3)}" fill="none" stroke="${hex}" stroke-width="3" stroke-linecap="round"/>`);
      else if (brush === "hl") parts.push(`<path transform="${tf}" d="${centerPath(pts)}" fill="none" stroke="${hex}" stroke-opacity=".38" stroke-width="${BRUSH_SIZE.hl}" stroke-linecap="round"/>`);
      else parts.push(`<path transform="${tf}" d="${outlinePath(pts, BRUSH_SIZE[brush], true)}" fill="${hex}"/>`);
      continue;
    }
    if (kind === "image") {
      parts.push(`<rect x="${X}" y="${Y}" width="${r(g.w)}" height="${r(g.h)}" rx="6" fill="#d9dee3"/><path d="M${X + g.w * 0.2} ${Y + g.h * 0.75}l${g.w * 0.22} -${g.h * 0.3} ${g.w * 0.16} ${g.h * 0.18} ${g.w * 0.12} -${g.h * 0.1} ${g.w * 0.1} ${g.h * 0.22}z" fill="#b4bcc5"/>`);
      continue;
    }
    if (kind === "note") parts.push(`<rect x="${X}" y="${Y}" width="${r(g.w)}" height="${r(g.h)}" rx="3" fill="${paperHex(color)}"/>`);
    if (kind === "rect") parts.push(`<rect x="${X}" y="${Y}" width="${r(g.w)}" height="${r(g.h)}" rx="12" fill="${paperHex(color)}" stroke="#17191e" stroke-width="3"/>`);
    if (kind === "ellipse") parts.push(`<ellipse cx="${X + g.w / 2}" cy="${Y + g.h / 2}" rx="${g.w / 2}" ry="${g.h / 2}" fill="${paperHex(color)}" stroke="#17191e" stroke-width="3"/>`);
    // text as a few marker lines, which reads better than tiny letters at thumbnail size
    const text = doc.text(id).trim();
    if (text) {
      const lines = Math.min(4, Math.ceil(text.length / 18));
      const lh = 22;
      const top = kind === "note" || kind === "text" ? Y + 22 : Y + g.h / 2 - ((lines - 1) * lh) / 2;
      for (let i = 0; i < lines; i++) {
        const len = Math.min(g.w - 36, (i === lines - 1 ? 0.55 : 0.9) * (g.w - 36));
        const lx = kind === "note" || kind === "text" ? X + 16 : X + (g.w - len) / 2;
        parts.push(`<path d="M${r(lx)} ${r(top + i * lh)}h${r(len)}" stroke="${kind === "text" ? inkHex(color ?? "ink") : "#17191e"}" stroke-opacity=".55" stroke-width="7" stroke-linecap="round"/>`);
      }
    }
  }
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r(w)} ${r(h)}"><title>${esc("Board preview")}</title><rect width="100%" height="100%" fill="#f8fafb"/>${parts.join("")}</svg>`;
  if (svg.length > maxBytes) {
    // too detailed: drop the oldest strokes until it fits
    while (svg.length > maxBytes && parts.length > 1) {
      parts.splice(0, Math.ceil(parts.length * 0.15));
      svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r(w)} ${r(h)}"><rect width="100%" height="100%" fill="#f8fafb"/>${parts.join("")}</svg>`;
    }
  }
  return svg.length <= maxBytes ? svg : null;
}
