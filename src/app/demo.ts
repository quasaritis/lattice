/**
 * Two real replicas of a board, side by side, joined by the simulated network from the test
 * suite. Scripted people move cursors, draw with the real pen engine, type and drag; the wire
 * between the boards can be cut and healed. Nothing here is faked: every change is a CRDT op
 * travelling over a lossy network, and the fingerprints are real state hashes.
 *
 * Visitors can draw on either board at any time, which stops the script and hands them the
 * controls.
 */
import type { Doc, Op } from "../crdt/doc.js";
import { BRUSH_SIZE, encodeStroke, type Brush, type Pt } from "../draw/stroke.js";
import { SimNetwork } from "../lab/network.js";
import { newItemId, rng } from "../lab/random.js";
import { icon } from "./icons.js";
import { el, renderFingerprint } from "./ui.js";
import { BoardView } from "./view.js";

export const WORLD = { w: 600, h: 390 };

export interface Person {
  name: string;
  device: string;
  color: string;
}

interface Replica {
  doc: Doc;
  view: BoardView;
  frame: HTMLElement;
  board: HTMLElement;
  world: HTMLElement;
  cursor: HTMLElement;
  cur: { x: number; y: number };
  fpSw: HTMLElement;
  fpTx: HTMLElement;
  scale: number;
}

export class Aborted extends Error {}

export class DemoBoards {
  readonly net: SimNetwork;
  readonly reps: Replica[] = [];
  readonly root: HTMLElement;
  private wire: HTMLElement;
  private wireSvg: SVGSVGElement;
  private packets: SVGGElement;
  private caption: HTMLElement;
  private toggle: HTMLButtonElement;
  private clock = 0;
  private visible = false;
  private last = 0;
  private runId = 0;
  private waiters: { at: number; resolve: () => void; reject: (e: Error) => void; run: number }[] = [];
  /** Set once a visitor takes over. */
  manual = false;
  onManual?: () => void;

