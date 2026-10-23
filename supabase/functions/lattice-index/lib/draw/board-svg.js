// Generated from src/draw/board-svg.ts by scripts/copy-crdt.mjs. Do not edit.
import { inkHex, paperHex } from "../app/palette.js";
import { num, outerBox } from "./geom.js";
import { BRUSH_SIZE, arrowPath, centerPath, decodeStroke, outlinePath, simplify } from "./stroke.js";
const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const r = (n) => Math.round(n);
const HAND = `'Shantell Sans','Segoe Print','Comic Sans MS',cursive`;
function turn(parts, from, g, x0, y0) {
    if (!g.r || parts.length <= from)
        return;
    const cx = r(g.x - x0 + g.w / 2), cy = r(g.y - y0 + g.h / 2);
    const inner = parts.splice(from).join("");
    parts.push(`<g transform="rotate(${Math.round(g.r * 10) / 10} ${cx} ${cy})">${inner}</g>`);
}
function wrap(text, width, fs) {
    const per = Math.max(4, Math.floor(width / (fs * 0.55)));
    const out = [];
    for (const para of text.split("\n")) {
        let line = "";
        for (const word of para.split(/(\s+)/)) {
            if (!word)
                continue;
            if ((line + word).length <= per)
                line += word;
            else if (!line.trim()) {
                for (let i = 0; i < word.length; i += per)
                    out.push(word.slice(i, i + per));
                line = "";
            }
            else {
                out.push(line.trimEnd());
                line = word.trimStart();
            }
        }
        out.push(line.trimEnd());
    }
    return out;
}
export function boardSvg(doc, o = {}) {
    const full = !!o.full;
    const maxBytes = o.maxBytes ?? (full ? 9_000_000 : 55_000);
    const ids = doc.itemIds().sort((a, b) => num(doc.prop(a, "z"), 0) - num(doc.prop(b, "z"), 0));
    if (!ids.length)
        return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const geo = new Map();
    for (const id of ids) {
        const kind = doc.prop(id, "kind");
        const g = {
            x: num(doc.prop(id, "x"), 0),
            y: num(doc.prop(id, "y"), 0),
            w: Math.max(4, num(doc.prop(id, "w"), 200)),
            h: Math.max(4, num(doc.prop(id, "h"), 150)),
            r: kind === "arrow" ? 0 : num(doc.prop(id, "r"), 0),
        };
        geo.set(id, g);
        const b = outerBox(g);
        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w);
        y1 = Math.max(y1, b.y + b.h);
    }
    const pad = full ? 60 : 40;
    x0 -= pad;
    y0 -= pad;
    x1 += pad;
    y1 += pad;
    let w = x1 - x0, h = y1 - y0;
    if (!full) {
        if (w / h > 4 / 3) {
            const nh = w * 0.75;
            y0 -= (nh - h) / 2;
            h = nh;
        }
        else {
            const nw = h * (4 / 3);
            x0 -= (nw - w) / 2;
            w = nw;
        }
    }
    const parts = [];
    for (const id of ids) {
        const g = geo.get(id);
        const before = parts.length;
        const kind = String(doc.prop(id, "kind") ?? "note");
        const color = doc.prop(id, "color");
        const X = r(g.x - x0), Y = r(g.y - y0), W = r(g.w), H = r(g.h);
        if (kind === "ink" || kind === "arrow") {
            const s = decodeStroke(String(doc.prop(id, "d") ?? ""));
            if (!s)
                continue;
            const raw = String(doc.prop(id, "brush") ?? "pen");
            const brush = raw in BRUSH_SIZE ? raw : "pen";
            const pts = full ? s.pts : simplify(s.pts, 1.5);
            const tf = `translate(${X} ${Y}) scale(${(g.w / s.w).toFixed(3)} ${(g.h / s.h).toFixed(3)})`;
            const hex = inkHex(color);
            if (kind === "arrow")
                parts.push(`<path transform="${tf}" d="${arrowPath(pts[0], pts[pts.length - 1], 3)}" fill="none" stroke="${hex}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`);
            else if (brush === "hl")
                parts.push(`<path transform="${tf}" d="${centerPath(pts)}" fill="none" stroke="${hex}" stroke-opacity=".38" stroke-width="${BRUSH_SIZE.hl}" stroke-linecap="round" stroke-linejoin="round"/>`);
            else
                parts.push(`<path transform="${tf}" d="${outlinePath(pts, BRUSH_SIZE[brush], !pts.some((p) => p.p !== pts[0].p))}" fill="${hex}"/>`);
            turn(parts, before, g, x0, y0);
            continue;
        }
        if (kind === "image" || kind === "video") {
            const src = String(doc.prop(id, "src") ?? "");
            const url = full && src && o.mediaUrl ? o.mediaUrl(kind, src) : null;
            if (kind === "image") {
                parts.push(`<rect x="${X}" y="${Y}" width="${W}" height="${H}" rx="8" fill="#d9dee3"/>`);
                if (url)
                    parts.push(`<image href="${esc(url)}" x="${X}" y="${Y}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`);
                else
                    parts.push(`<path d="M${r(X + g.w * 0.2)} ${r(Y + g.h * 0.75)}l${r(g.w * 0.22)} -${r(g.h * 0.3)} ${r(g.w * 0.16)} ${r(g.h * 0.18)} ${r(g.w * 0.12)} -${r(g.h * 0.1)} ${r(g.w * 0.1)} ${r(g.h * 0.22)}z" fill="#b4bcc5"/>`);
            }
            else {
                const t = Math.max(10, Math.min(g.w, g.h) * 0.12);
                const cx = X + g.w / 2, cy = Y + g.h / 2;
                const video = `<rect x="${X}" y="${Y}" width="${W}" height="${H}" rx="10" fill="#17191e"/>` +
                    `<circle cx="${r(cx)}" cy="${r(cy)}" r="${r(t * 1.6)}" fill="#fff" fill-opacity=".14"/>` +
                    `<path d="M${r(cx - t * 0.5)} ${r(cy - t * 0.75)}l${r(t * 1.35)} ${r(t * 0.75)}-${r(t * 1.35)} ${r(t * 0.75)}z" fill="#fff"/>`;
                parts.push(url ? `<a href="${esc(url)}" target="_blank">${video}</a>` : video);
            }
            turn(parts, before, g, x0, y0);
            continue;
        }
        if (kind === "note")
            parts.push(`<rect x="${X}" y="${Y}" width="${W}" height="${H}" rx="4" fill="${paperHex(color)}"/>`);
        if (kind === "rect")
            parts.push(`<rect x="${X}" y="${Y}" width="${W}" height="${H}" rx="14" fill="${paperHex(color)}" stroke="#17191e" stroke-width="2.5"/>`);
        if (kind === "ellipse")
            parts.push(`<ellipse cx="${r(X + g.w / 2)}" cy="${r(Y + g.h / 2)}" rx="${r(g.w / 2)}" ry="${r(g.h / 2)}" fill="${paperHex(color)}" stroke="#17191e" stroke-width="2.5"/>`);
        const text = doc.text(id);
        if (text.trim()) {
            const ink = kind === "text" ? inkHex(color ?? "ink") : "#17191e";
            if (!full) {
                const lines = Math.min(4, Math.ceil(text.trim().length / 18));
                const lh = 22;
                const top = kind === "note" || kind === "text" ? Y + 22 : Y + g.h / 2 - ((lines - 1) * lh) / 2;
                for (let i = 0; i < lines; i++) {
                    const len = Math.min(g.w - 36, (i === lines - 1 ? 0.55 : 0.9) * (g.w - 36));
                    const lx = kind === "note" || kind === "text" ? X + 16 : X + (g.w - len) / 2;
                    parts.push(`<path d="M${r(lx)} ${r(top + i * lh)}h${r(len)}" stroke="${ink}" stroke-opacity=".55" stroke-width="7" stroke-linecap="round"/>`);
                }
            }
            else {
                const fs = num(doc.prop(id, "fs"), kind === "text" ? 26 : 20);
                const lh = fs * 1.28;
                const padX = kind === "note" ? 16 : kind === "text" ? 6 : kind === "ellipse" ? g.w * 0.16 : 14;
                const padY = kind === "note" ? 16 : kind === "text" ? 4 : kind === "ellipse" ? g.h * 0.2 : 14;
                const maxLines = Math.max(1, Math.floor((g.h - padY * 2) / lh) + (kind === "text" ? 1 : 0));
                const lines = wrap(text, g.w - padX * 2, fs).slice(0, maxLines);
                const centred = kind === "rect" || kind === "ellipse";
                const top = centred ? Y + g.h / 2 - (lines.length * lh) / 2 : Y + padY;
                const tx = centred ? X + g.w / 2 : X + padX;
                const tspans = lines.map((l, i) => `<tspan x="${r(tx)}" y="${r(top + i * lh + fs)}">${esc(l) || " "}</tspan>`).join("");
                parts.push(`<text font-family="${HAND}" font-size="${fs}" font-weight="${kind === "text" ? 600 : 500}" fill="${ink}"${centred ? ' text-anchor="middle"' : ""} xml:space="preserve">${tspans}</text>`);
            }
        }
        turn(parts, before, g, x0, y0);
    }
    const head = full
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="${r(w)}" height="${r(h)}" viewBox="0 0 ${r(w)} ${r(h)}"><title>${esc(o.title ?? "Board")}</title>`
        : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r(w)} ${r(h)}"><title>${esc(o.title ?? "Board preview")}</title>`;
    const bg = `<rect width="100%" height="100%" fill="#f8fafb"/>`;
    let svg = `${head}${bg}${parts.join("")}</svg>`;
    while (svg.length > maxBytes && parts.length > 1) {
        parts.splice(0, Math.ceil(parts.length * 0.15));
        svg = `${head}${bg}${parts.join("")}</svg>`;
    }
    return svg.length <= maxBytes ? svg : null;
}
