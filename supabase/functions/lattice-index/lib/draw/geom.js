// Generated from src/draw/geom.ts by scripts/copy-crdt.mjs. Do not edit.
export const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
export function outerBox(g) {
    const a = ((g.r ?? 0) * Math.PI) / 180;
    if (!a)
        return g;
    const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const w = g.w * c + g.h * s, h = g.w * s + g.h * c;
    return { x: g.x + g.w / 2 - w / 2, y: g.y + g.h / 2 - h / 2, w, h };
}
