/** The board page: tools, input, undo, images, presence. Rendering lives in view.ts. */
import type { Op } from "../crdt/doc.js";
import type { Json } from "../crdt/lww.js";
import { BRUSH_SIZE, decodeStroke, distanceToPolyline, encodeStroke, type Brush, type Pt } from "../draw/stroke.js";
import { newItemId } from "../lab/random.js";
import { api, ApiError } from "../sync/api.js";
import { currentUser, onAuthChange } from "../sync/auth.js";
import { MAX_VIDEO_BYTES } from "../sync/config.js";
import type { PresenceMeta } from "../sync/realtime.js";
import { BoardSession, type Cursor, type LiveInk, type SyncStats, type SyncStatus } from "../sync/session.js";
import { mountAccount } from "./account.js";
import { icon, type IconName } from "./icons.js";
import { HL_COLORS, INK, PAPER, PAPER_KEYS, PEN_COLORS, inkHex } from "./palette.js";
import { boardPreview } from "./preview.js";
import { rememberBoard } from "./recent.js";
import { cpToUtf16, el, identity, initials, renderFingerprint, toast, utf16ToCp } from "./ui.js";
import { BoardView, num, type Geom } from "./view.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const boardId = (location.pathname.match(/\/b\/([^/]+)/)?.[1] ?? new URLSearchParams(location.search).get("b") ?? "").toLowerCase();

const who = identity();
const user = currentUser();
const meta: PresenceMeta = { replica: who.replica, name: user?.name ?? who.name, color: who.color };

const canvas = $("canvas");
const world = $("world");
const cursorsLayer = $("cursors");

let peers: PresenceMeta[] = [];
const session = new BoardSession(boardId, meta, {
  status: renderStatus,
  peers: (p) => {
    peers = p;
    renderPeers();
  },
  cursor: onRemoteCursor,
  stats: renderStats,
  liveInk: onRemoteInk,
});
const doc = session.doc;
const view = new BoardView(world, doc, { animateRemote: true });

// ================================================================== tools

type Tool = "select" | "hand" | "pen" | "hl" | "arrow" | "eraser" | "note" | "text" | "rect" | "ellipse" | "image" | "video";
const TOOLS: { id: Tool; icon: IconName; label: string; key: string; group: number }[] = [
  { id: "select", icon: "select", label: "Select", key: "V", group: 0 },
  { id: "hand", icon: "hand", label: "Pan", key: "H", group: 0 },
  { id: "pen", icon: "pen", label: "Pen", key: "P", group: 1 },
  { id: "hl", icon: "highlighter", label: "Highlighter", key: "M", group: 1 },
  { id: "arrow", icon: "arrow", label: "Arrow", key: "A", group: 1 },
  { id: "eraser", icon: "eraser", label: "Eraser", key: "E", group: 1 },
  { id: "note", icon: "note", label: "Sticky note", key: "N", group: 2 },
  { id: "text", icon: "text", label: "Text", key: "T", group: 2 },
  { id: "rect", icon: "rect", label: "Box", key: "R", group: 2 },
  { id: "ellipse", icon: "ellipse", label: "Bubble", key: "O", group: 2 },
  { id: "image", icon: "image", label: "Image", key: "I", group: 2 },
  { id: "video", icon: "video", label: "Video", key: "U", group: 2 },
];

const prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem("lattice:tools") ?? "{}") as Record<string, string>;
  } catch {
    return {} as Record<string, string>;
  }
})();
const style = {
  penColor: PEN_COLORS.includes(prefs.penColor) ? prefs.penColor : "ink",
  penBrush: (prefs.penBrush === "marker" ? "marker" : "pen") as Brush,
  hlColor: HL_COLORS.includes(prefs.hlColor) ? prefs.hlColor : "yellow",
  arrowColor: PEN_COLORS.includes(prefs.arrowColor) ? prefs.arrowColor : "ink",
  textSize: (["S", "M", "L", "XL"].includes(prefs.textSize) ? prefs.textSize : "M") as SizeKey,
};
function savePrefs() {
  try {
    localStorage.setItem("lattice:tools", JSON.stringify(style));
  } catch {
    /* fine */
  }
}

let tool: Tool = "select";
const dock = $("dock");
const pill = $("dockPill");
const toolButtons = new Map<Tool, HTMLButtonElement>();
{
  let lastGroup = 0;
  for (const t of TOOLS) {
    if (t.group !== lastGroup) {
      dock.append(el("span", "sep"));
      lastGroup = t.group;
    }
    const b = el("button", "icon-btn");
    b.type = "button";
    b.dataset.tool = t.id;
    b.setAttribute("aria-label", `${t.label} (${t.key})`);
    b.setAttribute("aria-pressed", "false");
    b.innerHTML = `${icon(t.icon)}<span class="tip">${t.label}<kbd>${t.key}</kbd></span>`;
    if (t.id === "pen" || t.id === "hl" || t.id === "arrow") b.append(el("i", "swatch-dot"));
    b.addEventListener("click", () => (t.id === "image" ? pickImage() : t.id === "video" ? pickVideo() : setTool(t.id)));
    dock.append(b);
    toolButtons.set(t.id, b);
  }
  // once one tooltip has shown, neighbours show instantly
  let warm: ReturnType<typeof setTimeout> | null = null;
  dock.addEventListener("pointerover", () => {
    if (warm) clearTimeout(warm);
    warm = setTimeout(() => dock.classList.add("tips-warm"), 500);
  });
  dock.addEventListener("pointerleave", () => {
    if (warm) clearTimeout(warm);
    setTimeout(() => dock.classList.remove("tips-warm"), 300);
  });
}

function setTool(t: Tool): void {
  if (t === "image") return pickImage();
  if (t === "video") return pickVideo();
  stopEditing();
  if (t !== "select") select(null);
  tool = t;
  for (const [id, b] of toolButtons) b.setAttribute("aria-pressed", String(id === t));
  canvas.className = `canvas tool-${t}`;
  movePill();
  renderOptions();
}

function movePill(): void {
  const b = toolButtons.get(tool);
  if (!b) return;
  pill.style.transform = `translate(${b.offsetLeft}px, ${b.offsetTop}px)`;
  pill.style.width = `${b.offsetWidth}px`;
  pill.style.height = `${b.offsetHeight}px`;
}
window.addEventListener("resize", movePill);

function paintDots(): void {
  const dot = (t: Tool, hex: string) => {
    const i = toolButtons.get(t)?.querySelector<HTMLElement>(".swatch-dot");
    if (i) i.style.background = hex;
  };
  dot("pen", inkHex(style.penColor));
  dot("hl", inkHex(style.hlColor));
  dot("arrow", inkHex(style.arrowColor));
}

// ================================================================== text size

