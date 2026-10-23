/**
 * BoardView renders a CRDT Doc into DOM: notes, shapes, text, images, ink strokes and arrows.
 * It knows nothing about input or the network, so the same renderer draws the real board,
 * the replicas in the landing-page demo, and the lab.
 */
import type { Doc } from "../crdt/doc.js";
import type { Json } from "../crdt/lww.js";
import { BRUSH_SIZE, arrowPath, centerPath, decodeStroke, outlinePath, type Brush, type Pt } from "../draw/stroke.js";
import { imageUrl } from "../sync/config.js";
import { inkHex, paperHex } from "./palette.js";

const SVG = "http://www.w3.org/2000/svg";
export const num = (v: Json | undefined, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ViewOptions {
  /** Animate items that arrive from other replicas. */
  animateRemote?: boolean;
}

export class BoardView {
  readonly nodes = new Map<string, HTMLElement>();
  private liveLayer: SVGSVGElement;
  private live = new Map<string, SVGPathElement>();
  private unsub: () => void;
  selected: string | null = null;
  /** Item whose text is being edited in a textarea; the view leaves its text node alone. */
  editing: string | null = null;
  onTextRender?: (item: string, source: "local" | "remote") => void;

  constructor(
    readonly world: HTMLElement,
    readonly doc: Doc,
    private readonly opts: ViewOptions = {},
  ) {
    this.liveLayer = document.createElementNS(SVG, "svg");
    this.liveLayer.setAttribute("class", "live-ink");
    this.liveLayer.setAttribute("aria-hidden", "true");
    world.append(this.liveLayer);
    this.unsub = doc.onChange((change, source) => {
      for (const id of change.items) this.renderItem(id, source === "remote");
      for (const id of change.texts) this.renderText(id, source);
    });
    for (const id of doc.itemIds()) this.renderItem(id, false);
  }

  destroy(): void {
    this.unsub();
  }

  kind(id: string): string {
    return String(this.doc.prop(id, "kind") ?? "note");
  }

  geom(id: string): Geom {
    const k = this.kind(id);
    const min = k === "ink" || k === "arrow" ? 4 : k === "text" ? 40 : 60;
    return {
      x: num(this.doc.prop(id, "x"), 0),
      y: num(this.doc.prop(id, "y"), 0),
      w: Math.max(min, num(this.doc.prop(id, "w"), 200)),
      h: Math.max(k === "text" ? 30 : min, num(this.doc.prop(id, "h"), 150)),
    };
  }

  /** Bounding box of everything on the board, or null when empty. */
  bounds(): Geom | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of this.doc.itemIds()) {
      const g = this.geom(id);
      x0 = Math.min(x0, g.x); y0 = Math.min(y0, g.y);
      x1 = Math.max(x1, g.x + g.w); y1 = Math.max(y1, g.y + g.h);
    }
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  select(id: string | null): void {
    if (this.selected === id) return;
    if (this.selected) this.nodes.get(this.selected)?.classList.remove("selected");
    this.selected = id;
    if (id) this.nodes.get(id)?.classList.add("selected");
  }

  // ------------------------------------------------------------------ items

  renderItem(id: string, remote: boolean): void {
    let node = this.nodes.get(id);
    if (!this.doc.hasItem(id)) {
      if (node) {
        this.nodes.delete(id);
        const n = node;
        n.classList.add("leaving");
        n.style.pointerEvents = "none";
        setTimeout(() => n.remove(), 160);
      }
      if (this.selected === id) this.selected = null;
      return;
    }
    const kind = this.kind(id);
    if (node && node.dataset.kind !== kind) {
      node.remove();
      this.nodes.delete(id);
      node = undefined;
    }
    if (!node) {
      node = this.create(id, kind);
      if (remote && this.opts.animateRemote !== false) node.classList.add("arrive");
      this.world.insertBefore(node, this.liveLayer);
      this.nodes.set(id, node);
      this.clearLive(id);
    }
    node.classList.toggle("selected", this.selected === id);
    if (!node.classList.contains("dragging")) this.place(id, node, this.geom(id));
    node.style.zIndex = String(Math.round(num(this.doc.prop(id, "z"), 0)));
    this.paint(id, kind, node);
  }

  /** Position and size an item (also used while dragging, before the op is committed). */
  place(id: string, node: HTMLElement, g: Geom): void {
    node.style.transform = `translate(${g.x}px, ${g.y}px)`;
    node.style.width = `${g.w}px`;
    node.style.height = `${g.h}px`;
    void id;
  }

  private create(id: string, kind: string): HTMLElement {
    const node = document.createElement("div");
    node.className = `item ${kind}`;
    node.dataset.id = id;
    node.dataset.kind = kind;
    if (kind === "ink" || kind === "arrow") {
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("preserveAspectRatio", "none");
      const hit = document.createElementNS(SVG, "path");
      hit.setAttribute("class", "hit");
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("class", "stroke");
      svg.append(hit, path);
      node.append(svg);
    } else if (kind === "image") {
      const img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.loading = "lazy";
      img.draggable = false;
      img.addEventListener("load", () => node.classList.add("loaded"));
      node.append(img);
    } else {
      const t = document.createElement("div");
      t.className = "text";
      node.append(t);
      this.writeText(id, t);
    }
    if (kind !== "arrow") {
      const grip = document.createElement("div");
      grip.className = "grip";
      node.append(grip);
    }
    return node;
  }

  private paint(id: string, kind: string, node: HTMLElement): void {
    const color = this.doc.prop(id, "color");
    if (kind === "ink" || kind === "arrow") {
      const brush = (String(this.doc.prop(id, "brush") ?? "pen") as Brush) in BRUSH_SIZE ? (String(this.doc.prop(id, "brush") ?? "pen") as Brush) : "pen";
      const d = String(this.doc.prop(id, "d") ?? "");
      if (node.dataset.d === d && node.dataset.brush === brush && node.dataset.color === String(color)) return;
      node.dataset.d = d;
      node.dataset.brush = brush;
      node.dataset.color = String(color);
      const s = decodeStroke(d);
      const svg = node.querySelector("svg")!;
      const path = svg.querySelector<SVGPathElement>(".stroke")!;
      const hit = svg.querySelector<SVGPathElement>(".hit")!;
      if (!s) return;
      svg.setAttribute("viewBox", `0 0 ${s.w} ${s.h}`);
      const hex = inkHex(color);
      const size = BRUSH_SIZE[brush];
      const center = centerPath(s.pts);
      hit.setAttribute("d", kind === "arrow" ? arrowPath(s.pts[0], s.pts[s.pts.length - 1], 3) : center);
      if (kind === "arrow") {
        path.setAttribute("d", arrowPath(s.pts[0], s.pts[s.pts.length - 1], 3));
        path.setAttribute("style", `fill:none;stroke:${hex};stroke-width:3;stroke-linecap:round;stroke-linejoin:round`);
        node.dataset.brush = "arrow";
      } else if (brush === "hl") {
        path.setAttribute("d", center);
        path.setAttribute("style", `fill:none;stroke:${hex};stroke-width:${size};stroke-linecap:round;stroke-linejoin:round;opacity:.38`);
      } else {
        path.setAttribute("d", outlinePath(s.pts, size, !s.pts.some((p) => p.p !== s.pts[0].p)));
        path.setAttribute("style", `fill:${hex};stroke:none`);
      }
      node.classList.toggle("hl", brush === "hl");
      return;
    }
    if (kind === "image") {
      const src = String(this.doc.prop(id, "src") ?? "");
      const img = node.querySelector("img")!;
      const url = src ? imageUrl(src) : "";
      node.classList.toggle("pending", !src && !node.dataset.local);
      if (node.dataset.local && !src) return; // showing the uploader's local preview
      if (url && img.getAttribute("src") !== url) {
        node.classList.remove("loaded");
        img.src = url;
      }
      return;
    }
    if (kind === "note" || kind === "rect" || kind === "ellipse") node.style.setProperty("--fill", paperHex(color));
    if (kind === "text") node.style.setProperty("--fill", inkHex(color ?? "ink"));
  }

  /** Show a local blob for an image that is still uploading. */
  showLocalImage(id: string, url: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.dataset.local = "1";
    node.classList.add("uploading");
    const img = node.querySelector("img");
    if (img) img.src = url;
  }

  clearLocalImage(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    delete node.dataset.local;
    node.classList.remove("uploading");
    this.renderItem(id, false);
  }

  // ------------------------------------------------------------------ text

  renderText(id: string, source: "local" | "remote"): void {
    if (this.editing === id) {
      this.onTextRender?.(id, source);
      return;
    }
    const t = this.nodes.get(id)?.querySelector<HTMLElement>(".text");
    if (t) this.writeText(id, t);
  }

  private writeText(id: string, t: HTMLElement): void {
    const text = this.doc.text(id);
    if (t.textContent !== text) t.textContent = text;
  }

  // ------------------------------------------------------------------ live strokes from other people

  setLive(id: string, pts: Pt[], brush: Brush, color: string): void {
    if (this.nodes.has(id)) return; // already committed
    let p = this.live.get(id);
    if (!p) {
      p = document.createElementNS(SVG, "path");
      this.live.set(id, p);
      this.liveLayer.append(p);
    }
    const hex = inkHex(color);
    if (brush === "hl") {
      p.setAttribute("d", centerPath(pts));
      p.setAttribute("style", `fill:none;stroke:${hex};stroke-width:${BRUSH_SIZE.hl};stroke-linecap:round;stroke-linejoin:round;opacity:.38`);
    } else {
      p.setAttribute("d", outlinePath(pts, BRUSH_SIZE[brush], !pts.some((q) => q.p !== pts[0].p)));
      p.setAttribute("style", `fill:${hex}`);
    }
  }

  setLiveArrow(id: string, a: { x: number; y: number }, b: { x: number; y: number }, color: string): void {
    let p = this.live.get(id);
    if (!p) {
      p = document.createElementNS(SVG, "path");
      this.live.set(id, p);
      this.liveLayer.append(p);
    }
    p.setAttribute("d", arrowPath(a, b, 3));
    p.setAttribute("style", `fill:none;stroke:${inkHex(color)};stroke-width:3;stroke-linecap:round;stroke-linejoin:round`);
  }

  clearLive(id: string): void {
    const p = this.live.get(id);
    if (p) {
      p.remove();
      this.live.delete(id);
    }
  }
}
