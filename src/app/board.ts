/** The board page: renders the CRDT document and turns pointer/keyboard input into ops. */
import type { Json } from "../crdt/lww.js";
import { BoardSession, type Cursor, type SyncStats, type SyncStatus } from "../sync/session.js";
import type { PresenceMeta } from "../sync/realtime.js";
import { api, ApiError } from "../sync/api.js";
import { newItemId } from "../lab/random.js";
import { INKS, INK_KEYS, cpToUtf16, el, identity, initials, renderFingerprint, utf16ToCp } from "./ui.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ boot

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const boardId = (location.pathname.match(/\/b\/([^/]+)/)?.[1] ?? new URLSearchParams(location.search).get("b") ?? "").toLowerCase();

const me = identity();
const meta: PresenceMeta = { replica: me.replica, name: me.name, color: me.color };

const canvas = $("canvas");
const world = $("world");
const cursorsLayer = $("cursors");

type Tool = "select" | "note" | "rect" | "ellipse";
let tool: Tool = "select";
let selected: string | null = null;
let editing: { item: string; ta: HTMLTextAreaElement; anchor: string; focus: string } | null = null;
const cam = { x: 0, y: 0, z: 1 };
const nodes = new Map<string, HTMLElement>();
let peers: PresenceMeta[] = [];

const session = new BoardSession(boardId, meta, {
  status: renderStatus,
  peers: (p) => {
    peers = p;
    renderPeers();
  },
  cursor: onRemoteCursor,
  stats: renderStats,
});
const doc = session.doc;

if (!UUID_RE.test(boardId)) {
  fatal("This link isn't a board.", "Board links look like lattice…/b/ followed by a long code. Start a new board instead.");
} else {
  void boot();
}

async function boot(): Promise<void> {
  doc.onChange((change, source) => {
    for (const item of change.items) renderItem(item, source === "remote");
    for (const item of change.texts) renderText(item, source);
    $("empty").hidden = doc.itemIds().length > 0;
  });
  try {
    await session.start();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) fatal("This board doesn't exist.", "The link may be mistyped, or the board was never created.");
    else fatal("Couldn't open this board.", err instanceof Error ? err.message : "Check your connection and try again.");
    return;
  }
  const info = await api.board(boardId).catch(() => null);
  const title = info?.title ?? "Board";
  $("boardTitle").textContent = title;
  document.title = `${title} · Lattice`;
  for (const id of doc.itemIds()) renderItem(id, false);
  $("empty").hidden = doc.itemIds().length > 0;
  fitView();
  renderPeers();
}

function fatal(title: string, text: string): void {
  $("fatalTitle").textContent = title;
  $("fatalText").textContent = text;
  $("fatal").hidden = false;
}

window.addEventListener("pagehide", () => session.stop());

// ------------------------------------------------------------------ camera

function applyCamera(): void {
  world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
  for (const c of remoteCursors.values()) placeCursor(c);
}

function toWorld(clientX: number, clientY: number): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: (clientX - r.left - cam.x) / cam.z, y: (clientY - r.top - cam.y) / cam.z };
}

function fitView(): void {
  const ids = doc.itemIds();
  const r = canvas.getBoundingClientRect();
  if (!ids.length) {
    cam.x = r.width / 2;
    cam.y = r.height / 2;
    cam.z = 1;
    return applyCamera();
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of ids) {
    const g = geom(id);
    x0 = Math.min(x0, g.x); y0 = Math.min(y0, g.y);
    x1 = Math.max(x1, g.x + g.w); y1 = Math.max(y1, g.y + g.h);
  }
  const pad = Math.min(80, r.width * 0.06);
  cam.z = Math.max(0.3, Math.min(1, (r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0)));
  cam.x = r.width / 2 - ((x0 + x1) / 2) * cam.z;
  cam.y = r.height / 2 - ((y0 + y1) / 2) * cam.z;
  applyCamera();
}

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const z = Math.max(0.25, Math.min(2.5, cam.z * Math.exp(-e.deltaY * 0.01)));
      cam.x = px - ((px - cam.x) * z) / cam.z;
      cam.y = py - ((py - cam.y) * z) / cam.z;
      cam.z = z;
    } else {
      cam.x -= e.deltaX;
      cam.y -= e.deltaY;
    }
    applyCamera();
  },
  { passive: false },
);

