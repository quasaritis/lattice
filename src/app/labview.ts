/**
 * The split-brain lab: several replicas of one board in a single page, joined by a
 * simulated network you can cut, slow down and make lossy. Type into any replica, then
 * reconnect and watch every copy land on the same text and the same fingerprint.
 */
import { SimNetwork, type NetworkOptions } from "../lab/network.js";
import { COLORS, int, newItemId, pick, rng } from "../lab/random.js";
import { INKS, cpToUtf16, el, renderFingerprint, utf16ToCp } from "./ui.js";

export interface LabOptions {
  labels: string[];
  network?: Partial<NetworkOptions>;
  startText?: string;
  /** Show per-link controls, sliders and counters (the full lab page). */
  full?: boolean;
  /** Play a scripted demo until the visitor touches something. */
  autoplay?: boolean;
}

const NOTE = "shared";
const SVG_NS = "http://www.w3.org/2000/svg";

interface Pane {
  root: HTMLElement;
  ta: HTMLTextAreaElement;
  board: HTMLElement;
  chips: Map<string, HTMLElement>;
  fpSw: HTMLElement;
  fpTx: HTMLElement;
  meta: HTMLElement;
  anchor: string;
  focus: string;
}

export class LabView {
  readonly net: SimNetwork;
  private panes: Pane[] = [];
  private svg!: SVGSVGElement;
  private packets!: SVGGElement;
  private edges: { a: number; b: number; line: SVGLineElement; hit: SVGLineElement }[] = [];
  private nodePos: { x: number; y: number }[] = [];
  private verdict!: HTMLElement;
  private cutBtn!: HTMLButtonElement;
  private statsBox: HTMLElement | null = null;
  private last = performance.now();
  private running = true;
  private auto: AutoPlay | null = null;
  private visible = true;

  constructor(
    private root: HTMLElement,
    private opts: LabOptions,
  ) {
    const n = opts.labels.length;
    this.net = new SimNetwork(n, rng(Date.now() % 100000), {
      minLatency: 120,
      maxLatency: 700,
      drop: 0.1,
      duplicate: 0.1,
      ...opts.network,
    });
    // everyone starts from the same board
    const a = this.net.replicas[0];
    const seed = [
      ...a.createItem(NOTE, { kind: "note", x: 60, y: 40, w: 240, h: 160, color: "sun", z: 1 }, opts.startText ?? "Hackathon plan: meet at 6"),
      ...a.createItem("chip1", { kind: "rect", x: 520, y: 120, w: 160, h: 110, color: "sky", z: 2 }),
      ...a.createItem("chip2", { kind: "ellipse", x: 700, y: 330, w: 150, h: 110, color: "rose", z: 3 }),
    ];
    for (const d of this.net.replicas.slice(1)) d.applyRemote(seed);
    this.build();
    for (let i = 0; i < n; i++) this.renderPane(i, true);
    this.renderNetwork();
    if (opts.autoplay) this.auto = new AutoPlay(this);
    new IntersectionObserver((es) => (this.visible = es.some((e) => e.isIntersecting))).observe(root);
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------------ actions

  cutAll(): void {
    const n = this.net.replicas.length;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) this.net.setLink(a, b, false);
    this.renderNetwork();
  }

  heal(): void {
    this.net.heal();
    this.renderNetwork();
  }

  /** Random concurrent edits to the shapes (the shared note's text is left for people to type in). */
  chaos(count = 30): void {
    const r = this.net.r;
    for (let k = 0; k < count; k++) {
      const i = Math.floor(r() * this.net.replicas.length);
      const d = this.net.replicas[i];
      const shapes = d.itemIds().filter((x) => x !== NOTE);
      const roll = r();
      let ops;
      if (!shapes.length || roll < 0.25) ops = d.createItem(newItemId(r), { kind: pick(r, ["rect", "ellipse", "note"]), x: int(r, 0, 920), y: int(r, 0, 520), color: pick(r, COLORS) });
      else if (roll < 0.65) ops = d.setProps(pick(r, shapes), { x: int(r, 0, 920), y: int(r, 0, 520) });
      else if (roll < 0.85) ops = d.setProps(pick(r, shapes), { color: pick(r, COLORS) });
      else ops = d.deleteItem(pick(r, shapes));
      this.net.broadcast(i, ops);
    }
    this.renderAll();
  }

  /** Type text into replica i's note as if a person did it (used by the autoplay). */
  typeInto(i: number, text: string, at: "end" | number = "end"): void {
    const d = this.net.replicas[i];
    const cur = d.text(NOTE);
    const pos = at === "end" ? Array.from(cur).length : at;
    const chars = Array.from(cur);
    chars.splice(pos, 0, ...Array.from(text));
    this.net.broadcast(i, d.editText(NOTE, chars.join("")));
    this.renderPane(i);
  }

