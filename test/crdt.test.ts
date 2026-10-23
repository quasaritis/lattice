/** Unit tests: each data type behaves the way the paper specifies. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HLC, compare, parse } from "../src/crdt/hlc.js";
import { LWWMap } from "../src/crdt/lww.js";
import { ORSet } from "../src/crdt/orset.js";
import { RGA, ROOT } from "../src/crdt/rga.js";
import { Doc, isFieldValue, isOp } from "../src/crdt/doc.js";
import { decodeStroke, encodeStroke, outlinePath } from "../src/draw/stroke.js";

// ------------------------------------------------------------------ HLC

test("HLC: timestamps strictly increase even when the wall clock stands still or goes back", () => {
  let wall = 1_000;
  const c = new HLC("a", () => wall);
  let prev = c.now();
  for (let i = 0; i < 5000; i++) {
    if (i % 7 === 0) wall -= 3; // clock jumps backwards
    if (i % 11 === 0) wall += 5;
    const t = c.now();
    assert.equal(compare(prev, t), -1, `${prev} !< ${t}`);
    prev = t;
  }
});

test("HLC: after receiving a remote timestamp, every local event is ordered after it (causality)", () => {
  const a = new HLC("a", () => 1_000);
  const b = new HLC("b", () => 5_000); // b's clock is 4s ahead
  const tb = b.now();
  a.receive(tb);
  const ta = a.now();
  assert.ok(ta > tb);
  assert.equal(parse(ta).replica, "a");
});

test("HLC: fractional physical clocks still give valid timestamps (regression: lab demo dropped every op)", () => {
  let t = 1_700_000_000_000.25;
  const a = new Doc("a", () => (t += 16.6667));
  const b = new Doc("b", () => (t += 16.6667));
  const ops = a.createItem("n", { kind: "note" }, "hello");
  for (const op of ops) assert.ok(isOp(op), op.id);
  assert.equal(b.applyRemote(ops), ops.length);
  assert.equal(b.text("n"), "hello");
});

test("HLC: refuses timestamps far in the future", () => {
  const a = new HLC("a", () => 1_000);
  const evil = new HLC("x", () => 1_000 + 10 * 60 * 60 * 1000);
  assert.throws(() => a.receive(evil.now()), /too far ahead/);
});

// ------------------------------------------------------------------ LWW

test("LWW-Map: concurrent writes converge to the highest timestamp, in any order", () => {
  const m1 = new LWWMap();
  const m2 = new LWWMap();
  const w = [["k", "red", "0000000000001.00000.a"], ["k", "blue", "0000000000001.00000.b"], ["k", "green", "0000000000000.00009.c"]] as const;
  for (const [k, v, t] of w) m1.set(k, v, t);
  for (const [k, v, t] of [...w].reverse()) m2.set(k, v, t);
  assert.equal(m1.get("k"), "blue");
  assert.deepEqual(m1.toState(), m2.toState());
});

// ------------------------------------------------------------------ OR-Set

test("OR-Set: a concurrent add beats a remove that never saw it (add-wins)", () => {
  const a = new ORSet();
  const b = new ORSet();
  a.add("note", "t1");
  b.add("note", "t1");
  // a removes what it has seen; meanwhile b re-adds with a fresh tag
  const seen = a.liveTags("note");
  a.remove("note", seen);
  b.add("note", "t2");
  // exchange
  a.add("note", "t2");
  b.remove("note", seen);
  assert.equal(a.has("note"), true);
  assert.equal(b.has("note"), true);
  assert.deepEqual(a.toState(), b.toState());
});

test("OR-Set: remove of everything observed deletes the element everywhere", () => {
  const a = new ORSet();
  a.add("x", "t1");
  a.add("x", "t2");
  a.remove("x", a.liveTags("x"));
  assert.equal(a.has("x"), false);
  assert.deepEqual(a.values(), []);
});

// ------------------------------------------------------------------ RGA

const T = (n: number, r = "a") => `${String(n).padStart(13, "0")}.00000.${r}`;

test("RGA: concurrent inserts at the same spot: newer goes first, same result in any order", () => {
  const ops: [string, string, string][] = [[T(1), ROOT, "a"], [T(3, "x"), T(1), "X"], [T(2, "y"), T(1), "Y"]];
  const r1 = new RGA();
  const r2 = new RGA();
  for (const [id, after, ch] of ops) r1.insert(id, after, ch);
  for (const [id, after, ch] of [ops[0], ops[2], ops[1]]) r2.insert(id, after, ch);
  assert.equal(r1.text(), "aXY");
  assert.equal(r2.text(), "aXY");
});

test("RGA: two people typing at the same spot do not interleave letter by letter", () => {
  const a = new Doc("a", () => 1000);
  const b = new Doc("b", () => 1000);
  const base = a.createItem("n1", { kind: "note" }, "Hi ");
  b.applyRemote(base);
  const oa = a.editText("n1", "Hi alice");
  const ob = b.editText("n1", "Hi bob");
  a.applyRemote(ob);
  b.applyRemote(oa);
  assert.equal(a.text("n1"), b.text("n1"));
  assert.ok(["Hi alicebob", "Hi bobalice"].includes(a.text("n1")), a.text("n1"));
});

test("RGA: deleted characters stay as anchors for concurrent inserts (tombstones)", () => {
  const a = new Doc("a", () => 1000);
  const b = new Doc("b", () => 1000);
  b.applyRemote(a.createItem("n", { kind: "note" }, "cat"));
  const del = a.editText("n", "ct"); // a deletes "a"
  const ins = b.editText("n", "cart"); // b types "r" after the "a" a just deleted
  a.applyRemote(ins);
  b.applyRemote(del);
  assert.equal(a.text("n"), "crt");
  assert.equal(b.text("n"), "crt");
});

test("RGA: a long typed run keeps its order (regression: run ids ':10' once sorted before ':9')", () => {
  const a = new Doc("a", () => 1000);
  const text = "the quick brown fox jumps over the lazy dog, then merges without conflicts";
  const ops = a.createItem("n", { kind: "note" }, text);
  const b = new Doc("b", () => 1000);
  b.applyRemote(ops);
  assert.equal(a.text("n"), text);
  assert.equal(b.text("n"), text);
  b.applyRemote(a.editText("n", text.replace("lazy", "very lazy")));
  assert.equal(b.text("n"), text.replace("lazy", "very lazy"));
});

test("RGA: emoji and other multi-unit characters stay whole", () => {
  const a = new Doc("a", () => 1000);
  a.createItem("n", { kind: "note" }, "go 🚦 now");
  a.editText("n", "go 🚦🚗 now");
  assert.equal(a.text("n"), "go 🚦🚗 now");
  a.editText("n", "go 🚗 now");
  assert.equal(a.text("n"), "go 🚗 now");
});

// ------------------------------------------------------------------ Doc

test("Doc: ops that arrive before their dependencies wait, then apply", () => {
  const a = new Doc("a", () => 1000);
  const b = new Doc("b", () => 1000);
  const o1 = a.createItem("n", { kind: "note", x: 1 }, "hello");
  const o2 = a.editText("n", "hello world");
  const o3 = a.deleteItem("n");
  assert.equal(b.applyRemote([...o3, ...o2]), 0, "nothing can apply yet");
  assert.equal(b.pendingCount, o3.length + o2.length);
  b.applyRemote(o1);
  assert.equal(b.pendingCount, 0);
  assert.equal(b.hash(), a.hash());
  assert.equal(b.hasItem("n"), false);
});

test("Doc: applying the same op many times changes nothing (idempotence)", () => {
  const a = new Doc("a", () => 1000);
  const b = new Doc("b", () => 1000);
  const ops = [...a.createItem("n", { kind: "note" }, "x"), ...a.editText("n", "xyz")];
  b.applyRemote(ops);
  const h = b.hash();
  for (let i = 0; i < 5; i++) b.applyRemote(ops);
  assert.equal(b.hash(), h);
});

test("Doc: snapshot (state) + later ops equals receiving every op", () => {
  const a = new Doc("a", () => 1000);
  const early = [...a.createItem("n", { kind: "note", color: "sun" }, "draft"), ...a.createItem("m", { kind: "rect" })];
  const snap = a.toState();
  const late = [...a.editText("n", "final draft"), ...a.deleteItem("m"), ...a.setProps("n", { color: "mint" })];
  const viaOps = new Doc("b", () => 1000);
  viaOps.applyRemote([...early, ...late]);
  const viaSnap = new Doc("c", () => 1000);
  viaSnap.merge(JSON.parse(JSON.stringify(snap)));
  viaSnap.applyRemote([...early, ...late]); // overlapping ops are harmless
  assert.equal(viaSnap.hash(), viaOps.hash());
  assert.equal(viaSnap.text("n"), "final draft");
});

test("Doc: hostile ops are rejected or dropped without breaking the replica", () => {
  const a = new Doc("a", () => 1000);
  assert.equal(isOp({ k: "set", id: T(1), key: "n/__proto__", v: 1 }), false);
  assert.equal(isOp({ k: "set", id: T(1), key: "n/x", v: { big: "object" } }), false);
  assert.equal(isOp({ k: "ins", id: "not-a-ts", item: "n", after: "", text: "x" }), false);
  // anchor newer than the insert itself: violates causality, must be dropped
  a.applyRemote([{ k: "ins", id: T(5), item: "n", after: "", text: "a" }]);
  a.applyRemote([{ k: "ins", id: T(2, "z"), item: "n", after: T(5), text: "b" }]);
  assert.equal(a.text("n"), "a");
  assert.equal(a.rejected.length, 1);
});

// ------------------------------------------------------------------ strokes, images, undo


test("Strokes: encode → decode keeps the shape to half a pixel, and validates as a field", () => {
  const pts = Array.from({ length: 200 }, (_, i) => ({ x: 100 + Math.cos(i / 15) * 80, y: 300 + Math.sin(i / 9) * 40, p: (i % 10) / 9 }));
  const s = encodeStroke(pts, 4);
  assert.ok(isFieldValue("d", s.d), s.d.slice(0, 80));
  const back = decodeStroke(s.d)!;
  assert.equal(back.w, s.w);
  for (const q of back.pts) {
    const nearest = Math.min(...pts.map((p) => Math.hypot(p.x - (q.x + s.x), p.y - (q.y + s.y))));
    assert.ok(nearest <= 0.75, `point drifted ${nearest}`);
  }
  assert.ok(outlinePath(back.pts, 3, true).startsWith("M"));
});

test("Fields: images only point at board storage paths, strokes only carry numbers", () => {
  assert.equal(isFieldValue("src", "6515f0ca-a450-4878-891e-61bebecc0957/k3j2h1g9.webp"), true);
  assert.equal(isFieldValue("src", "https://evil.example/x.png"), false);
  assert.equal(isFieldValue("src", "../../etc/passwd"), false);
  assert.equal(isFieldValue("d", "10,10:0,0,5;<script>"), false);
  assert.equal(isFieldValue("fs", 40), true);
  assert.equal(isFieldValue("fs", 2), false);
  assert.equal(isFieldValue("fs", "40px"), false);
  assert.equal(isFieldValue("kind", "iframe"), false);
  assert.equal(isFieldValue("color", "url(javascript:x)"), false);
  assert.equal(isFieldValue("brush", "hl"), true);
});

test("Undo of a delete brings the item back with its props and text", () => {
  const a = new Doc("a", () => 1000);
  const b = new Doc("b", () => 1000);
  b.applyRemote(a.createItem("n", { kind: "note", color: "mint", x: 40 }, "keep me"));
  b.applyRemote(a.deleteItem("n"));
  assert.equal(b.hasItem("n"), false);
  b.applyRemote(a.restoreItem("n"));
  assert.equal(b.hasItem("n"), true);
  assert.equal(b.text("n"), "keep me");
  assert.equal(b.prop("n", "color"), "mint");
  assert.equal(b.hash(), a.hash());
});

test("Editing wins over a concurrent delete (edits re-assert the item with a fresh tag)", () => {
  const a = new Doc("a", () => 1000);
  const b = new Doc("b", () => 1000);
  b.applyRemote(a.createItem("n", { kind: "note" }, "old idea"));
  // offline: a deletes the note while b keeps working on it
  const del = a.deleteItem("n");
  const edit = [...b.touchItem("n"), ...b.editText("n", "better idea")];
  a.applyRemote(edit);
  b.applyRemote(del);
  assert.equal(a.hasItem("n"), true);
  assert.equal(b.hasItem("n"), true);
  assert.equal(a.text("n"), "better idea");
  assert.equal(a.hash(), b.hash());
});
