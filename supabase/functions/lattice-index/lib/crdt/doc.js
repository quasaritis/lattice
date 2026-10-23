// Generated from src/crdt/doc.ts by scripts/copy-crdt.mjs. Do not edit.
import { HLC } from "./hlc.js";
import { LWWMap } from "./lww.js";
import { ORSet } from "./orset.js";
import { RGA, ROOT, runIds } from "./rga.js";
export const MAX_TEXT = 2000;
export const ITEM_FIELDS = ["kind", "x", "y", "w", "h", "color", "z", "src", "d", "brush", "fs", "r"];
export const ITEM_KINDS = ["note", "rect", "ellipse", "text", "image", "ink", "arrow", "video"];
export const BRUSHES = ["pen", "marker", "hl"];
export const MAX_STROKE = 9000;
export class Doc {
    clock;
    items = new ORSet();
    props = new LWWMap();
    texts = new Map();
    applied = new Set();
    pending = new Map();
    listeners = new Set();
    rejected = [];
    constructor(replica, physicalNow) {
        this.clock = new HLC(replica, physicalNow);
    }
    get replica() {
        return this.clock.replica;
    }
    itemIds() {
        return this.items.values();
    }
    hasItem(item) {
        return this.items.has(item);
    }
    prop(item, field) {
        return this.props.get(`${item}/${field}`);
    }
    text(item) {
        return this.texts.get(item)?.text() ?? "";
    }
    rga(item) {
        let r = this.texts.get(item);
        if (!r)
            this.texts.set(item, (r = new RGA()));
        return r;
    }
    get pendingCount() {
        return this.pending.size;
    }
    get appliedCount() {
        return this.applied.size;
    }
    onChange(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    createItem(item, fields, text = "") {
        const ops = [{ k: "add", id: this.clock.now(), item }];
        for (const [f, v] of Object.entries(fields))
            ops.push({ k: "set", id: this.clock.now(), key: `${item}/${f}`, v: v });
        if (text)
            ops.push({ k: "ins", id: this.clock.now(), item, after: ROOT, text: text.slice(0, MAX_TEXT) });
        return this.applyLocal(ops);
    }
    setProps(item, fields) {
        const ops = Object.entries(fields).map(([f, v]) => ({ k: "set", id: this.clock.now(), key: `${item}/${f}`, v }));
        return this.applyLocal(ops);
    }
    restoreItem(item) {
        if (this.items.has(item))
            return [];
        return this.applyLocal([{ k: "add", id: this.clock.now(), item }]);
    }
    touchItem(item) {
        if (!this.items.has(item))
            return [];
        return this.applyLocal([{ k: "add", id: this.clock.now(), item }]);
    }
    deleteItem(item) {
        const tags = this.items.liveTags(item);
        if (!tags.length)
            return [];
        return this.applyLocal([{ k: "rem", id: this.clock.now(), item, tags }]);
    }
    editText(item, next) {
        const rga = this.rga(item);
        const prev = Array.from(rga.text());
        let nxt = Array.from(next);
        if (nxt.length > MAX_TEXT)
            nxt = nxt.slice(0, MAX_TEXT);
        let start = 0;
        while (start < prev.length && start < nxt.length && prev[start] === nxt[start])
            start++;
        let endPrev = prev.length;
        let endNext = nxt.length;
        while (endPrev > start && endNext > start && prev[endPrev - 1] === nxt[endNext - 1]) {
            endPrev--;
            endNext--;
        }
        const ops = [];
        const ids = rga.visibleIds();
        if (endPrev > start)
            ops.push({ k: "del", id: this.clock.now(), item, targets: ids.slice(start, endPrev) });
        if (endNext > start) {
            ops.push({ k: "ins", id: this.clock.now(), item, after: rga.idBefore(start), text: nxt.slice(start, endNext).join("") });
        }
        return this.applyLocal(ops);
    }
    applyRemote(ops) {
        const change = { items: new Set(), texts: new Set() };
        let n = 0;
        for (const op of ops) {
            if (!isOp(op)) {
                this.rejected.push({ op: op, reason: "malformed op" });
                continue;
            }
            if (this.applied.has(op.id) || this.pending.has(op.id))
                continue;
            this.pending.set(op.id, op);
        }
        let progress = true;
        while (progress && this.pending.size) {
            progress = false;
            for (const op of [...this.pending.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
                if (!this.isReady(op))
                    continue;
                this.pending.delete(op.id);
                progress = true;
                try {
                    this.clock.receive(op.id);
                    this.effect(op, change);
                }
                catch (err) {
                    this.rejected.push({ op, reason: String(err.message ?? err) });
                    continue;
                }
                this.applied.add(op.id);
                n++;
            }
        }
        if (n)
            this.emit(change, "remote");
        return n;
    }
    isReady(op) {
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
    toState() {
        const texts = {};
        for (const k of [...this.texts.keys()].sort()) {
            const s = this.texts.get(k).toState();
            if (s.nodes.length)
                texts[k] = s;
        }
        return { items: this.items.toState(), props: this.props.toState(), texts };
    }
    merge(state) {
        const change = { items: new Set(), texts: new Set() };
        this.items.merge(state.items);
        for (const [el] of state.items.adds)
            change.items.add(el);
        this.props.merge(state.props);
        for (const key of Object.keys(state.props))
            change.items.add(key.split("/")[0]);
        for (const [item, s] of Object.entries(state.texts)) {
            this.rga(item).merge(s);
            change.texts.add(item);
        }
        let max = "";
        for (const [, tag] of state.items.adds)
            if (tag > max)
                max = tag;
        for (const [, ts] of Object.values(state.props))
            if (ts > max)
                max = ts;
        for (const s of Object.values(state.texts))
            for (const [id] of s.nodes) {
                const base = id.split(":")[0];
                if (base > max)
                    max = base;
            }
        if (max)
            this.clock.receive(max);
        this.applyRemote([]);
        this.emit(change, "remote");
    }
    hash() {
        return fnv1a(JSON.stringify(this.toState()));
    }
    applyLocal(ops) {
        const change = { items: new Set(), texts: new Set() };
        for (const op of ops) {
            this.effect(op, change);
            this.applied.add(op.id);
        }
        if (ops.length)
            this.emit(change, "local");
        return ops;
    }
    effect(op, change) {
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
    emit(change, source) {
        for (const fn of this.listeners)
            fn(change, source);
    }
}
const TS_RE = /^\d{13}\.[0-9a-z]{5}\.[A-Za-z0-9_-]{1,32}$/;
const ID_RE = /^\d{13}\.[0-9a-z]{5}\.[A-Za-z0-9_-]{1,32}(:[0-9a-z]{3})?$/;
const ITEM_RE = /^[A-Za-z0-9_-]{1,40}$/;
export function isOp(x) {
    if (!x || typeof x !== "object")
        return false;
    const o = x;
    if (typeof o.id !== "string" || !TS_RE.test(o.id))
        return false;
    switch (o.k) {
        case "add":
            return typeof o.item === "string" && ITEM_RE.test(o.item);
        case "rem":
            return typeof o.item === "string" && ITEM_RE.test(o.item) && Array.isArray(o.tags) && o.tags.length > 0 && o.tags.every((t) => typeof t === "string" && TS_RE.test(t));
        case "set": {
            if (typeof o.key !== "string")
                return false;
            const [item, field, extra] = o.key.split("/");
            return ITEM_RE.test(item ?? "") && extra === undefined && isFieldValue(field ?? "", o.v);
        }
        case "ins":
            return typeof o.item === "string" && ITEM_RE.test(o.item) && typeof o.after === "string" && (o.after === ROOT || ID_RE.test(o.after)) && typeof o.text === "string" && o.text.length > 0 && Array.from(o.text).length <= MAX_TEXT;
        case "del":
            return typeof o.item === "string" && ITEM_RE.test(o.item) && Array.isArray(o.targets) && o.targets.length > 0 && o.targets.length <= MAX_TEXT && o.targets.every((t) => typeof t === "string" && ID_RE.test(t));
        default:
            return false;
    }
}
const SRC_RE = /^[0-9a-f-]{36}\/[A-Za-z0-9_-]{6,64}\.(webp|jpe?g|png|gif|mp4|webm|mov)$/;
const STROKE_RE = /^\d{1,6},\d{1,6}:\d{1,6},\d{1,6},\d(;-?\d{1,6},-?\d{1,6},\d)*$/;
const COLOR_RE = /^[a-z]{2,12}$/;
export function isFieldValue(field, v) {
    if (v === null)
        return true;
    switch (field) {
        case "x":
        case "y":
        case "z":
            return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e7;
        case "w":
        case "h":
            return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e5;
        case "fs":
            return typeof v === "number" && Number.isFinite(v) && v >= 8 && v <= 240;
        case "r": // rotation in degrees
            return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 360;
        case "kind":
            return typeof v === "string" && ITEM_KINDS.includes(v);
        case "brush":
            return typeof v === "string" && BRUSHES.includes(v);
        case "color":
            return typeof v === "string" && COLOR_RE.test(v);
        case "src":
            return typeof v === "string" && (v === "" || SRC_RE.test(v));
        case "d":
            return typeof v === "string" && v.length <= MAX_STROKE && STROKE_RE.test(v);
        default:
            return false;
    }
}
export function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}
export { ROOT, runIds };