// ------------------------------------------------------------------ rendering

const num = (v: Json | undefined, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function geom(id: string) {
  return {
    x: num(doc.prop(id, "x"), 0),
    y: num(doc.prop(id, "y"), 0),
    w: Math.max(80, num(doc.prop(id, "w"), 180)),
    h: Math.max(60, num(doc.prop(id, "h"), 140)),
  };
}

function renderItem(id: string, remote: boolean): void {
  let node = nodes.get(id);
  if (!doc.hasItem(id)) {
    if (node) {
      node.remove();
      nodes.delete(id);
    }
    if (selected === id) select(null);
    if (editing?.item === id) editing = null;
    return;
  }
  if (!node) {
    node = el("div", "item");
    node.dataset.id = id;
    node.append(el("div", "text"), el("div", "grip"));
    if (remote) node.classList.add("arrive");
    world.append(node);
    nodes.set(id, node);
    renderText(id, "remote");
  }
  const kind = String(doc.prop(id, "kind") ?? "note");
  node.className = `item ${["note", "rect", "ellipse"].includes(kind) ? kind : "note"}${selected === id ? " selected" : ""}${node.classList.contains("dragging") ? " dragging" : ""}`;
  const ink = INKS[String(doc.prop(id, "color") ?? "sun")] ?? INKS.sun;
  node.style.setProperty("--fill", ink.fill);
  node.style.setProperty("--misreg", ink.misreg);
  if (!node.classList.contains("dragging")) {
    const g = geom(id);
    node.style.transform = `translate(${g.x}px, ${g.y}px)`;
    node.style.width = `${g.w}px`;
    node.style.height = `${g.h}px`;
  }
  node.style.zIndex = String(Math.round(num(doc.prop(id, "z"), 0)));
  node.setAttribute("aria-label", `${ink.label} ${kind}: ${doc.text(id) || "empty"}`);
  if (selected === id) renderInspector();
}

function renderText(id: string, source: "local" | "remote"): void {
  const node = nodes.get(id);
  if (!node) return;
  const text = doc.text(id);
  if (editing?.item === id) {
    if (source === "remote") {
      // keep the caret glued to the character it was after, while others type around it
      const { ta, anchor, focus } = editing;
      const rga = doc.rga(id);
      ta.value = text;
      const a = cpToUtf16(text, rga.indexAfter(anchor));
      const f = cpToUtf16(text, rga.indexAfter(focus));
      ta.setSelectionRange(Math.min(a, f), Math.max(a, f));
    }
    return;
  }
  const t = node.querySelector(".text");
  if (t && t.textContent !== text) t.textContent = text;
}

// ------------------------------------------------------------------ selection and editing

function select(id: string | null): void {
  if (selected === id) return;
  const prev = selected;
  selected = id;
  if (prev) nodes.get(prev)?.classList.remove("selected");
  if (id) {
    nodes.get(id)?.classList.add("selected");
    bringToFront(id);
  }
  renderInspector();
}

function bringToFront(id: string): void {
  let max = -Infinity;
  for (const other of doc.itemIds()) if (other !== id) max = Math.max(max, num(doc.prop(other, "z"), 0));
  const z = num(doc.prop(id, "z"), 0);
  if (max >= z) session.commit(doc.setProps(id, { z: max + 1 }));
}

function renderInspector(): void {
  const box = $("inspector");
  if (!selected || !doc.hasItem(selected)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const current = String(doc.prop(selected, "color") ?? "sun");
  const sw = $("swatches");
  if (!sw.childElementCount) {
    for (const k of INK_KEYS) {
      const b = el("button", "swatch");
      b.type = "button";
      b.dataset.ink = k;
      b.style.setProperty("--c", INKS[k].fill);
      b.title = INKS[k].label;
      b.setAttribute("aria-label", `Colour: ${INKS[k].label}`);
      b.addEventListener("click", () => selected && session.commit(doc.setProps(selected, { color: k })));
      sw.append(b);
    }
  }
  for (const b of sw.querySelectorAll<HTMLButtonElement>(".swatch")) b.setAttribute("aria-pressed", String(b.dataset.ink === current));
}

$("deleteBtn").addEventListener("click", deleteSelected);

function deleteSelected(): void {
  if (!selected) return;
  const id = selected;
  select(null);
  session.commit(doc.deleteItem(id));
  toast("Deleted. If someone edits it at the same moment, their copy survives.");
}

function startEditing(id: string): void {
  const node = nodes.get(id);
  if (!node || editing?.item === id) return;
  stopEditing();
  select(id);
  const ta = el("textarea");
  ta.value = doc.text(id);
  ta.maxLength = 2000;
  ta.setAttribute("aria-label", "Note text");
  ta.spellcheck = true;
  node.querySelector(".text")?.replaceWith(ta);
  const state = { item: id, ta, anchor: "", focus: "" };
  editing = state;
  const track = () => {
    const rga = doc.rga(id);
    state.anchor = rga.idBefore(utf16ToCp(ta.value, ta.selectionStart));
    state.focus = rga.idBefore(utf16ToCp(ta.value, ta.selectionEnd));
  };
  ta.addEventListener("input", () => {
    session.commit(doc.editText(id, ta.value));
    if (ta.value !== doc.text(id)) ta.value = doc.text(id); // clamp (max length)
    track();
  });
  for (const ev of ["keyup", "mouseup", "select", "focus"]) ta.addEventListener(ev, track);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      stopEditing();
      canvas.focus();
    }
    e.stopPropagation();
  });
  ta.addEventListener("blur", () => setTimeout(() => editing?.ta === ta && stopEditing(), 0));
  ta.addEventListener("pointerdown", (e) => e.stopPropagation());
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  track();
}

