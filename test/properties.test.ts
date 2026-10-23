/**
 * Property-based tests: the theorems of the CRDT paper, checked on thousands of random
 * histories. Every case is reproducible from its seed; a failure prints the seed.
 *
 *   Strong eventual consistency (Thm 2.2): replicas that received the same ops are
 *     equal, whatever the order, duplication, loss or partitioning on the way.
 *   State-based merge is a join: commutative, associative, idempotent (Sec. 2.3.1).
 *   Op-based and state-based replication agree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Doc, type Op } from "../src/crdt/doc.js";
import { SimNetwork } from "../src/lab/network.js";
import { int, randomEdit, rng, type Rng } from "../src/lab/random.js";

const SEEDS = Number(process.env.SEEDS ?? 300);

function seeds(): number[] {
  return Array.from({ length: SEEDS }, (_, i) => i + 1);
}

test(`strong eventual consistency over ${SEEDS} hostile network schedules`, () => {
  let totalOps = 0;
  for (const seed of seeds()) {
    const r = rng(seed);
    const n = int(r, 2, 5);
    const net = new SimNetwork(n, r, { minLatency: 1, maxLatency: int(r, 5, 300), drop: r() * 0.4, duplicate: r() * 0.4 });
    const steps = int(r, 20, 120);
    for (let s = 0; s < steps; s++) {
      const roll = r();
      if (roll < 0.06) net.partition(Array.from({ length: n }, (_, i) => i).filter(() => r() < 0.5));
      else if (roll < 0.1) net.heal();
      else if (roll < 0.13) net.isolate(int(r, 0, n - 1));
      totalOps += net.edit(int(r, 0, n - 1)).length;
      net.tick(int(r, 0, 120));
    }
    net.heal();
    net.drain();
    const hashes = net.hashes();
    assert.ok(net.converged(), `seed ${seed}: replicas diverged ${hashes.join(" ")}`);
    for (const d of net.replicas) assert.equal(d.pendingCount, 0, `seed ${seed}: ops stuck in causal buffer`);
    // the visible board is the same too
    const view = (d: Doc) => JSON.stringify(d.itemIds().map((i) => [i, d.prop(i, "x"), d.prop(i, "color"), d.text(i)]));
    for (const d of net.replicas) assert.equal(view(d), view(net.replicas[0]), `seed ${seed}`);
  }
  assert.ok(totalOps > SEEDS * 50, "fuzzer should generate plenty of ops");
});

/** Build a replica's history: a shared starting point, then independent offline edits. */
function divergedReplicas(r: Rng, n: number): { docs: Doc[]; allOps: Op[] } {
  const docs = Array.from({ length: n }, (_, i) => new Doc(`r${i}`, () => 1_700_000_000_000 + Math.floor(r() * 1000)));
  const shared: Op[] = [];
  for (let i = 0; i < int(r, 0, 15); i++) shared.push(...randomEdit(docs[0], r));
  for (const d of docs.slice(1)) d.applyRemote(shared);
  const allOps = [...shared];
  for (const d of docs) for (let i = 0; i < int(r, 0, 25); i++) allOps.push(...randomEdit(d, r));
  return { docs, allOps };
}

function joined(...states: ReturnType<Doc["toState"]>[]): string {
  const d = new Doc("m", () => 1_700_000_000_000);
  for (const s of states) d.merge(JSON.parse(JSON.stringify(s)));
  return d.hash();
}

test(`state merge is commutative, associative and idempotent (${SEEDS} cases)`, () => {
  for (const seed of seeds()) {
    const r = rng(seed * 7919);
    const { docs } = divergedReplicas(r, 3);
    const [a, b, c] = docs.map((d) => d.toState());
    assert.equal(joined(a, b), joined(b, a), `seed ${seed}: not commutative`);
    assert.equal(joined(joined0(a, b), c), joined(a, joined0(b, c)), `seed ${seed}: not associative`);
    assert.equal(joined(a, a), joined(a), `seed ${seed}: not idempotent`);
  }
});

/** merge two states and return the resulting state (for nesting) */
function joined0(...states: ReturnType<Doc["toState"]>[]): ReturnType<Doc["toState"]> {
  const d = new Doc("m", () => 1_700_000_000_000);
  for (const s of states) d.merge(JSON.parse(JSON.stringify(s)));
  return d.toState();
}

test(`op-based and state-based replication agree (${SEEDS} cases)`, () => {
  for (const seed of seeds()) {
    const r = rng(seed * 104729);
    const { docs, allOps } = divergedReplicas(r, 3);
    // op-based: one replica receives every op, shuffled
    const shuffled = [...allOps].sort(() => r() - 0.5);
    const viaOps = new Doc("o", () => 1_700_000_000_000);
    viaOps.applyRemote(shuffled);
    assert.equal(viaOps.pendingCount, 0, `seed ${seed}`);
    // state-based: join every replica's state
    assert.equal(viaOps.hash(), joined(...docs.map((d) => d.toState())), `seed ${seed}`);
  }
});

test("worst case: every op delivered one at a time in reverse order", () => {
  const r = rng(42);
  const a = new Doc("a", () => 1_700_000_000_000);
  const ops: Op[] = [];
  for (let i = 0; i < 400; i++) ops.push(...randomEdit(a, r));
  const b = new Doc("b", () => 1_700_000_000_000);
  for (const op of [...ops].reverse()) b.applyRemote([op]);
  assert.equal(b.pendingCount, 0);
  assert.equal(b.hash(), a.hash());
});