const TEXT_KINDS = new Set(["note", "rect", "ellipse", "text"]);
type SizeKey = "S" | "M" | "L" | "XL";
const SIZE_KEYS: SizeKey[] = ["S", "M", "L", "XL"];
/** Free text is a heading by default; text inside notes and shapes is body copy. */
const SIZES: Record<"text" | "body", Record<SizeKey, number>> = {
  text: { S: 18, M: 26, L: 40, XL: 64 },
  body: { S: 15, M: 20, L: 30, XL: 44 },
};
const sizeScale = (kind: string) => SIZES[kind === "text" ? "text" : "body"];
const fontSize = (id: string) => num(doc.prop(id, "fs"), sizeScale(view.kind(id)).M);
const sizeKeyOf = (id: string): SizeKey | null => SIZE_KEYS.find((k) => sizeScale(view.kind(id))[k] === fontSize(id)) ?? null;

/** Change an item's text size. Free text grows or shrinks its box with it, like resizing a heading. */
function setFontSize(id: string, fs: number): void {
  const kind = view.kind(id);
  const old = fontSize(id);
  if (fs === old) return;
  const fields: Record<string, Json> = { fs };
  if (kind === "text") {
    const g = view.geom(id);
    const k = fs / old;
    fields.w = Math.round(Math.max(60, g.w * k));
    fields.h = Math.round(Math.max(fs * 1.28 + 8, g.h * k));
  }
  setProps(id, fields);
}

function stepFontSize(id: string, dir: 1 | -1): void {
  const scale = sizeScale(view.kind(id));
  const cur = fontSize(id);
  const steps = SIZE_KEYS.map((k) => scale[k]);
  const next = dir > 0 ? steps.find((v) => v > cur) : [...steps].reverse().find((v) => v < cur);
  if (next !== undefined) setFontSize(id, next);
}

function sizeControl(pressed: SizeKey | null, onPick: (k: SizeKey) => void): HTMLElement {
  const wrap = el("div", "sizes");
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Text size");
  const names: Record<SizeKey, string> = { S: "Small", M: "Medium", L: "Large", XL: "Extra large" };
  for (const k of SIZE_KEYS) {
    const b = el("button", "size-btn");
    b.type = "button";
    b.textContent = k;
    b.setAttribute("aria-pressed", String(pressed === k));
    b.setAttribute("aria-label", `${names[k]} text`);
    b.title = `${names[k]} text (Ctrl+Shift+< / >)`;
    b.addEventListener("click", () => onPick(k));
    wrap.append(b);
  }
  return wrap;
}

/** Free text boxes grow to fit what's typed, so nothing is cut off at a big size. */
function fitTextBox(id: string, measure: HTMLElement): void {
  if (view.kind(id) !== "text") return;
  const need = Math.ceil(measure.scrollHeight);
  const g = view.geom(id);
  if (need > g.h + 1) setProps(id, { h: need }, false);
}

// ================================================================== options bar (colours)

const optionsBar = $("options");

function swatch(hex: string, label: string, pressed: boolean, onPick: () => void): HTMLButtonElement {
  const b = el("button", "swatch");
  b.type = "button";
  b.style.setProperty("--c", hex);
  b.setAttribute("aria-label", label);
  b.setAttribute("aria-pressed", String(pressed));
  b.append(el("i"));
  b.addEventListener("click", onPick);
  return b;
}

function renderOptions(): void {
  optionsBar.replaceChildren();
  const add = (...n: Node[]) => optionsBar.append(...n);
  if (tool === "pen" || tool === "hl" || tool === "arrow") {
    const key = tool === "pen" ? "penColor" : tool === "hl" ? "hlColor" : "arrowColor";
    const list = tool === "hl" ? HL_COLORS : PEN_COLORS;
    for (const c of list) add(swatch(INK[c].hex, INK[c].label, style[key] === c, () => ((style[key] = c), savePrefs(), paintDots(), renderOptions())));
    if (tool === "pen") {
      add(el("span", "sep"));
      for (const b of ["pen", "marker"] as Brush[]) {
        const btn = el("button", "icon-btn");
        btn.type = "button";
        btn.setAttribute("aria-pressed", String(style.penBrush === b));
        btn.setAttribute("aria-label", b === "pen" ? "Fine pen" : "Thick marker");
        btn.title = b === "pen" ? "Fine pen" : "Thick marker";
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 15c3-5 6 2 9-3s4-3 5-4" fill="none" stroke="currentColor" stroke-width="${b === "pen" ? 1.75 : 4.5}" stroke-linecap="round"/></svg>`;
        btn.addEventListener("click", () => ((style.penBrush = b), savePrefs(), renderOptions()));
        add(btn);
      }
    }
    optionsBar.hidden = false;
    return;
  }
  if (tool === "text") {
    for (const c of PEN_COLORS) add(swatch(INK[c].hex, INK[c].label, style.penColor === c, () => ((style.penColor = c), savePrefs(), paintDots(), renderOptions())));
    add(el("span", "sep"));
    add(sizeControl(style.textSize, (k) => ((style.textSize = k), savePrefs(), renderOptions())));
    optionsBar.hidden = false;
    return;
  }
  if (tool === "select" && selected && doc.hasItem(selected)) {
    const id = selected;
    const kind = view.kind(id);
    const current = String(doc.prop(id, "color") ?? "");
    if (kind === "note" || kind === "rect" || kind === "ellipse") {
      for (const c of PAPER_KEYS) add(swatch(PAPER[c].hex, PAPER[c].label, (current || "sun") === c, () => setProps(id, { color: c })));
    } else if (kind !== "image" && kind !== "video") {
      const list = (kind === "ink" && doc.prop(id, "brush") === "hl") ? HL_COLORS : PEN_COLORS;
      for (const c of list) add(swatch(INK[c].hex, INK[c].label, (current || "ink") === c, () => setProps(id, { color: c })));
    }
    if (TEXT_KINDS.has(kind)) {
      if (optionsBar.childElementCount) add(el("span", "sep"));
      add(sizeControl(sizeKeyOf(id), (k) => setFontSize(id, sizeScale(kind)[k])));
    }
    if (optionsBar.childElementCount) add(el("span", "sep"));
    if (kind !== "arrow") {
      const turnBtn = el("button", "icon-btn");
      turnBtn.type = "button";
      turnBtn.innerHTML = icon("rotate");
      turnBtn.setAttribute("aria-label", "Rotate 90° (Shift+R)");
      turnBtn.title = "Rotate 90° (Shift+R). Drag the round handle to turn freely";
      turnBtn.addEventListener("click", () => rotateBy(id, 90));
      add(turnBtn);
    }
    const del = el("button", "icon-btn");
    del.type = "button";
    del.innerHTML = icon("trash");
    del.setAttribute("aria-label", "Delete (Del)");
    del.title = "Delete (Del)";
    del.addEventListener("click", () => deleteItems([id]));
    add(del);
    optionsBar.hidden = false;
    return;
  }
  optionsBar.hidden = true;
}