  text(i: number): string {
    return this.net.replicas[i].text(NOTE);
  }

  stopAutoplay(): void {
    if (this.auto) {
      this.auto.stop();
      this.auto = null;
      this.root.classList.remove("autoplaying");
    }
  }

  // ------------------------------------------------------------------ DOM

  private build(): void {
    const { labels, full } = this.opts;
    this.root.classList.add("lab", `lab-${labels.length}`);
    if (full) this.root.classList.add("lab-full");
    if (this.opts.autoplay) this.root.classList.add("autoplaying");

    // network diagram
    const netBox = el("div", "lab-net");
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("viewBox", "0 0 300 120");
    this.svg.setAttribute("role", "img");
    this.svg.setAttribute("aria-label", "Network between replicas");
    const n = labels.length;
    this.nodePos =
      n === 2
        ? [{ x: 40, y: 60 }, { x: 260, y: 60 }]
        : n === 3
          ? [{ x: 50, y: 96 }, { x: 150, y: 24 }, { x: 250, y: 96 }]
          : labels.map((_, i) => ({ x: 150 + 110 * Math.cos((i * 2 * Math.PI) / n - Math.PI / 2), y: 60 + 45 * Math.sin((i * 2 * Math.PI) / n - Math.PI / 2) }));
    const gEdges = document.createElementNS(SVG_NS, "g");
    this.packets = document.createElementNS(SVG_NS, "g");
    const gNodes = document.createElementNS(SVG_NS, "g");
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++) {
        const line = document.createElementNS(SVG_NS, "line");
        const hit = document.createElementNS(SVG_NS, "line");
        for (const l of [line, hit]) {
          l.setAttribute("x1", String(this.nodePos[a].x));
          l.setAttribute("y1", String(this.nodePos[a].y));
          l.setAttribute("x2", String(this.nodePos[b].x));
          l.setAttribute("y2", String(this.nodePos[b].y));
        }
        line.setAttribute("class", "edge");
        hit.setAttribute("class", "edge-hit");
        hit.setAttribute("tabindex", "0");
        hit.setAttribute("role", "button");
        hit.addEventListener("click", () => this.toggleLink(a, b));
        hit.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), this.toggleLink(a, b)));
        gEdges.append(line, hit);
        this.edges.push({ a, b, line, hit });
      }
    labels.forEach((label, i) => {
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("transform", `translate(${this.nodePos[i].x} ${this.nodePos[i].y})`);
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("r", "15");
      c.setAttribute("class", "node");
      const t = document.createElementNS(SVG_NS, "text");
      t.textContent = this.net.replicas[i].replica;
      t.setAttribute("class", "node-label");
      t.setAttribute("dy", "0.36em");
      g.append(c, t);
      gNodes.append(g);
      void label;
    });
    this.svg.append(gEdges, this.packets, gNodes);
    netBox.append(this.svg);

    // controls
    const controls = el("div", "lab-controls");
    this.cutBtn = el("button", "btn small", "Cut the network");
    this.cutBtn.type = "button";
    this.cutBtn.addEventListener("click", () => {
      this.stopAutoplay();
      if (this.net.partitioned) this.heal();
      else this.cutAll();
    });
    const chaosBtn = el("button", "btn small quiet", "Throw 30 random edits at the shapes");
    chaosBtn.type = "button";
    chaosBtn.addEventListener("click", () => {
      this.stopAutoplay();
      this.chaos(30);
    });
    controls.append(this.cutBtn, chaosBtn);
    this.verdict = el("p", "lab-verdict");
    this.verdict.setAttribute("role", "status");
    netBox.append(controls, this.verdict);

    // replica panes
    const panes = el("div", "lab-panes");
    labels.forEach((label, i) => {
      const pane = el("section", "lab-pane");
      pane.setAttribute("aria-label", `Replica ${label}`);
      const head = el("header", "lab-pane-head");
      const name = el("span", "lab-pane-name");
      name.append(el("b", "lab-tag", this.net.replicas[i].replica), document.createTextNode(label));
      const fp = el("span", "fingerprint");
      const fpSw = el("span", "swatches");
      const fpTx = el("span", "data");
      fp.append(fpSw, fpTx);
      head.append(name, fp);
      const board = el("div", "lab-board grain");
      const ta = el("textarea", "lab-text");
      ta.rows = 3;
      ta.maxLength = 400;
      ta.setAttribute("aria-label", `Shared note, as seen by ${label}`);
      ta.spellcheck = false;
      const p: Pane = { root: pane, ta, board, chips: new Map(), fpSw, fpTx, meta: el("p", "lab-meta data"), anchor: "", focus: "" };
      const track = () => {
        const rga = this.net.replicas[i].rga(NOTE);
        p.anchor = rga.idBefore(utf16ToCp(ta.value, ta.selectionStart));
        p.focus = rga.idBefore(utf16ToCp(ta.value, ta.selectionEnd));
      };
      ta.addEventListener("input", () => {
        this.stopAutoplay();
        this.net.broadcast(i, this.net.replicas[i].editText(NOTE, ta.value));
        track();
        this.renderPane(i);
      });
      for (const ev of ["keyup", "mouseup", "select", "focus"]) ta.addEventListener(ev, track);
      ta.addEventListener("pointerdown", () => this.stopAutoplay());
      pane.append(head, ta, board, p.meta);
      panes.append(pane);
      this.panes.push(p);
    });

    this.root.append(panes, netBox);

    if (this.opts.full) this.buildFullControls(netBox);
  }

  private buildFullControls(netBox: HTMLElement): void {
    const box = el("div", "lab-sliders");
    const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
      const wrap = el("label", "lab-slider");
      const top = el("span", "lab-slider-top");
      const val = el("span", "data", fmt(get()));
      top.append(document.createTextNode(label), val);
      const input = el("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(get());
      input.addEventListener("input", () => {
        set(Number(input.value));
        val.textContent = fmt(Number(input.value));
      });
      wrap.append(top, input);
      return wrap;
    };
    const o = this.net.opts;
    box.append(
      slider("Latency", 20, 3000, 10, () => o.maxLatency, (v) => ((o.maxLatency = v), (o.minLatency = Math.min(o.minLatency, v / 4))), (v) => `up to ${v} ms`),
      slider("Lost messages", 0, 0.8, 0.05, () => o.drop, (v) => (o.drop = v), (v) => `${Math.round(v * 100)}%`),
      slider("Duplicated", 0, 0.8, 0.05, () => o.duplicate, (v) => (o.duplicate = v), (v) => `${Math.round(v * 100)}%`),
    );
    const isolate = el("div", "lab-isolate");
    this.net.replicas.forEach((d, i) => {
      const b = el("button", "btn small quiet", `Isolate ${d.replica}`);
      b.type = "button";
      b.addEventListener("click", () => {
        this.net.heal();
        this.net.isolate(i);
        this.renderNetwork();
      });
      isolate.append(b);
    });
    this.statsBox = el("dl", "lab-stats");
    netBox.append(box, isolate, this.statsBox);
  }

  private toggleLink(a: number, b: number): void {
    this.stopAutoplay();
    this.net.setLink(a, b, this.net.isCut(a, b));
    this.renderNetwork();
  }

  // ------------------------------------------------------------------ rendering

  private renderAll(): void {
    for (let i = 0; i < this.panes.length; i++) this.renderPane(i);
  }

  private renderPane(i: number, first = false): void {
    const p = this.panes[i];
    const d = this.net.replicas[i];
    const text = d.text(NOTE);
    if (p.ta.value !== text) {
      const focused = document.activeElement === p.ta;
      p.ta.value = text;
      if (focused) {
        const rga = d.rga(NOTE);
        const a = cpToUtf16(text, rga.indexAfter(p.anchor));
        const f = cpToUtf16(text, rga.indexAfter(p.focus));
        p.ta.setSelectionRange(Math.min(a, f), Math.max(a, f));
      }
    }
    // mini board: every item except the shared note, scaled into the pane
    const ids = new Set(d.itemIds().filter((x) => x !== NOTE));
    for (const [id, chip] of p.chips) if (!ids.has(id)) (chip.remove(), p.chips.delete(id));
    for (const id of ids) {
      let chip = p.chips.get(id);
      if (!chip) {
        chip = el("i", "lab-chip");
        if (!first) chip.classList.add("arrive");
        p.board.append(chip);
        p.chips.set(id, chip);
      }
      const x = Number(d.prop(id, "x") ?? 0), y = Number(d.prop(id, "y") ?? 0);
      const kind = String(d.prop(id, "kind") ?? "note");
      chip.className = `lab-chip ${kind}${chip.classList.contains("arrive") ? " arrive" : ""}`;
      chip.style.left = `${Math.max(0, Math.min(92, (x / 1000) * 100))}%`;
      chip.style.top = `${Math.max(0, Math.min(80, (y / 600) * 100))}%`;
      chip.style.background = (INKS[String(d.prop(id, "color") ?? "sun")] ?? INKS.sun).fill;
      chip.title = d.text(id) || kind;
    }
    renderFingerprint(p.fpSw, p.fpTx, d.hash());
    p.meta.textContent = `${d.appliedCount} ops applied${d.pendingCount ? ` · ${d.pendingCount} waiting for earlier ops` : ""}`;
  }

  private renderNetwork(): void {
    for (const e of this.edges) {
      const cut = this.net.isCut(e.a, e.b);
      e.line.classList.toggle("cut", cut);
      const A = this.net.replicas[e.a].replica, B = this.net.replicas[e.b].replica;
      e.hit.setAttribute("aria-label", `${cut ? "Reconnect" : "Cut"} link ${A}–${B}`);
      e.hit.setAttribute("aria-pressed", String(cut));
    }
    this.cutBtn.textContent = this.net.partitioned ? "Reconnect everyone" : "Cut the network";
    this.cutBtn.classList.toggle("primary", this.net.partitioned);
    this.root.classList.toggle("is-cut", this.net.partitioned);
  }

  private renderPackets(): void {
    const msgs = this.net.messages().slice(0, 80);
    while (this.packets.childNodes.length < msgs.length) {
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("r", "3.4");
      this.packets.append(c);
    }
    while (this.packets.childNodes.length > msgs.length) this.packets.lastChild!.remove();
    msgs.forEach((m, k) => {
      const c = this.packets.childNodes[k] as SVGCircleElement;
      const a = this.nodePos[m.from], b = this.nodePos[m.to];
      // blocked packets wait at the break in the middle of the wire
      const t = m.blocked ? Math.min(m.progress, 0.42) : m.progress;
      c.setAttribute("cx", String(a.x + (b.x - a.x) * t));
      c.setAttribute("cy", String(a.y + (b.y - a.y) * t));
      c.setAttribute("class", m.blocked ? "packet held" : "packet");
    });
  }

  private renderVerdict(): void {
    const net = this.net;
    const hashes = net.hashes();
    const same = hashes.every((h) => h === hashes[0]);
    let text: string;
    let state: string;
    if (same && !net.inFlight) {
      text = `All ${hashes.length} copies are identical.`;
      state = "same";
    } else if (net.partitioned) {
      text = "Network cut. Each copy is changing on its own. Reconnect to merge.";
      state = "cut";
    } else {
      text = `Merging… ${net.inFlight} message${net.inFlight === 1 ? "" : "s"} still on the wire.`;
      state = "merging";
    }
    if (this.verdict.textContent !== text) this.verdict.textContent = text;
    this.verdict.dataset.state = state;
    for (const p of this.panes) p.root.classList.toggle("agree", same && !net.inFlight);
    if (this.statsBox) {
      const s = net.stats;
      const rows: [string, string | number][] = [
        ["Messages sent", s.sent],
        ["Delivered", s.delivered],
        ["Lost, then resent", s.dropped],
        ["Duplicated", s.duplicated],
        ["Held by a cut", s.held],
      ];
      this.statsBox.replaceChildren(...rows.flatMap(([k, v]) => [el("dt", undefined, k), el("dd", "data", String(v))]));
    }
  }

  private frame(t: number): void {
    if (!this.running) return;
    const dt = Math.min(100, t - this.last);
    this.last = t;
    if (this.visible) {
      if (this.net.tick(dt)) this.renderAll();
      else if (this.net.inFlight) for (let i = 0; i < this.panes.length; i++) renderFingerprint(this.panes[i].fpSw, this.panes[i].fpTx, this.net.replicas[i].hash());
      this.renderPackets();
      this.renderVerdict();
      this.auto?.step(dt);
    }
    requestAnimationFrame((x) => this.frame(x));
  }
}