function stopEditing(): void {
  if (!editing) return;
  const { item, ta } = editing;
  editing = null;
  const t = el("div", "text", doc.text(item));
  ta.replaceWith(t);
}

// ------------------------------------------------------------------ pointer input

function setTool(t: Tool): void {
  tool = t;
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) b.setAttribute("aria-pressed", String(b.dataset.tool === t));
  canvas.classList.toggle("placing", t !== "select");
}
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tool]")) b.addEventListener("click", () => setTool(b.dataset.tool as Tool));

function createAt(kind: "note" | "rect" | "ellipse", x: number, y: number): string {
  const id = newItemId();
  const size = kind === "note" ? { w: 200, h: 160 } : kind === "rect" ? { w: 220, h: 130 } : { w: 200, h: 150 };
  let z = 0;
  for (const other of doc.itemIds()) z = Math.max(z, num(doc.prop(other, "z"), 0) + 1);
  const color = kind === "note" ? "sun" : kind === "rect" ? "sky" : "rose";
  session.commit(doc.createItem(id, { kind, x: Math.round(x - size.w / 2), y: Math.round(y - size.h / 2), ...size, color, z }));
  nodes.get(id)?.classList.add("arrive");
  return id;
}

type Drag =
  | { kind: "move"; id: string; dx: number; dy: number; x: number; y: number; moved: boolean; last: number; wasSelected: boolean }
  | { kind: "resize"; id: string; x0: number; y0: number; w: number; h: number; last: number }
  | { kind: "pan"; sx: number; sy: number; cx: number; cy: number };
let drag: Drag | null = null;

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  const target = e.target as HTMLElement;
  const itemNode = target.closest<HTMLElement>(".item");
  const p = toWorld(e.clientX, e.clientY);

  if (tool !== "select" && !itemNode) {
    const id = createAt(tool, p.x, p.y);
    setTool("select");
    e.preventDefault();
    startEditing(id);
    return;
  }
  if (itemNode && e.button === 0) {
    const id = itemNode.dataset.id!;
    if (editing?.item === id) return;
    stopEditing();
    const wasSelected = selected === id;
    select(id);
    const g = geom(id);
    if (target.classList.contains("grip")) drag = { kind: "resize", id, x0: p.x, y0: p.y, w: g.w, h: g.h, last: 0 };
    else drag = { kind: "move", id, dx: p.x - g.x, dy: p.y - g.y, x: g.x, y: g.y, moved: false, last: 0, wasSelected };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  stopEditing();
  select(null);
  drag = { kind: "pan", sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
  canvas.classList.add("panning");
  canvas.setPointerCapture(e.pointerId);
});

