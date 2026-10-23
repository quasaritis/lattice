/**
 * A Lattice board document: the three CRDTs from the paper composed together.
 *
 *   items  OR-Set     which notes and shapes exist (add-wins on concurrent delete)
 *   props  LWW-Map    "<item>/<field>" -> value: position, size, colour, kind, z-order
 *   texts  RGA        one sequence per note for its text
 *
 * It works both ways the paper describes:
 *   - op-based (CmRDT): local edits produce small ops that are broadcast and applied
 *     downstream. Ops whose causal dependencies have not arrived yet are buffered.
 *     Applying an op twice does nothing, so the transport may duplicate and reorder freely.
 *   - state-based (CvRDT): `toState()` / `merge()` exchange whole states. Used for
 *     snapshots, so a new client loads one snapshot plus the ops after it.
 */
import { HLC, type Timestamp } from "./hlc.js";
import { LWWMap, type Json, type LWWState } from "./lww.js";
import { ORSet, type ORSetState } from "./orset.js";
import { RGA, ROOT, runIds, type RGAState } from "./rga.js";

export type Op =
  | { k: "add"; id: Timestamp; item: string } // tag = id
  | { k: "rem"; id: Timestamp; item: string; tags: string[] }
  | { k: "set"; id: Timestamp; key: string; v: Json } // LWW timestamp = id
  | { k: "ins"; id: Timestamp; item: string; after: string; text: string }
  | { k: "del"; id: Timestamp; item: string; targets: string[] };

export interface DocState {
  items: ORSetState;
  props: LWWState;
  texts: Record<string, RGAState>;
}

export interface Change {
  items: Set<string>;
  texts: Set<string>;
}

export type Listener = (change: Change, source: "local" | "remote") => void;

export const MAX_TEXT = 2000;
export const ITEM_FIELDS = ["kind", "x", "y", "w", "h", "color", "z"] as const;

export class Doc {
  readonly clock: HLC;
  private items = new ORSet();
  private props = new LWWMap();
  private texts = new Map<string, RGA>();
  private applied = new Set<Timestamp>();
  private pending = new Map<Timestamp, Op>();
  private listeners = new Set<Listener>();
  /** Ops that were well-formed but could not be applied safely. */
  readonly rejected: { op: Op; reason: string }[] = [];

  constructor(replica: string, physicalNow?: () => number) {
    this.clock = new HLC(replica, physicalNow);
  }

  get replica(): string {
    return this.clock.replica;
  }

  // ------------------------------------------------------------------ reading

  itemIds(): string[] {
    return this.items.values();
  }

  hasItem(item: string): boolean {
    return this.items.has(item);
  }

  prop(item: string, field: string): Json | undefined {
    return this.props.get(`${item}/${field}`);
  }

  text(item: string): string {
    return this.texts.get(item)?.text() ?? "";
  }

  rga(item: string): RGA {
    let r = this.texts.get(item);
    if (!r) this.texts.set(item, (r = new RGA()));
    return r;
  }

  /** Ops waiting for their causal dependencies. */
  get pendingCount(): number {
    return this.pending.size;
  }