/** A short scripted story that loops until the visitor takes over. */
class AutoPlay {
  private t = 0;
  private i = 0;
  private stopped = false;
  private readonly script: { at: number; run: (lab: LabView) => void }[];

  constructor(private lab: LabView) {
    const typeSlowly = (replica: number, text: string, start: number, every = 75) =>
      Array.from(text).map((ch, k) => ({ at: start + k * every, run: (l: LabView) => l.typeInto(replica, ch) }));
    this.script = [
      { at: 900, run: (l) => l.cutAll() },
      ...typeSlowly(0, ", bring chargers", 1500),
      ...typeSlowly(1, " at the library", 1900, 90),
      { at: 5200, run: (l) => l.heal() },
      { at: 10500, run: (l) => this.reset(l) },
    ];
  }

  private reset(l: LabView): void {
    // rewind the note to its opening line so the story can play again
    const d = l.net.replicas[0];
    l.net.broadcast(0, d.editText("shared", "Hackathon plan: meet at 6"));
    this.t = 0;
    this.i = 0;
  }

  step(dt: number): void {
    if (this.stopped || document.hidden) return;
    this.t += dt;
    while (this.i < this.script.length && this.script[this.i].at <= this.t) this.script[this.i++].run(this.lab);
  }

  stop(): void {
    this.stopped = true;
  }
}