let lastCursorSent = 0;
canvas.addEventListener("pointermove", (e) => {
  const p = toWorld(e.clientX, e.clientY);
  const now = performance.now();
  if (now - lastCursorSent > 60) {
    lastCursorSent = now;
    session.sendCursor(p.x, p.y);
  }
  if (!drag) return;
  if (drag.kind === "pan") {
    cam.x = drag.cx + e.clientX - drag.sx;
    cam.y = drag.cy + e.clientY - drag.sy;
    applyCamera();
    return;
  }
  const node = nodes.get(drag.id);
  if (!node) return;
  if (drag.kind === "move") {
    drag.x = Math.round(p.x - drag.dx);
    drag.y = Math.round(p.y - drag.dy);
    if (!drag.moved) {
      if (Math.hypot(drag.x - geom(drag.id).x, drag.y - geom(drag.id).y) < 3) return; // ignore jitter on a tap
      drag.moved = true;
      node.classList.add("dragging");
    }
    node.style.transform = `translate(${drag.x}px, ${drag.y}px)`;
    // stream the drag to others ~12 times a second; the LWW register keeps only the newest
    if (now - drag.last > 80) {
      drag.last = now;
      session.commit(doc.setProps(drag.id, { x: drag.x, y: drag.y }));
    }
  } else {
    const w = Math.max(80, Math.round(drag.w + p.x - drag.x0));
    const h = Math.max(60, Math.round(drag.h + p.y - drag.y0));
    node.style.width = `${w}px`;
    node.style.height = `${h}px`;
    if (now - drag.last > 80) {
      drag.last = now;
      session.commit(doc.setProps(drag.id, { w, h }));
    }
  }
});

function endDrag(e: PointerEvent): void {
  if (!drag) return;
  const d = drag;
  drag = null;
  canvas.classList.remove("panning");
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* not captured */
  }
  if (d.kind === "move") {
    const node = nodes.get(d.id);
    node?.classList.remove("dragging");
    if (d.moved) session.commit(doc.setProps(d.id, { x: d.x, y: d.y }));
    else if (d.wasSelected && e.type === "pointerup") startEditing(d.id); // second tap edits
  } else if (d.kind === "resize") {
    const node = nodes.get(d.id);
    if (node) session.commit(doc.setProps(d.id, { w: parseInt(node.style.width, 10), h: parseInt(node.style.height, 10) }));
  }
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

canvas.addEventListener("dblclick", (e) => {
  // pointer capture on the canvas retargets click events to it, so hit-test the real point
  const hit = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
  if (hit?.closest("textarea")) return;
  const itemNode = hit?.closest<HTMLElement>(".item");
  if (itemNode) return startEditing(itemNode.dataset.id!);
  const p = toWorld(e.clientX, e.clientY);
  e.preventDefault();
  startEditing(createAt("note", p.x, p.y));
});

window.addEventListener("keydown", (e) => {
  if (editing || (e.target as HTMLElement).closest("input, textarea")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "v") setTool("select");
  else if (k === "n") setTool("note");
  else if (k === "r") setTool("rect");
  else if (k === "o") setTool("ellipse");
  else if ((k === "delete" || k === "backspace") && selected) deleteSelected();
  else if (k === "enter" && selected) {
    e.preventDefault();
    startEditing(selected);
  } else if (k === "escape") {
    select(null);
    setTool("select");
  } else if (k.startsWith("arrow") && selected) {
    e.preventDefault();
    const g = geom(selected);
    const step = e.shiftKey ? 40 : 8;
    const dx = k === "arrowleft" ? -step : k === "arrowright" ? step : 0;
    const dy = k === "arrowup" ? -step : k === "arrowdown" ? step : 0;
    session.commit(doc.setProps(selected, { x: g.x + dx, y: g.y + dy }));
  } else return;
});