// ================================================================== undo / redo

interface Step {
  undo(): Op[];
  redo(): Op[];
}
const undoStack: Step[] = [];
const redoStack: Step[] = [];

function pushStep(s: Step): void {
  undoStack.push(s);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  renderUndo();
}

function undo(): void {
  stopEditing();
  const s = undoStack.pop();
  if (!s) return;
  session.commit(s.undo());
  redoStack.push(s);
  renderUndo();
  renderOptions();
}

function redo(): void {
  stopEditing();
  const s = redoStack.pop();
  if (!s) return;
  session.commit(s.redo());
  undoStack.push(s);
  renderUndo();
  renderOptions();
}

function renderUndo(): void {
  ($("undoBtn") as HTMLButtonElement).disabled = !undoStack.length;
  ($("redoBtn") as HTMLButtonElement).disabled = !redoStack.length;
}

const createdStep = (ids: string[]): Step => ({
  undo: () => ids.flatMap((id) => doc.deleteItem(id)),
  redo: () => ids.flatMap((id) => doc.restoreItem(id)),
});

function setProps(id: string, fields: Record<string, Json>, record = true): void {
  const before: Record<string, Json> = {};
  for (const k of Object.keys(fields)) before[k] = (doc.prop(id, k) ?? null) as Json;
  session.commit([...(record ? doc.touchItem(id) : []), ...doc.setProps(id, fields)]);
  if (record) pushStep({ undo: () => doc.setProps(id, before), redo: () => doc.setProps(id, fields) });
  renderOptions();
}

function deleteItems(ids: string[]): void {
  const live = ids.filter((id) => doc.hasItem(id));
  if (!live.length) return;
  if (live.includes(selected ?? "")) select(null);
  session.commit(live.flatMap((id) => doc.deleteItem(id)));
  pushStep({ undo: () => live.flatMap((id) => doc.restoreItem(id)), redo: () => live.flatMap((id) => doc.deleteItem(id)) });
}

// ================================================================== camera

const cam = { x: 0, y: 0, z: 1 };

function applyCamera(): void {
  world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
  // the faint ghosting is part of the board, so it moves with it
  canvas.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
  canvas.style.backgroundSize = `${640 * cam.z}px`;
  for (const c of remoteCursors.values()) placeCursor(c);
  $("zoomLabel").textContent = `${Math.round(cam.z * 100)}%`;
}

function toWorld(clientX: number, clientY: number): { x: number; y: number } {
  return { x: (clientX - cam.x) / cam.z, y: (clientY - cam.y) / cam.z };
}

function zoomAt(z: number, px: number, py: number): void {
  z = Math.max(0.1, Math.min(4, z));
  cam.x = px - ((px - cam.x) * z) / cam.z;
  cam.y = py - ((py - cam.y) * z) / cam.z;
  cam.z = z;
  applyCamera();
}

function animateCamera(target: { x: number; y: number; z: number }): void {
  const from = { ...cam };
  const t0 = performance.now();
  const dur = matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 420;
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 4);
    cam.x = from.x + (target.x - from.x) * e;
    cam.y = from.y + (target.y - from.y) * e;
    cam.z = from.z + (target.z - from.z) * e;
    applyCamera();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function fitView(animate = false): void {
  const b = view.bounds();
  const W = innerWidth, H = innerHeight;
  let target: { x: number; y: number; z: number };
  if (!b) target = { x: W / 2, y: H / 2, z: 1 };
  else {
    const padX = Math.min(120, W * 0.08), padY = Math.min(130, H * 0.14);
    const z = Math.max(0.15, Math.min(1.2, (W - padX * 2) / b.w, (H - padY * 2) / b.h));
    target = { x: W / 2 - (b.x + b.w / 2) * z, y: H / 2 - (b.y + b.h / 2) * z, z };
  }
  if (animate) animateCamera(target);
  else {
    Object.assign(cam, target);
    applyCamera();
  }
}

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(cam.z * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    else {
      cam.x -= e.deltaX;
      cam.y -= e.deltaY;
      applyCamera();
    }
  },
  { passive: false },
);

$("zoomIn").innerHTML = icon("plus");
$("zoomOut").innerHTML = icon("minus");
$("zoomIn").addEventListener("click", () => zoomAt(cam.z * 1.25, innerWidth / 2, innerHeight / 2));
$("zoomOut").addEventListener("click", () => zoomAt(cam.z / 1.25, innerWidth / 2, innerHeight / 2));
$("zoomLabel").addEventListener("click", () => fitView(true));

// ================================================================== selection and text editing

let selected: string | null = null;
let editing: { item: string; ta: HTMLTextAreaElement; anchor: string; focus: string; before: string } | null = null;

function select(id: string | null): void {
  if (selected === id) return;
  selected = id;
  view.select(id);
  if (id) bringToFront(id);
  renderOptions();
}

function topZ(): number {
  let z = 0;
  for (const id of doc.itemIds()) z = Math.max(z, num(doc.prop(id, "z"), 0));
  return z + 1;
}

function bringToFront(id: string): void {
  const z = num(doc.prop(id, "z"), 0);
  for (const other of doc.itemIds()) if (other !== id && num(doc.prop(other, "z"), 0) >= z) return void session.commit(doc.setProps(id, { z: topZ() }));
}


function startEditing(id: string): void {
  const node = view.nodes.get(id);
  if (!node || !TEXT_KINDS.has(view.kind(id)) || editing?.item === id) return;
  stopEditing();
  if (tool !== "select") setTool("select");
  select(id);
  const ta = el("textarea");
  ta.value = doc.text(id);
  ta.maxLength = 2000;
  ta.setAttribute("aria-label", "Text");
  node.querySelector(".text")?.replaceWith(ta);
  const state = { item: id, ta, anchor: "", focus: "", before: doc.text(id) };
  editing = state;
  session.commit(doc.touchItem(id)); // someone deleting it meanwhile won't erase this edit
  view.editing = id;
  const track = () => {
    const rga = doc.rga(id);
    state.anchor = rga.idBefore(utf16ToCp(ta.value, ta.selectionStart));
    state.focus = rga.idBefore(utf16ToCp(ta.value, ta.selectionEnd));
  };
  ta.addEventListener("input", () => {
    session.commit(doc.editText(id, ta.value));
    if (ta.value !== doc.text(id)) ta.value = doc.text(id);
    track();
    fitTextBox(id, ta);
  });
  for (const ev of ["keyup", "mouseup", "select", "focus"]) ta.addEventListener(ev, track);
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === ">" || e.key === "." || e.key === "<" || e.key === ",")) {
      e.preventDefault();
      stepFontSize(id, e.key === ">" || e.key === "." ? 1 : -1);
      requestAnimationFrame(() => fitTextBox(id, ta));
      return;
    }
    if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      stopEditing();
      canvas.focus();
    }
  });
  ta.addEventListener("blur", () => setTimeout(() => editing?.ta === ta && stopEditing(), 0));
  ta.addEventListener("pointerdown", (e) => e.stopPropagation());
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  track();
}