  constructor(
    host: HTMLElement,
    readonly people: Person[],
    opts: { latency?: [number, number]; drop?: number; compact?: boolean } = {},
  ) {
    this.net = new SimNetwork(2, rng(7), { minLatency: opts.latency?.[0] ?? 90, maxLatency: opts.latency?.[1] ?? 380, drop: opts.drop ?? 0.06, duplicate: 0.08 });
    this.root = el("div", `demo${opts.compact ? " compact" : ""}`);
    const boards = el("div", "demo-boards");
    this.wire = el("div", "wire");
    this.wireSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.wireSvg.setAttribute("viewBox", "0 0 100 100");
    this.wireSvg.setAttribute("preserveAspectRatio", "none");
    this.wireSvg.setAttribute("aria-hidden", "true");
    this.wireSvg.innerHTML = `<g class="h"><path class="wire-a" d="M0 50H44"/><path class="wire-b" d="M56 50H100"/><path class="wire-mid" d="M44 50H56"/></g><g class="v"><path class="wire-a" d="M50 0V44"/><path class="wire-b" d="M50 56V100"/><path class="wire-mid" d="M50 44V56"/></g>`;
    this.packets = document.createElementNS("http://www.w3.org/2000/svg", "g");
    this.wireSvg.append(this.packets);
    this.toggle = el("button", "wire-btn");
    this.toggle.type = "button";
    this.toggle.addEventListener("click", () => {
      this.takeOver();
      if (this.net.partitioned) this.heal();
      else this.cut();
    });
    this.wire.append(this.wireSvg, this.toggle);

    people.forEach((p, i) => {
      const frame = el("figure", "replica");
      const cap = el("figcaption", "replica-cap");
      const who = el("span", "who");
      const dot = el("i");
      dot.style.background = p.color;
      who.append(dot, el("b", undefined, p.name), el("span", undefined, p.device));
      const fp = el("span", "fingerprint");
      const fpSw = el("span", "swatches");
      const fpTx = el("span", "data");
      fp.append(fpSw, fpTx);
      fp.title = "State fingerprint: equal codes mean identical boards";
      cap.append(who, fp);
      const board = el("div", "replica-board");
      board.setAttribute("aria-label", `${p.name}'s copy of the board. Draw on it.`);
      const worldEl = el("div", "world");
      const cursor = el("div", "cursor");
      cursor.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4.5 2.5 19 10.6l-6.6 1.7-3.3 6.3z" fill="${p.color}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
      const tag = el("span", undefined, p.name);
      tag.style.background = p.color;
      cursor.append(tag);
      board.append(worldEl, cursor);
      frame.append(cap, board);
      const doc = this.net.replicas[i];
      const view = new BoardView(worldEl, doc, { animateRemote: true });
      const rep: Replica = { doc, view, frame, board, world: worldEl, cursor, cur: { x: WORLD.w / 2, y: WORLD.h + 40 }, fpSw, fpTx, scale: 1 };
      this.reps.push(rep);
      this.bindDrawing(i, rep);
      boards.append(frame);
      if (i === 0) boards.append(this.wire);
    });
    this.caption = el("p", "demo-caption");
    this.caption.setAttribute("aria-live", "polite");
    this.root.append(boards, this.caption);
    host.append(this.root);

    new ResizeObserver(() => this.layout()).observe(boards);
    new IntersectionObserver((es) => (this.visible = es.some((e) => e.isIntersecting)), { rootMargin: "80px" }).observe(this.root);
    this.renderWire();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------------ layout and loop

  private layout(): void {
    for (const r of this.reps) {
      const w = r.board.clientWidth;
      r.scale = w / WORLD.w;
      r.world.style.transform = `scale(${r.scale})`;
      this.placeCursor(r);
    }
  }

  private frame(t: number): void {
    const dt = Math.min(64, t - (this.last || t));
    this.last = t;
    if (this.visible && !document.hidden) {
      this.clock += dt;
      if (this.net.tick(dt) || this.net.inFlight) this.renderState();
      this.renderPackets();
      const due = this.waiters.filter((w) => w.at <= this.clock);
      this.waiters = this.waiters.filter((w) => w.at > this.clock);
      for (const w of due) w.resolve();
    }
    requestAnimationFrame((x) => this.frame(x));
  }

  renderState(): void {
    for (const r of this.reps) renderFingerprint(r.fpSw, r.fpTx, r.doc.hash());
    const same = this.reps.every((r) => r.doc.hash() === this.reps[0].doc.hash());
    this.root.classList.toggle("agree", same && !this.net.inFlight && !this.net.partitioned);
  }

  private renderWire(): void {
    const cut = this.net.partitioned;
    this.root.classList.toggle("cut", cut);
    this.toggle.innerHTML = cut ? `${icon("wifiOff")}<span>Reconnect</span>` : `${icon("wifi")}<span>Cut Wi‑Fi</span>`;
    this.toggle.setAttribute("aria-pressed", String(cut));
  }

  private renderPackets(): void {
    const msgs = this.net.messages().slice(0, 40);
    const vertical = this.wire.clientHeight > this.wire.clientWidth;
    while (this.packets.childNodes.length < msgs.length) {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("r", "3.2");
      this.packets.append(c);
    }
    while (this.packets.childNodes.length > msgs.length) this.packets.lastChild!.remove();
    msgs.forEach((m, k) => {
      const c = this.packets.childNodes[k] as SVGCircleElement;
      let t = m.blocked ? Math.min(m.progress, 0.4) : m.progress;
      if (m.from === 1) t = 1 - t;
      c.setAttribute("cx", String(vertical ? 50 : t * 100));
      c.setAttribute("cy", String(vertical ? t * 100 : 50));
      c.setAttribute("class", m.blocked ? "held" : "");
    });
  }

  // ------------------------------------------------------------------ timing

  /** Wait on the demo's own clock, which stops while the demo is off screen. */
  wait(ms: number): Promise<void> {
    const run = this.runId;
    return new Promise((resolve, reject) => {
      if (run !== this.runId) return reject(new Aborted());
      this.waiters.push({ at: this.clock + ms, resolve: () => (run === this.runId ? resolve() : reject(new Aborted())), reject, run });
    });
  }

  /** Stop any running script. */
  abort(): void {
    this.runId++;
    for (const w of this.waiters) w.reject(new Aborted());
    this.waiters = [];
  }

  async play(script: (d: DemoBoards) => Promise<void>, loop = true): Promise<void> {
    this.abort();
    const run = this.runId;
    do {
      try {
        await script(this);
      } catch (e) {
        if (e instanceof Aborted) return;
        throw e;
      }
    } while (loop && run === this.runId && !this.manual);
  }

  say(text: string): void {
    if (this.caption.textContent === text) return;
    this.caption.classList.remove("in");
    void this.caption.offsetWidth;
    this.caption.textContent = text;
    this.caption.classList.add("in");
  }

  // ------------------------------------------------------------------ network

  cut(): void {
    this.net.partition([0]);
    this.renderWire();
    this.renderState();
  }

  heal(): void {
    this.net.heal();
    this.renderWire();
    this.renderState();
  }

  apply(i: number, ops: Op[]): void {
    this.net.broadcast(i, ops);
    this.renderState();
  }

  /** Put both replicas back to the same starting board. */
  reset(build: (doc: Doc) => Op[]): void {
    this.net.heal();
    this.net.drain();
    for (const r of this.reps) for (const id of r.doc.itemIds()) this.net.broadcast(0, r.doc.deleteItem(id));
    this.net.drain();
    const ops = build(this.reps[0].doc);
    this.reps[1].doc.applyRemote(ops);
    this.renderWire();
    this.renderState();
  }

  // ------------------------------------------------------------------ cursors

  private placeCursor(r: Replica): void {
    r.cursor.style.transform = `translate(${r.cur.x * r.scale}px, ${r.cur.y * r.scale}px)`;
  }

  async moveCursor(i: number, x: number, y: number, ms = 600): Promise<void> {
    const r = this.reps[i];
    const from = { ...r.cur };
    const t0 = this.clock;
    for (;;) {
      const k = Math.min(1, (this.clock - t0) / ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      r.cur = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
      this.placeCursor(r);
      if (k >= 1) return;
      await this.wait(16);
    }
  }

  // ------------------------------------------------------------------ actions

  /** Draw a stroke point by point, mirroring the live ink to the other board while connected. */
  async draw(i: number, pts: { x: number; y: number }[], color: string, brush: Brush = "pen", ms = 900): Promise<string> {
    const r = this.reps[i];
    const other = this.reps[1 - i];
    const id = newItemId();
    await this.moveCursor(i, pts[0].x, pts[0].y, 380);
    const drawn: Pt[] = [];
    const t0 = this.clock;
    let n = 0;
    while (n < pts.length) {
      const target = Math.ceil(((this.clock - t0) / ms) * pts.length);
      while (n < Math.min(pts.length, Math.max(n + 1, target))) drawn.push({ ...pts[n++], p: 0.5 });
      r.cur = { x: drawn[drawn.length - 1].x, y: drawn[drawn.length - 1].y };
      this.placeCursor(r);
      r.view.setLive(id, drawn, brush, color);
      if (!this.net.partitioned) other.view.setLive(id, drawn, brush, color);
      if (n < pts.length) await this.wait(16);
    }
    const s = encodeStroke(drawn, BRUSH_SIZE[brush] / 2 + 3);
    this.apply(i, r.doc.createItem(id, { kind: "ink", brush, color, x: s.x, y: s.y, w: s.w, h: s.h, d: s.d, z: 50 + this.clock / 1000 }));
    if (this.net.partitioned) other.view.clearLive(id);
    else setTimeout(() => other.view.clearLive(id), 1200);
    return id;
  }

  async note(i: number, x: number, y: number, color: string, text = "", w = 150, h = 112): Promise<string> {
    await this.moveCursor(i, x + w / 2, y + h / 2, 480);
    const id = newItemId();
    this.apply(i, this.reps[i].doc.createItem(id, { kind: "note", x, y, w, h, color, z: 40 + this.clock / 1000 }));
    if (text) await this.type(i, id, text);
    return id;
  }

  async type(i: number, id: string, text: string, cps = 16): Promise<void> {
    const d = this.reps[i].doc;
    this.apply(i, d.touchItem(id));
    for (const ch of Array.from(text)) {
      this.apply(i, d.editText(id, d.text(id) + ch));
      await this.wait(1000 / cps + (ch === " " ? 40 : 0));
    }
  }

  async drag(i: number, id: string, x: number, y: number, ms = 700): Promise<void> {
    const d = this.reps[i].doc;
    const g = this.reps[i].view.geom(id);
    await this.moveCursor(i, g.x + g.w / 2, g.y + g.h / 2, 420);
    this.apply(i, d.touchItem(id));
    const t0 = this.clock;
    for (;;) {
      const k = Math.min(1, (this.clock - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      const nx = Math.round(g.x + (x - g.x) * e), ny = Math.round(g.y + (y - g.y) * e);
      this.apply(i, d.setProps(id, { x: nx, y: ny }));
      this.reps[i].cur = { x: nx + g.w / 2, y: ny + g.h / 2 };
      this.placeCursor(this.reps[i]);
      if (k >= 1) return;
      await this.wait(60);
    }
  }

  async remove(i: number, id: string): Promise<void> {
    const g = this.reps[i].view.geom(id);
    await this.moveCursor(i, g.x + g.w - 12, g.y + 12, 420);
    await this.wait(200);
    this.apply(i, this.reps[i].doc.deleteItem(id));
  }

  async settle(): Promise<void> {
    while (this.net.inFlight) await this.wait(120);
    this.renderState();
  }

  get converged(): boolean {
    return this.reps.every((r) => r.doc.hash() === this.reps[0].doc.hash());
  }

  // ------------------------------------------------------------------ visitors drawing

  takeOver(): void {
    if (this.manual) return;
    this.manual = true;
    this.abort();
    this.root.classList.add("manual");
    this.say("Your turn. Draw on either board, cut the Wi‑Fi, draw some more, reconnect.");
    this.onManual?.();
  }

  private bindDrawing(i: number, r: Replica): void {
    let pts: Pt[] | null = null;
    let id = "";
    const local = (e: PointerEvent) => {
      const b = r.board.getBoundingClientRect();
      return { x: (e.clientX - b.left) / r.scale, y: (e.clientY - b.top) / r.scale };
    };
    r.board.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.takeOver();
      r.board.setPointerCapture(e.pointerId);
      pts = [{ ...local(e), p: 0.5 }];
      id = newItemId();
      e.preventDefault();
    });
    r.board.addEventListener("pointermove", (e) => {
      const p = local(e);
      r.cur = p;
      this.placeCursor(r);
      if (!pts) return;
      const last = pts[pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 1.5) return;
      pts.push({ ...p, p: 0.5 });
      r.view.setLive(id, pts, "pen", "ink");
      if (!this.net.partitioned) this.reps[1 - i].view.setLive(id, pts, "pen", "ink");
    });
    const end = () => {
      if (!pts) return;
      const s = encodeStroke(pts, BRUSH_SIZE.pen / 2 + 3);
      this.apply(i, r.doc.createItem(id, { kind: "ink", brush: "pen", color: i === 0 ? "red" : "blue", x: s.x, y: s.y, w: s.w, h: s.h, d: s.d, z: 100 + this.clock / 1000 }));
      const other = this.reps[1 - i];
      const sid = id;
      if (this.net.partitioned) other.view.clearLive(sid);
      else setTimeout(() => other.view.clearLive(sid), 1200);
      pts = null;
    };
    r.board.addEventListener("pointerup", end);
    r.board.addEventListener("pointercancel", end);
  }
}

// ------------------------------------------------------------------ shapes, drawn like a hand would

/** Small deterministic wobble so strokes look drawn, not computed. */
function wobble(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647 - 0.5) * 2;
  };
}