// ------------------------------------------------------------------ presence and cursors

const remoteCursors = new Map<string, Cursor & { node: HTMLElement }>();

function onRemoteCursor(c: Cursor): void {
  let rc = remoteCursors.get(c.replica);
  if (!rc) {
    const node = el("div", "cursor");
    node.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4 2l16 9-7 1.8L9.5 20z" stroke="#17191c" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    const tag = el("span", undefined, c.name);
    node.append(tag);
    cursorsLayer.append(node);
    rc = { ...c, node };
    remoteCursors.set(c.replica, rc);
  }
  Object.assign(rc, c);
  rc.node.querySelector("path")!.setAttribute("fill", c.color);
  (rc.node.querySelector("span") as HTMLElement).style.background = c.color;
  placeCursor(rc);
}

function placeCursor(c: Cursor & { node: HTMLElement }): void {
  c.node.style.transform = `translate(${c.x * cam.z + cam.x}px, ${c.y * cam.z + cam.y}px)`;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, c] of remoteCursors) {
    const gone = !peers.some((p) => p.replica === k);
    if (gone || now - c.at > 8000) {
      c.node.remove();
      remoteCursors.delete(k);
    }
  }
}, 2000);

function renderPeers(): void {
  const box = $("peers");
  const people = [meta, ...peers.filter((p) => p.replica !== me.replica)];
  box.replaceChildren(
    ...people.slice(0, 6).map((p, i) => {
      const a = el("span", i === 0 ? "peer me" : "peer", initials(p.name));
      a.style.background = p.color;
      a.title = i === 0 ? `${p.name} (you)` : p.name;
      return a;
    }),
  );
  if (people.length > 6) box.append(el("span", "peer", `+${people.length - 6}`));
  box.setAttribute("aria-label", `${people.length} ${people.length === 1 ? "person" : "people"} on this board`);
}

// ------------------------------------------------------------------ status

let lastStats: SyncStats | null = null;
let lastStatus: SyncStatus = "loading";

function renderStatus(s: SyncStatus): void {
  lastStatus = s;
  const pill = $("status");
  pill.dataset.s = s;
  const unsent = lastStats?.unsent ?? 0;
  const label: Record<SyncStatus, string> = {
    loading: "Loading",
    live: "Live",
    connecting: "Connecting…",
    offline: unsent ? `Offline · ${unsent} to send` : "Offline",
    paused: unsent ? `Offline by you · ${unsent} queued` : "Offline by you",
    error: "Sync error",
  };
  $("statusText").textContent = label[s];
  const btn = $("offlineBtn");
  btn.setAttribute("aria-pressed", String(s === "paused"));
  btn.querySelector("span")!.textContent = s === "paused" ? "Reconnect" : "Go offline";
}

function renderStats(s: SyncStats): void {
  const prevHash = lastStats?.hash;
  lastStats = s;
  renderStatus(lastStatus);
  renderFingerprint($("fpSwatches"), $("fpText"), s.hash);
  if (prevHash && prevHash !== s.hash) {
    const fp = $("fingerprint");
    fp.classList.remove("flash");
    void fp.offsetWidth;
    fp.classList.add("flash");
  }
  $("syncInfo").textContent = `log #${s.lastSeq} · unsent ${s.unsent}${s.pending ? ` · waiting ${s.pending}` : ""}`;
}

$("offlineBtn").addEventListener("click", () => {
  const going = !session.isPaused;
  session.setPaused(going);
  toast(going ? "You're offline. Keep editing; it all merges when you reconnect." : "Back online. Merging…");
});

$("shareBtn").addEventListener("click", async () => {
  const url = `${location.origin}/b/${boardId}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied. Anyone with it can edit.");
  } catch {
    toast(`Copy this link: ${url}`);
  }
});

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string): void {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

window.addEventListener("resize", () => applyCamera());
applyCamera();