view.onTextRender = (id, source) => {
  if (!editing || editing.item !== id || source !== "remote") return;
  // keep the caret glued to the character it was after, while others type around it
  const { ta, anchor, focus } = editing;
  const text = doc.text(id);
  const rga = doc.rga(id);
  ta.value = text;
  const a = cpToUtf16(text, rga.indexAfter(anchor));
  const f = cpToUtf16(text, rga.indexAfter(focus));
  ta.setSelectionRange(Math.min(a, f), Math.max(a, f));
};

function stopEditing(): void {
  if (!editing) return;
  const { item, ta, before } = editing;
  editing = null;
  view.editing = null;
  const t = el("div", "text", doc.text(item));
  ta.replaceWith(t);
  const after = doc.text(item);
  if (after !== before) pushStep({ undo: () => doc.editText(item, before), redo: () => doc.editText(item, after) });
}

// ================================================================== creating things

function createAt(kind: "note" | "text" | "rect" | "ellipse", x: number, y: number): string {
  const id = newItemId();
  const fs = SIZES.text[style.textSize];
  const k = fs / SIZES.text.M;
  const size = kind === "note" ? { w: 220, h: 180 } : kind === "rect" ? { w: 240, h: 140 } : kind === "ellipse" ? { w: 220, h: 160 } : { w: Math.round(280 * k), h: Math.round(fs * 1.28 + 13) };
  const color = kind === "note" ? "sun" : kind === "rect" ? "sky" : kind === "ellipse" ? "rose" : style.penColor;
  const extra = kind === "text" && style.textSize !== "M" ? { fs } : {};
  session.commit(doc.createItem(id, { kind, x: Math.round(x - size.w / 2), y: Math.round(y - size.h / 2), ...size, color, z: topZ(), ...extra }));
  view.nodes.get(id)?.classList.add("arrive");
  pushStep(createdStep([id]));
  return id;
}

// ================================================================== pointer input

type Gesture =
  | { kind: "pan"; sx: number; sy: number; cx: number; cy: number }
  | { kind: "move"; id: string; dx: number; dy: number; start: Geom; x: number; y: number; moved: boolean; last: number; wasSelected: boolean }
  | { kind: "resize"; id: string; c: string; start: Geom; g: Geom; last: number }
  | { kind: "rotate"; id: string; start: number; cx: number; cy: number; r: number; last: number }
  | { kind: "draw"; id: string; brush: Brush; color: string; pts: Pt[]; pressure: boolean; last: number; raf: number }
  | { kind: "arrow"; id: string; a: { x: number; y: number }; b: { x: number; y: number } }
  | { kind: "erase"; erased: string[] }
  | { kind: "pinch"; startDist: number; startZ: number; wx: number; wy: number };

let gesture: Gesture | null = null;
const pointers = new Map<number, { x: number; y: number }>();
let spaceDown = false;

function startPinch(): void {
  const [p1, p2] = [...pointers.values()];
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  cancelGesture();
  const w = toWorld(mx, my);
  gesture = { kind: "pinch", startDist: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1, startZ: cam.z, wx: w.x, wy: w.y };
}

function cancelGesture(): void {
  if (gesture?.kind === "draw") view.clearLive(gesture.id);
  if (gesture?.kind === "arrow") view.clearLive(gesture.id);
  gesture = null;
}

canvas.addEventListener("pointerdown", (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2 && e.pointerType === "touch") return startPinch();
  if (pointers.size > 1) return;
  const target = e.target as HTMLElement;
  if (target.closest("textarea")) return;
  const p = toWorld(e.clientX, e.clientY);
  const itemNode = target.closest<HTMLElement>(".item");
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }

  if (e.button === 1 || tool === "hand" || spaceDown) {
    gesture = { kind: "pan", sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
    canvas.classList.add("panning");
    return;
  }
  if (e.button !== 0) return;

  if (tool === "pen" || tool === "hl") {
    stopEditing();
    const brush: Brush = tool === "hl" ? "hl" : style.penBrush;
    const pressure = e.pointerType === "pen";
    gesture = { kind: "draw", id: newItemId(), brush, color: tool === "hl" ? style.hlColor : style.penColor, pts: [{ ...p, p: pressure ? e.pressure || 0.5 : 0.5 }], pressure, last: 0, raf: 0 };
    view.setLive(gesture.id, gesture.pts, brush, gesture.color);
    e.preventDefault();
    return;
  }
  if (tool === "arrow") {
    stopEditing();
    gesture = { kind: "arrow", id: newItemId(), a: p, b: p };
    e.preventDefault();
    return;
  }
  if (tool === "eraser") {
    stopEditing();
    gesture = { kind: "erase", erased: [] };
    eraseAt(p.x, p.y);
    e.preventDefault();
    return;
  }
  if (tool === "note" || tool === "text" || tool === "rect" || tool === "ellipse") {
    const id = createAt(tool, p.x, p.y);
    e.preventDefault();
    startEditing(id);
    return;
  }

  // select tool
  if (itemNode && itemNode.dataset.id) {
    const id = itemNode.dataset.id;
    if (editing?.item === id) return;
    stopEditing();
    const wasSelected = selected === id;
    select(id);
    const g = view.geom(id);
    if (target.classList.contains("grip")) {
      gesture = { kind: "resize", id, c: target.dataset.c ?? "se", start: g, g: { ...g }, last: 0 };
      session.commit(doc.touchItem(id));
    } else if (target.classList.contains("rot")) {
      gesture = { kind: "rotate", id, start: g.r ?? 0, cx: g.x + g.w / 2, cy: g.y + g.h / 2, r: g.r ?? 0, last: 0 };
      canvas.classList.add("rotating");
      session.commit(doc.touchItem(id));
    } else gesture = { kind: "move", id, dx: p.x - g.x, dy: p.y - g.y, start: g, x: g.x, y: g.y, moved: false, last: 0, wasSelected };
    e.preventDefault();
    return;
  }
  stopEditing();
  select(null);
  gesture = { kind: "pan", sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
  canvas.classList.add("panning");
});