  get appliedCount(): number {
    return this.applied.size;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ------------------------------------------------------------------ local edits (each returns the ops to broadcast)

  createItem(item: string, fields: Partial<Record<(typeof ITEM_FIELDS)[number], Json>>, text = ""): Op[] {
    const ops: Op[] = [{ k: "add", id: this.clock.now(), item }];
    for (const [f, v] of Object.entries(fields)) ops.push({ k: "set", id: this.clock.now(), key: `${item}/${f}`, v: v as Json });
    if (text) ops.push({ k: "ins", id: this.clock.now(), item, after: ROOT, text: text.slice(0, MAX_TEXT) });
    return this.applyLocal(ops);
  }

  setProps(item: string, fields: Record<string, Json>): Op[] {
    const ops: Op[] = Object.entries(fields).map(([f, v]) => ({ k: "set", id: this.clock.now(), key: `${item}/${f}`, v }));
    return this.applyLocal(ops);
  }

  deleteItem(item: string): Op[] {
    const tags = this.items.liveTags(item);
    if (!tags.length) return [];
    return this.applyLocal([{ k: "rem", id: this.clock.now(), item, tags }]);
  }

  /**
   * Turn "the note's text is now `next`" into RGA ops, using the common prefix and suffix
   * with the current text. Indexes are in code points, matching how RGA stores characters.
   */
  editText(item: string, next: string): Op[] {
    const rga = this.rga(item);
    const prev = Array.from(rga.text());
    let nxt = Array.from(next);
    if (nxt.length > MAX_TEXT) nxt = nxt.slice(0, MAX_TEXT);
    let start = 0;
    while (start < prev.length && start < nxt.length && prev[start] === nxt[start]) start++;
    let endPrev = prev.length;
    let endNext = nxt.length;
    while (endPrev > start && endNext > start && prev[endPrev - 1] === nxt[endNext - 1]) {
      endPrev--;
      endNext--;
    }
    const ops: Op[] = [];
    const ids = rga.visibleIds();
    if (endPrev > start) ops.push({ k: "del", id: this.clock.now(), item, targets: ids.slice(start, endPrev) });
    if (endNext > start) {
      ops.push({ k: "ins", id: this.clock.now(), item, after: rga.idBefore(start), text: nxt.slice(start, endNext).join("") });
    }
    return this.applyLocal(ops);
  }

  // ------------------------------------------------------------------ op-based replication

  /**
   * Apply ops from another replica. Safe with duplicates and any delivery order:
   * ops whose dependencies are missing wait in a buffer until they can apply.
   * Returns the number of ops newly applied.
   */
  applyRemote(ops: Op[]): number {
    const change: Change = { items: new Set(), texts: new Set() };
    let n = 0;
    for (const op of ops) {
      if (!isOp(op)) {
        this.rejected.push({ op: op as Op, reason: "malformed op" });
        continue;
      }
      if (this.applied.has(op.id) || this.pending.has(op.id)) continue;
      this.pending.set(op.id, op);
    }
    // Drain the buffer until no more ops become ready. Ops are tried oldest-first,
    // which is usually causal order already, so this rarely needs more than one pass.
    let progress = true;
    while (progress && this.pending.size) {
      progress = false;
      for (const op of [...this.pending.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (!this.isReady(op)) continue;
        this.pending.delete(op.id);
        progress = true;
        try {
          this.clock.receive(op.id);
          this.effect(op, change);
        } catch (err) {
          // A malformed or hostile op (clock far in the future, reused tag, anchor newer than
          // the insert). Drop it rather than let one bad peer stop everyone else's edits.
          this.rejected.push({ op, reason: String((err as Error).message ?? err) });
          continue;
        }
        this.applied.add(op.id);
        n++;
      }
    }
    if (n) this.emit(change, "remote");
    return n;
  }

  /** Causal-delivery preconditions from the paper, per op type. */
  isReady(op: Op): boolean {
    switch (op.k) {
      case "add":
      case "set":
        return true;
      case "rem":
        return op.tags.every((t) => this.items.hasTag(t));
      case "ins":
        return op.after === ROOT || (this.texts.get(op.item)?.has(op.after) ?? false);
      case "del": {
        const r = this.texts.get(op.item);
        return !!r && op.targets.every((t) => r.has(t));
      }
    }
  }

  // ------------------------------------------------------------------ state-based replication

  toState(): DocState {
    const texts: Record<string, RGAState> = {};
    for (const k of [...this.texts.keys()].sort()) {
      const s = this.texts.get(k)!.toState();
      if (s.nodes.length) texts[k] = s;
    }
    return { items: this.items.toState(), props: this.props.toState(), texts };
  }

  /** Join a whole state into this replica (snapshot load, or anti-entropy). */
  merge(state: DocState): void {
    const change: Change = { items: new Set(), texts: new Set() };
    this.items.merge(state.items);
    for (const [el] of state.items.adds) change.items.add(el);
    this.props.merge(state.props);
    for (const key of Object.keys(state.props)) change.items.add(key.split("/")[0]);
    for (const [item, s] of Object.entries(state.texts)) {
      this.rga(item).merge(s);
      change.texts.add(item);
    }
    // advance our clock past everything in the state so new edits sort after it
    let max = "";
    for (const [, tag] of state.items.adds) if (tag > max) max = tag;
    for (const [, ts] of Object.values(state.props)) if (ts > max) max = ts;
    for (const s of Object.values(state.texts)) for (const [id] of s.nodes) {
      const base = id.split(":")[0];
      if (base > max) max = base;
    }
    if (max) this.clock.receive(max);
    // buffered ops may have become ready
    this.applyRemote([]);
    this.emit(change, "remote");
  }

  /** Short fingerprint of the full replicated state. Equal states give equal hashes. */
  hash(): string {
    return fnv1a(JSON.stringify(this.toState()));
  }

  // ------------------------------------------------------------------ internals

  private applyLocal(ops: Op[]): Op[] {
    const change: Change = { items: new Set(), texts: new Set() };
    for (const op of ops) {
      this.effect(op, change);
      this.applied.add(op.id);
    }
    if (ops.length) this.emit(change, "local");
    return ops;
  }

  private effect(op: Op, change: Change): void {
    switch (op.k) {
      case "add":
        this.items.add(op.item, op.id);
        change.items.add(op.item);
        break;
      case "rem":
        this.items.remove(op.item, op.tags);
        change.items.add(op.item);
        break;
      case "set":
        this.props.set(op.key, op.v, op.id);
        change.items.add(op.key.split("/")[0]);
        break;
      case "ins":
        this.rga(op.item).insert(op.id, op.after, op.text);
        change.texts.add(op.item);
        break;
      case "del":
        this.rga(op.item).delete(op.targets);
        change.texts.add(op.item);
        break;
    }
  }

  private emit(change: Change, source: "local" | "remote"): void {
    for (const fn of this.listeners) fn(change, source);
  }
}

const TS_RE = /^\d{13}\.[0-9a-z]{5}\.[A-Za-z0-9_-]{1,32}$/;
const ID_RE = /^\d{13}\.[0-9a-z]{5}\.[A-Za-z0-9_-]{1,32}(:[0-9a-z]{3})?$/;
const ITEM_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Validate an op from the network before trusting it. */
export function isOp(x: unknown): x is Op {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== "string" || !TS_RE.test(o.id)) return false;
  switch (o.k) {
    case "add":
      return typeof o.item === "string" && ITEM_RE.test(o.item);
    case "rem":
      return typeof o.item === "string" && ITEM_RE.test(o.item) && Array.isArray(o.tags) && o.tags.length > 0 && o.tags.every((t) => typeof t === "string" && TS_RE.test(t));
    case "set": {
      if (typeof o.key !== "string") return false;
      const [item, field, extra] = o.key.split("/");
      return ITEM_RE.test(item ?? "") && (ITEM_FIELDS as readonly string[]).includes(field ?? "") && extra === undefined && isSmallJson(o.v);
    }
    case "ins":
      return typeof o.item === "string" && ITEM_RE.test(o.item) && typeof o.after === "string" && (o.after === ROOT || ID_RE.test(o.after)) && typeof o.text === "string" && o.text.length > 0 && Array.from(o.text).length <= MAX_TEXT;
    case "del":
      return typeof o.item === "string" && ITEM_RE.test(o.item) && Array.isArray(o.targets) && o.targets.length > 0 && o.targets.length <= MAX_TEXT && o.targets.every((t) => typeof t === "string" && ID_RE.test(t));
    default:
      return false;
  }
}

function isSmallJson(v: unknown): boolean {
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return v.length <= 64;
  return false;
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export { ROOT, runIds };
