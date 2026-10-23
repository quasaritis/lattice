# Lattice

**A real-time collaborative whiteboard where edits can't conflict.**
Two people can edit the same note at the same time, offline, in any order, and every copy of the board still ends up identical.

Built from scratch on the CRDT paper, with no CRDT library and zero runtime dependencies:

> Marc Shapiro, Nuno Preguiça, Carlos Baquero, Marek Zawirski. **Conflict-free Replicated Data Types.** 13th International Symposium on Stabilization, Safety, and Security of Distributed Systems (SSS 2011), LNCS 6976, pp. 386–400. Springer. Extended version: *A comprehensive study of Convergent and Commutative Replicated Data Types*, INRIA RR-7506, 2011.

**Live:** https://quasarboard.vercel.app · **Lab (break the network yourself):** https://quasarboard.vercel.app/lab

---

## The idea in one paragraph

Most collaborative apps send every edit to a server, and the server decides who wins. That breaks when you're offline, and "last save wins" silently throws work away. A **CRDT** (Conflict-free Replicated Data Type) is a data structure designed so that replicas can be edited independently and then merged *in any order*, always reaching the same result. The paper calls this **strong eventual consistency**: any two replicas that have received the same set of updates are in the same state. No locks, no leader, no conflict dialogs.

## What's in it

| Board feature | CRDT (paper section) | Why that one |
|---|---|---|
| Which notes exist | **OR-Set**, Observed-Remove Set (Spec. 15) | A delete only removes the copies the deleter has *seen*. If someone edits a note while you delete it offline, their edit survives ("add wins"). |
| Position, size, colour, z-order | **LWW-Map** of Last-Writer-Wins registers (Spec. 8–9) | Each field carries a timestamp; the highest wins. Concurrent drags converge without a server. |
| Text inside notes | **RGA**, Replicated Growable Array (Spec. 19) | Every character has a unique id and an anchor ("typed after X"). Deleted characters stay as tombstones so concurrent inserts still have an anchor. Two people typing at the same spot never interleave letter by letter. |
| Timestamps | **Hybrid Logical Clock** (Kulkarni et al., 2014) | The paper needs timestamps that are unique, totally ordered and consistent with causality. HLCs give that while staying close to wall-clock time. |

The document works **both** ways the paper describes:

- **Op-based (CmRDT):** each edit produces a small op that is broadcast. Ops that arrive before the ops they depend on wait in a causal buffer. Applying an op twice does nothing, so the network may duplicate, reorder and retry freely.
- **State-based (CvRDT):** the whole state forms a join-semilattice. `merge()` is commutative, associative and idempotent. Used for snapshots: a new client loads one snapshot plus the ops after it.

## Architecture

```
 Browser A (full replica)                       Browser B (full replica)
   │  edit → ops                                        ▲
   ├──── Supabase Realtime broadcast (~50 ms, best effort) ───┤
   │                                                    │
   └── push ──▶  Postgres op log (append-only, de-duplicated)  ──▶ pull (anti-entropy, every 8 s)
                 + snapshots every 300 ops (CvRDT state)
```

- **The server never merges anything.** It's a reliable, de-duplicated mailbox. All conflict resolution happens in the browsers.
- **Offline first.** The board and any unsent edits are cached in `localStorage`. Hit *Go offline*, keep editing, reconnect: queued ops are pushed and missed ops pulled.
- **Hand-written Realtime client.** `src/sync/realtime.ts` speaks the Phoenix channel protocol directly (join, broadcast, presence, heartbeats, reconnect with backoff), no SDK.
- **Locked-down database.** Tables live in a private `lattice` schema the REST API can't see. Browsers can only call six `public.lattice_*` functions, which validate input and enforce size and rate limits (`supabase/migrations`).

## Proof: tests that try to break the theorem

```
npm test           # 20 tests, 300 random schedules per property
npm run test:long  # 3,000 random schedules per property (what CI runs)
```

`test/properties.test.ts` checks the paper's guarantees on thousands of random histories, each reproducible from its seed:

- **Strong eventual consistency:** 2–5 replicas edit randomly over a simulated network (`src/lab/network.ts`) that delays, reorders, loses (and resends), duplicates and partitions messages. After healing, every replica must be identical.
- **Merge is a join:** `merge` is commutative, associative and idempotent on random diverged states.
- **Op-based ≡ state-based:** applying every op in shuffled order gives the same state as joining every replica's state.
- **Worst case:** every op delivered one at a time in reverse order.

The property tests found two real bugs during development, both now regression tests:
1. Character ids in a typed run were suffixed `:9`, `:10`… and `":10" < ":9"` as strings, which broke ordering for words longer than 10 letters. Fixed with fixed-width suffixes.
2. A fractional physical clock (from `requestAnimationFrame`) produced malformed timestamps that receivers rejected. The HLC now floors physical time.

## The split-brain lab

`/lab` runs three replicas in your browser joined by the same simulated network the tests use. Click a wire to cut it, push packet loss to 60%, type into different copies, reconnect, and watch every copy land on the same text and the same state fingerprint.

## Running it

```
npm install
npm run dev        # builds and serves on http://localhost:5173
```

No framework and no bundler: TypeScript compiles straight to ES modules the browser loads.

```
src/crdt/   hlc.ts lww.ts orset.ts rga.ts doc.ts   the CRDTs (no DOM, no network)
src/sync/   api.ts realtime.ts session.ts          Postgres RPCs, Realtime client, sync orchestration
src/lab/    network.ts random.ts                    simulated hostile network + random editor
src/app/    board.ts labview.ts landing.ts ui.ts    the UI
test/                                               unit + property tests (node:test)
supabase/migrations/                                schema, RPCs, limits
```

## Limits and honest notes

- Boards are public to anyone with the link (no accounts). Snapshots are written by clients and trusted on load; a production system would verify or compute them server-side.
- Tombstones are kept forever, as in the paper. Garbage-collecting them safely needs causal stability tracking, which is future work.
- Text is per note, up to 2,000 characters.

## License

MIT