let lastCursorSent = 0;
let lastInkSent = 0;
canvas.addEventListener("pointermove", (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const now = performance.now();
  const p = toWorld(e.clientX, e.clientY);
  if (now - lastCursorSent > 50) {
    lastCursorSent = now;
    session.sendCursor(p.x, p.y);
  }
  if (!gesture) return;
  const g = gesture;
  switch (g.kind) {
    case "pinch": {
      if (pointers.size < 2) return;
      const [p1, p2] = [...pointers.values()];
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const z = Math.max(0.1, Math.min(4, (g.startZ * Math.hypot(p1.x - p2.x, p1.y - p2.y)) / g.startDist));
      cam.z = z;
      cam.x = mx - g.wx * z;
      cam.y = my - g.wy * z;
      applyCamera();
      return;
    }
    case "pan":
      cam.x = g.cx + e.clientX - g.sx;
      cam.y = g.cy + e.clientY - g.sy;
      applyCamera();
      return;
    case "draw": {
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
      for (const ce of events.length ? events : [e]) {
        const q = toWorld(ce.clientX, ce.clientY);
        const last = g.pts[g.pts.length - 1];
        if (Math.hypot(q.x - last.x, q.y - last.y) * cam.z < 1.2) continue;
        g.pts.push({ ...q, p: g.pressure ? ce.pressure || 0.5 : 0.5 });
      }
      if (!g.raf) g.raf = requestAnimationFrame(() => ((g.raf = 0), view.setLive(g.id, g.pts, g.brush, g.color)));
      if (now - lastInkSent > 45) {
        lastInkSent = now;
        session.sendLiveInk({ stroke: g.id, brush: g.brush, color: g.color, pts: g.pts.flatMap((q) => [q.x, q.y, q.p]), done: false });
      }
      return;
    }
    case "arrow":
      g.b = p;
      view.setLiveArrow(g.id, g.a, g.b, style.arrowColor);
      return;
    case "erase":
      eraseAt(p.x, p.y);
      return;
    case "move": {
      const node = view.nodes.get(g.id);
      if (!node) return;
      g.x = Math.round(p.x - g.dx);
      g.y = Math.round(p.y - g.dy);
      if (!g.moved) {
        if (Math.hypot(g.x - g.start.x, g.y - g.start.y) * cam.z < 3) return;
        g.moved = true;
        node.classList.add("dragging");
        session.commit(doc.touchItem(g.id));
      }
      view.place(g.id, node, { ...g.start, x: g.x, y: g.y });
      if (now - g.last > 70) {
        g.last = now;
        session.commit(doc.setProps(g.id, { x: g.x, y: g.y }));
      }
      return;
    }
    case "resize": {
      const node = view.nodes.get(g.id);
      if (!node) return;
      g.g = resized(view.kind(g.id), g.start, g.c, p, e.shiftKey);
      view.place(g.id, node, g.g);
      if (now - g.last > 80) {
        g.last = now;
        session.commit(doc.setProps(g.id, { x: g.g.x, y: g.g.y, w: g.g.w, h: g.g.h }));
      }
      return;
    }
    case "rotate": {
      const node = view.nodes.get(g.id);
      if (!node) return;
      // the handle sits above the item, so straight up is 0°
      let r = (Math.atan2(p.y - g.cy, p.x - g.cx) * 180) / Math.PI + 90;
      if (r > 180) r -= 360;
      if (e.shiftKey) r = Math.round(r / 15) * 15;
      else {
        const snap = Math.round(r / 45) * 45; // settle onto square angles when close
        if (Math.abs(r - snap) < 4) r = snap;
      }
      r = Math.round(r * 10) / 10;
      if (r === -180) r = 180;
      g.r = r;
      view.place(g.id, node, { ...view.geom(g.id), r });
      if (now - g.last > 80) {
        g.last = now;
        session.commit(doc.setProps(g.id, { r }));
      }
      return;
    }
  }
});

function endPointer(e: PointerEvent): void {
  pointers.delete(e.pointerId);
  if (!gesture) return;
  const g = gesture;
  if (g.kind === "pinch") {
    if (pointers.size < 2) gesture = null;
    return;
  }
  gesture = null;
  canvas.classList.remove("panning");
  switch (g.kind) {
    case "draw": {
      if (g.raf) cancelAnimationFrame(g.raf);
      const s = encodeStroke(g.pts, BRUSH_SIZE[g.brush] / 2 + 3);
      session.commit(doc.createItem(g.id, { kind: "ink", brush: g.brush, color: g.color, x: s.x, y: s.y, w: s.w, h: s.h, d: s.d, z: topZ() }));
      session.sendLiveInk({ stroke: g.id, brush: g.brush, color: g.color, pts: [], done: true });
      pushStep(createdStep([g.id]));
      $("empty").hidden = true;
      return;
    }
    case "arrow": {
      if (Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) * cam.z < 10) {
        view.clearLive(g.id);
        return;
      }
      const s = encodeStroke([{ ...g.a, p: 0.5 }, { ...g.b, p: 0.5 }], 20);
      session.commit(doc.createItem(g.id, { kind: "arrow", color: style.arrowColor, x: s.x, y: s.y, w: s.w, h: s.h, d: s.d, z: topZ() }));
      pushStep(createdStep([g.id]));
      return;
    }
    case "erase":
      if (g.erased.length) pushStep({ undo: () => g.erased.flatMap((id) => doc.restoreItem(id)), redo: () => g.erased.flatMap((id) => doc.deleteItem(id)) });
      return;
    case "move": {
      view.nodes.get(g.id)?.classList.remove("dragging");
      if (g.moved) setProps(g.id, { x: g.x, y: g.y }, false), pushStep({ undo: () => doc.setProps(g.id, { x: g.start.x, y: g.start.y }), redo: () => doc.setProps(g.id, { x: g.x, y: g.y }) });
      else if (g.wasSelected && e.type === "pointerup") startEditing(g.id); // second tap edits
      return;
    }
    case "resize": {
      const { x, y, w, h } = g.g;
      const s0 = g.start;
      session.commit(doc.setProps(g.id, { x, y, w, h }));
      pushStep({ undo: () => doc.setProps(g.id, { x: s0.x, y: s0.y, w: s0.w, h: s0.h }), redo: () => doc.setProps(g.id, { x, y, w, h }) });
      return;
    }
    case "rotate": {
      canvas.classList.remove("rotating");
      const { r, start } = g;
      session.commit(doc.setProps(g.id, { r }));
      if (r !== start) pushStep({ undo: () => doc.setProps(g.id, { r: start }), redo: () => doc.setProps(g.id, { r }) });
      return;
    }
  }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", (e) => {
  pointers.delete(e.pointerId);
  cancelGesture();
  canvas.classList.remove("panning");
});

/** A world point in an item's own frame: origin at its top-left corner, before rotation. */
function toLocal(g: Geom, x: number, y: number): { x: number; y: number } {
  const a = (-(g.r ?? 0) * Math.PI) / 180;
  const cx = g.x + g.w / 2, cy = g.y + g.h / 2;
  const dx = x - cx, dy = y - cy;
  return { x: dx * Math.cos(a) - dy * Math.sin(a) + g.w / 2, y: dx * Math.sin(a) + dy * Math.cos(a) + g.h / 2 };
}