export function loopAround(cx: number, cy: number, rx: number, ry: number, seed = 3): { x: number; y: number }[] {
  const w = wobble(seed);
  const pts = [];
  const turns = 1.12;
  for (let i = 0; i <= 64; i++) {
    const a = -Math.PI * 0.62 + (i / 64) * Math.PI * 2 * turns;
    const k = 1 + w() * 0.025 + (i / 64) * 0.06;
    pts.push({ x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k });
  }
  return pts;
}

export function underline(x: number, y: number, len: number, seed = 5): { x: number; y: number }[] {
  const w = wobble(seed);
  return Array.from({ length: 24 }, (_, i) => ({ x: x + (i / 23) * len, y: y + Math.sin(i / 4) * 1.6 + w() * 0.8 - (i / 23) * 3 }));
}

export function star(cx: number, cy: number, r: number): { x: number; y: number }[] {
  const pts = [];
  for (let i = 0; i <= 5; i++) {
    const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  // densify so the pen has something to follow
  const out: { x: number; y: number }[] = [];
  for (let i = 1; i < pts.length; i++) for (let k = 0; k < 8; k++) out.push({ x: pts[i - 1].x + ((pts[i].x - pts[i - 1].x) * k) / 8, y: pts[i - 1].y + ((pts[i].y - pts[i - 1].y) * k) / 8 });
  out.push(pts[pts.length - 1]);
  return out;
}

export function check(x: number, y: number, s: number): { x: number; y: number }[] {
  const a = { x, y }, b = { x: x + s * 0.35, y: y + s * 0.4 }, c = { x: x + s, y: y - s * 0.55 };
  const out = [];
  for (let k = 0; k <= 8; k++) out.push({ x: a.x + ((b.x - a.x) * k) / 8, y: a.y + ((b.y - a.y) * k) / 8 });
  for (let k = 1; k <= 14; k++) out.push({ x: b.x + ((c.x - b.x) * k) / 14, y: b.y + ((c.y - b.y) * k) / 14 + Math.sin(k / 3) * 0.8 });
  return out;
}

export function arrowLine(a: { x: number; y: number }, b: { x: number; y: number }, bow = 18): { x: number; y: number }[] {
  const out = [];
  const nx = -(b.y - a.y), ny = b.x - a.x;
  const L = Math.hypot(nx, ny) || 1;
  for (let i = 0; i <= 30; i++) {
    const t = i / 30;
    const k = Math.sin(t * Math.PI) * bow;
    out.push({ x: a.x + (b.x - a.x) * t + (nx / L) * k, y: a.y + (b.y - a.y) * t + (ny / L) * k });
  }
  // the head, drawn as one continuous flick like a person would
  const ang = Math.atan2(b.y - out[28].y, b.x - out[28].x);
  const h = 16;
  out.push({ x: b.x - h * Math.cos(ang - 0.55), y: b.y - h * Math.sin(ang - 0.55) });
  out.push(b);
  out.push({ x: b.x - h * Math.cos(ang + 0.55), y: b.y - h * Math.sin(ang + 0.55) });
  return out;
}

export function heart(cx: number, cy: number, s: number): { x: number; y: number }[] {
  const out = [];
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * Math.PI * 2;
    out.push({ x: cx + s * 16 * Math.pow(Math.sin(t), 3), y: cy - s * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) });
  }
  return out;
}