/**
 * Resize from a corner of a possibly rotated item: the opposite corner stays put on screen,
 * the dragged corner follows the pointer. Pictures and drawings keep their shape (Shift for all).
 */
function resized(kind: string, s: Geom, corner: string, p: { x: number; y: number }, keepAspect: boolean): Geom {
  const r = s.r ?? 0;
  const a = (r * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const sx = corner.includes("e") ? 1 : -1, sy = corner.includes("s") ? 1 : -1;
  const rot = (x: number, y: number) => ({ x: x * cos - y * sin, y: x * sin + y * cos });
  const c0 = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
  const off = rot((-sx * s.w) / 2, (-sy * s.h) / 2);
  const anchor = { x: c0.x + off.x, y: c0.y + off.y };
  // pointer relative to the fixed corner, in the item's frame
  const dx = p.x - anchor.x, dy = p.y - anchor.y;
  const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
  const minW = kind === "ink" ? 8 : kind === "text" ? 40 : 60, minH = kind === "ink" ? 8 : 30;
  let w = Math.max(minW, lx * sx), h = Math.max(minH, ly * sy);
  if (kind === "image" || kind === "video" || kind === "ink" || keepAspect) {
    const k = Math.max(w / s.w, h / s.h, minW / s.w, minH / s.h);
    w = s.w * k;
    h = s.h * k;
  }
  w = Math.round(w);
  h = Math.round(h);
  const half = rot((sx * w) / 2, (sy * h) / 2);
  const cx = anchor.x + half.x, cy = anchor.y + half.y;
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h, r };
}

/** Turn the selected item a quarter turn. */
function rotateBy(id: string, deg: number): void {
  const r0 = view.geom(id).r ?? 0;
  let r = Math.round(r0 + deg) % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  setProps(id, { r });
}

function eraseAt(x: number, y: number): void {
  if (gesture?.kind !== "erase") return;
  const tol = 10 / cam.z;
  for (const [id, node] of view.nodes) {
    const kind = node.dataset.kind;
    if (kind !== "ink" && kind !== "arrow") continue;
    const g = view.geom(id);
    const l = toLocal(g, x, y); // the eraser works in the stroke's own (unrotated) frame
    if (l.x < -tol || l.y < -tol || l.x > g.w + tol || l.y > g.h + tol) continue;
    const s = decodeStroke(String(doc.prop(id, "d") ?? ""));
    if (!s) continue;
    const sx = s.w / g.w, sy = s.h / g.h;
    const brush = String(doc.prop(id, "brush") ?? "pen") as Brush;
    const reach = (BRUSH_SIZE[brush] ?? 3) / 2 + tol;
    if (distanceToPolyline(s.pts, l.x * sx, l.y * sy) <= reach * Math.max(sx, sy)) {
      gesture.erased.push(id);
      session.commit(doc.deleteItem(id));
    }
  }
}

canvas.addEventListener("dblclick", (e) => {
  const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
  if (hit?.closest("textarea")) return;
  const itemNode = hit?.closest<HTMLElement>(".item");
  if (itemNode?.dataset.id) return startEditing(itemNode.dataset.id);
  if (tool !== "select") return;
  const p = toWorld(e.clientX, e.clientY);
  e.preventDefault();
  startEditing(createAt("note", p.x, p.y));
});

// ================================================================== keyboard

window.addEventListener("keydown", (e) => {
  const inField = (e.target as HTMLElement).closest("input, textarea, [contenteditable]");
  if (inField) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === "z") {
    e.preventDefault();
    return e.shiftKey ? redo() : undo();
  }
  if (mod && k === "y") {
    e.preventDefault();
    return redo();
  }
  if (mod && e.shiftKey && selected && TEXT_KINDS.has(view.kind(selected)) && [">", ".", "<", ","].includes(e.key)) {
    e.preventDefault();
    return stepFontSize(selected, e.key === ">" || e.key === "." ? 1 : -1);
  }
  if (mod || e.altKey) return;
  if (k === " ") {
    if (!spaceDown) {
      spaceDown = true;
      canvas.classList.add("space");
    }
    e.preventDefault();
    return;
  }
  if (e.shiftKey && k === "r" && selected && view.kind(selected) !== "arrow") return rotateBy(selected, 90);
  const t = TOOLS.find((x) => x.key.toLowerCase() === k);
  if (t) return setTool(t.id);
  if ((k === "delete" || k === "backspace") && selected) return deleteItems([selected]);
  if (k === "enter" && selected) {
    e.preventDefault();
    return startEditing(selected);
  }
  if (k === "escape") {
    select(null);
    return setTool("select");
  }
  if (k === "=" || k === "+") return zoomAt(cam.z * 1.25, innerWidth / 2, innerHeight / 2);
  if (k === "-") return zoomAt(cam.z / 1.25, innerWidth / 2, innerHeight / 2);
  if (e.key === "!" || (k === "1" && e.shiftKey)) return fitView(true);
  if (k.startsWith("arrow") && selected) {
    e.preventDefault();
    const g = view.geom(selected);
    const step = e.shiftKey ? 40 : 8;
    const dx = k === "arrowleft" ? -step : k === "arrowright" ? step : 0;
    const dy = k === "arrowup" ? -step : k === "arrowdown" ? step : 0;
    setProps(selected, { x: g.x + dx, y: g.y + dy });
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === " ") {
    spaceDown = false;
    canvas.classList.remove("space");
  }
});

$("undoBtn").innerHTML = icon("undo");
$("redoBtn").innerHTML = icon("redo");
$("undoBtn").addEventListener("click", undo);
$("redoBtn").addEventListener("click", redo);

// ================================================================== images

const filePick = $("filePick") as HTMLInputElement;
function pickImage(): void {
  filePick.value = "";
  filePick.click();
}
filePick.addEventListener("change", () => {
  const files = [...(filePick.files ?? [])];
  files.forEach((f, i) => void addImage(f, innerWidth / 2 + i * 30, innerHeight / 2 + i * 30));
});

window.addEventListener("paste", (e) => {
  if ((e.target as Element | null)?.closest?.("input, textarea")) return;
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
  if (!files.length) return;
  e.preventDefault();
  files.forEach((f, i) => void addMedia(f, innerWidth / 2 + i * 30, innerHeight / 2 + i * 30));
});

let dragDepth = 0;
canvas.addEventListener("dragenter", (e) => {
  if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
  dragDepth++;
  $("drop").hidden = false;
});
canvas.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("drop").hidden = true;
  }
});
canvas.addEventListener("dragover", (e) => e.preventDefault());
canvas.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop").hidden = true;
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
  files.forEach((f, i) => void addMedia(f, e.clientX + i * 30, e.clientY + i * 30));
});

/** Shrink big photos before upload: longest side 1600px, WebP. Animated GIFs are kept as they are. */
async function prepareImage(file: File): Promise<{ blob: Blob; ext: "webp" | "jpg" | "png" | "gif"; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  const w0 = bmp.width, h0 = bmp.height;
  if (file.type === "image/gif" && file.size <= 2_000_000) {
    bmp.close();
    return { blob: file, ext: "gif", w: w0, h: h0 };
  }
  const k = Math.min(1, 1600 / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  for (const q of [0.86, 0.72, 0.55]) {
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/webp", q));
    if (blob && blob.type === "image/webp" && blob.size <= 1_900_000) return { blob, ext: "webp", w, h };
    if (!blob || blob.type !== "image/webp") break;
  }
  const jpg = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.8));
  if (!jpg) throw new Error("This browser couldn't read that image.");
  return { blob: jpg, ext: "jpg", w, h };
}

async function addImage(file: File, clientX: number, clientY: number): Promise<void> {
  if (session.isPaused || !navigator.onLine) {
    toast("Images need a connection. Reconnect, then add it again.");
    return;
  }
  if (!file.type.startsWith("image/")) return;
  let prepared: Awaited<ReturnType<typeof prepareImage>>;
  try {
    prepared = await prepareImage(file);
  } catch {
    toast("That file couldn't be opened as an image.", { tone: "error" });
    return;
  }
  const maxW = 420 / Math.max(cam.z, 0.5);
  const scale = Math.min(1, maxW / prepared.w);
  const w = Math.round(prepared.w * scale), h = Math.round(prepared.h * scale);
  const p = toWorld(clientX, clientY);
  const id = newItemId();
  session.commit(doc.createItem(id, { kind: "image", x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2), w, h, src: "", z: topZ() }));
  const local = URL.createObjectURL(prepared.blob);
  view.showLocalImage(id, local);
  if (tool !== "select") setTool("select");
  select(id);
  $("empty").hidden = true;
  try {
    const path = await api.uploadImage(boardId, prepared.blob, prepared.ext);
    session.commit(doc.setProps(id, { src: path }));
    view.clearLocalImage(id);
    pushStep(createdStep([id]));
  } catch (err) {
    session.commit(doc.deleteItem(id));
    toast(err instanceof ApiError ? err.message : "The image couldn't be uploaded.", { tone: "error" });
  } finally {
    setTimeout(() => URL.revokeObjectURL(local), 4000);
  }
}

// ================================================================== videos

const videoPick = $("videoPick") as HTMLInputElement;
function pickVideo(): void {
  videoPick.value = "";
  videoPick.click();
}
videoPick.addEventListener("change", () => {
  const files = [...(videoPick.files ?? [])];
  files.forEach((f, i) => void addVideo(f, innerWidth / 2 + i * 30, innerHeight / 2 + i * 30));
});

function addMedia(file: File, clientX: number, clientY: number): Promise<void> {
  return file.type.startsWith("video/") ? addVideo(file, clientX, clientY) : addImage(file, clientX, clientY);
}

function videoExt(file: File): "mp4" | "webm" | "mov" | null {
  if (file.type === "video/mp4") return "mp4";
  if (file.type === "video/webm") return "webm";
  if (file.type === "video/quicktime") return "mov";
  const m = file.name.toLowerCase().match(/\.(mp4|m4v|webm|mov)$/);
  return m ? (m[1] === "m4v" ? "mp4" : (m[1] as "mp4" | "webm" | "mov")) : null;
}

/** Width and height from the file itself, so the item has the video's shape from the start. */
function videoSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const done = (w: number, h: number) => {
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      resolve({ w, h });
    };
    const timer = setTimeout(() => done(1280, 720), 8000);
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => done(v.videoWidth || 1280, v.videoHeight || 720);
    v.onerror = () => done(1280, 720);
    v.src = url;
  });
}

async function addVideo(file: File, clientX: number, clientY: number): Promise<void> {
  if (session.isPaused || !navigator.onLine) {
    toast("Videos need a connection. Reconnect, then add it again.");
    return;
  }
  const ext = videoExt(file);
  if (!ext) {
    toast("Use an MP4, WebM or MOV video.", { tone: "error" });
    return;
  }
  if (file.size > MAX_VIDEO_BYTES) {
    toast(`That video is ${(file.size / 1048576).toFixed(0)} MB. Videos can be up to 50 MB.`, { tone: "error" });
    return;
  }
  const local = URL.createObjectURL(file);
  const size = await videoSize(local);
  const maxW = 480 / Math.max(cam.z, 0.5);
  const scale = Math.min(1, maxW / size.w, (maxW * 1.2) / size.h);
  const w = Math.round(size.w * scale), h = Math.round(size.h * scale);
  const p = toWorld(clientX, clientY);
  const id = newItemId();
  session.commit(doc.createItem(id, { kind: "video", x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2), w, h, src: "", z: topZ() }));
  view.showLocalImage(id, local);
  const node = view.nodes.get(id);
  node?.style.setProperty("--p", "0");
  if (tool !== "select") setTool("select");
  select(id);
  $("empty").hidden = true;
  try {
    const path = await api.uploadVideo(boardId, file, ext, (f) => view.nodes.get(id)?.style.setProperty("--p", f.toFixed(3)));
    session.commit(doc.setProps(id, { src: path }));
    view.clearLocalImage(id);
    pushStep(createdStep([id]));
  } catch (err) {
    session.commit(doc.deleteItem(id));
    toast(err instanceof ApiError ? err.message : "The video couldn't be uploaded.", { tone: "error" });
  } finally {
    setTimeout(() => URL.revokeObjectURL(local), 15000);
  }
}

// ================================================================== presence, cursors, live ink

const remoteCursors = new Map<string, Cursor & { node: HTMLElement }>();

function onRemoteCursor(c: Cursor): void {
  let rc = remoteCursors.get(c.replica);
  if (!rc) {
    const node = el("div", "cursor");
    node.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4.5 2.5 19 10.6l-6.6 1.7-3.3 6.3z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    node.append(el("span", undefined, c.name));
    cursorsLayer.append(node);
    rc = { ...c, node };
    remoteCursors.set(c.replica, rc);
  }
  Object.assign(rc, c);
  rc.node.querySelector("path")!.setAttribute("fill", c.color);
  rc.node.querySelector("span")!.style.background = c.color;
  rc.node.style.opacity = "1";
  placeCursor(rc);
}

function placeCursor(c: Cursor & { node: HTMLElement }): void {
  c.node.style.transform = `translate(${c.x * cam.z + cam.x}px, ${c.y * cam.z + cam.y}px)`;
}

const liveSeen = new Map<string, number>();
function onRemoteInk(ink: LiveInk): void {
  if (ink.done) {
    setTimeout(() => view.clearLive(ink.stroke), 1500);
    return;
  }
  const pts: Pt[] = [];
  for (let i = 0; i + 2 < ink.pts.length; i += 3) pts.push({ x: ink.pts[i], y: ink.pts[i + 1], p: ink.pts[i + 2] });
  if (!pts.length) return;
  liveSeen.set(ink.stroke, Date.now());
  view.setLive(ink.stroke, pts, ink.brush as Brush, ink.color);
  const rc = remoteCursors.get(ink.replica);
  if (rc) {
    const last = pts[pts.length - 1];
    onRemoteCursor({ ...rc, x: last.x, y: last.y, at: Date.now() });
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, c] of remoteCursors) {
    if (!peers.some((p) => p.replica === k) || now - c.at > 10000) {
      c.node.remove();
      remoteCursors.delete(k);
    } else if (now - c.at > 4000) c.node.style.opacity = "0.35";
  }
  for (const [k, t] of liveSeen) if (now - t > 4000) (view.clearLive(k), liveSeen.delete(k));
}, 1500);

function renderPeers(): void {
  const box = $("peers");
  const people = [meta, ...peers.filter((p) => p.replica !== who.replica)];
  box.replaceChildren(
    ...people.slice(0, 5).map((p, i) => {
      const a = el("span", i === 0 ? "peer me" : "peer", initials(p.name));
      a.style.background = p.color;
      a.title = i === 0 ? `${p.name} (you)` : p.name;
      return a;
    }),
  );
  if (people.length > 5) box.append(el("span", "peer", `+${people.length - 5}`));
  box.setAttribute("aria-label", `${people.length} ${people.length === 1 ? "person" : "people"} on this board`);
}

// ================================================================== status

let lastStats: SyncStats | null = null;
let lastStatus: SyncStatus = "loading";
const offlineBtn = $("offlineBtn");

function renderStatus(s: SyncStatus): void {
  lastStatus = s;
  $("status").dataset.s = s;
  const unsent = lastStats?.unsent ?? 0;
  const label: Record<SyncStatus, string> = {
    loading: "Loading",
    live: peers.length ? `Live with ${peers.length}` : "Live",
    connecting: "Connecting",
    offline: unsent ? `Offline · ${unsent} to send` : "Offline",
    paused: unsent ? `Offline · ${unsent} queued` : "You're offline",
    error: "Sync error",
  };
  $("statusText").textContent = label[s];
  offlineBtn.setAttribute("aria-pressed", String(s === "paused"));
  offlineBtn.innerHTML = s === "paused" ? icon("wifiOff") : icon("wifi");
  offlineBtn.setAttribute("aria-label", s === "paused" ? "Reconnect" : "Go offline");
  offlineBtn.title = s === "paused" ? "Reconnect and merge" : "Go offline (test offline editing)";
}

function renderStats(s: SyncStats): void {
  const prev = lastStats?.hash;
  lastStats = s;
  renderStatus(lastStatus);
  renderFingerprint($("fpSwatches"), $("fpText"), s.hash);
  if (prev && prev !== s.hash) {
    const fp = $("fingerprint");
    fp.classList.remove("flash");
    void fp.offsetWidth;
    fp.classList.add("flash");
  }
  $("syncInfo").textContent = `log #${s.lastSeq}${s.unsent ? ` · ${s.unsent} unsent` : ""}${s.pending ? ` · ${s.pending} waiting` : ""}`;
  // only a change to the board restarts the countdown; sync ticks alone must not keep pushing it back
  if (prev !== s.hash) schedulePreview();
}

offlineBtn.addEventListener("click", () => {
  const going = !session.isPaused;
  session.setPaused(going);
  toast(going ? "You're offline. Keep drawing; it all merges when you reconnect." : "Back online. Merging…");
});

const shareBtn = $("shareBtn");
shareBtn.innerHTML = `${icon("link")}<span>Share</span>`;
shareBtn.addEventListener("click", async () => {
  const url = `${location.origin}/b/${boardId}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied. Anyone with it can draw on this board.");
  } catch {
    toast(`Share this link: ${url}`);
  }
});

// ================================================================== title, saving, previews

const titleInput = $("title") as HTMLInputElement;
let savedTitle = "";
async function commitTitle(): Promise<void> {
  const next = titleInput.value.trim();
  if (!next) {
    titleInput.value = savedTitle;
    return;
  }
  if (next === savedTitle) return;
  try {
    savedTitle = await api.rename(boardId, next);
    titleInput.value = savedTitle;
    document.title = `${savedTitle} · Lattice`;
    rememberBoard(boardId, savedTitle);
  } catch (e) {
    titleInput.value = savedTitle;
    toast(e instanceof ApiError ? e.message : "Couldn't rename the board.", { tone: "error" });
  }
}
titleInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") titleInput.blur();
  if (e.key === "Escape") {
    titleInput.value = savedTitle;
    titleInput.blur();
  }
});
titleInput.addEventListener("blur", () => void commitTitle());

let previewTimer: ReturnType<typeof setTimeout> | null = null;
let previewHash = "";
function schedulePreview(): void {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(savePreview, 5000);
}
function savePreview(): void {
  if (session.isPaused || !lastStats || lastStats.hash === previewHash) return;
  const svg = boardPreview(doc);
  if (!svg) return;
  previewHash = lastStats.hash;
  api
    .setPreview(boardId, svg)
    .then(() => api.indexBoard(boardId))
    .catch(() => (previewHash = ""));
}

// ================================================================== boot

function fatal(title: string, text: string): void {
  $("fatalTitle").textContent = title;
  $("fatalText").textContent = text;
  $("fatal").hidden = false;
}

async function boot(): Promise<void> {
  mountAccount($("account"), { compact: true });
  onAuthChange((u) => {
    if (u) api.saveBoard(boardId).catch(() => {});
  });
  setTool("select");
  paintDots();
  renderUndo();
  renderStatus("loading");
  doc.onChange(() => ($("empty").hidden = doc.itemIds().length > 0));
  try {
    await session.start();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) fatal("This board doesn't exist.", "The link may be mistyped, or the board was never created.");
    else fatal("Couldn't open this board.", err instanceof Error ? err.message : "Check your connection and try again.");
    return;
  }
  const info = await api.board(boardId).catch(() => null);
  savedTitle = info?.title ?? "Untitled board";
  titleInput.value = savedTitle;
  titleInput.disabled = false;
  document.title = `${savedTitle} · Lattice`;
  rememberBoard(boardId, savedTitle);
  $("empty").hidden = doc.itemIds().length > 0;
  fitView();
  renderPeers();
  movePill();
}

window.addEventListener("pagehide", () => {
  savePreview();
  session.stop();
});

if (!UUID_RE.test(boardId)) fatal("This link isn't a board.", "Board links end in a long code after /b/. Open one of your boards or start a new one.");
else void boot();
applyCamera();
