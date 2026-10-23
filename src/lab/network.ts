/**
 * A deliberately hostile network for replicas living in one process.
 *
 * Messages can be delayed, reordered, duplicated, dropped (and later retried, i.e.
 * at-least-once delivery), and held back by network partitions until they heal.
 * The CRDT paper's claim is that none of this matters: once every replica has received
 * every op, they are in the same state. The test suite and the lab page both use this
 * to try to prove that claim wrong.
 */
import { Doc, type Op } from "../crdt/doc.js";
import { randomEdit, rng, type Rng } from "./random.js";

export interface NetworkOptions {
  minLatency: number;
  maxLatency: number;
  /** probability a message is lost and has to be resent later */
  drop: number;
  /** probability a message is delivered twice */
  duplicate: number;
}

export const DEFAULT_NETWORK: NetworkOptions = { minLatency: 20, maxLatency: 400, drop: 0.15, duplicate: 0.15 };

interface Message {
  seq: number;
  from: number;
  to: number;
  ops: Op[];
  sent: number;
  at: number;
}

export interface NetworkStats {
  sent: number;
  delivered: number;
  dropped: number;
  duplicated: number;
  held: number;
}

export class SimNetwork {
  readonly replicas: Doc[];
  private inflight: Message[] = [];
  private seq = 0;
  private cut = new Set<string>();
  now = 0;
  readonly stats: NetworkStats = { sent: 0, delivered: 0, dropped: 0, duplicated: 0, held: 0 };

  constructor(
    n: number,
    readonly r: Rng = rng(1),
    public opts: NetworkOptions = { ...DEFAULT_NETWORK },
    names = "ABCDEFGH",
  ) {
    // replicas share the simulated clock, so the HLC wall time moves with the simulation
    this.replicas = Array.from({ length: n }, (_, i) => new Doc(names[i], () => 1_700_000_000_000 + this.now));
  }

  // ---------------------------------------------------------------- partitions

  private key(a: number, b: number): string {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }

  isCut(a: number, b: number): boolean {
    return this.cut.has(this.key(a, b));
  }

  setLink(a: number, b: number, up: boolean): void {
    if (up) this.cut.delete(this.key(a, b));
    else this.cut.add(this.key(a, b));
  }

  /** Split replicas into two groups that cannot talk to each other. */
  partition(groupA: number[]): void {
    this.cut.clear();
    const a = new Set(groupA);
    for (let i = 0; i < this.replicas.length; i++)
      for (let j = i + 1; j < this.replicas.length; j++) if (a.has(i) !== a.has(j)) this.cut.add(this.key(i, j));
  }

  isolate(i: number): void {
    for (let j = 0; j < this.replicas.length; j++) if (j !== i) this.setLink(i, j, false);
  }

  heal(): void {
    this.cut.clear();
  }

  get partitioned(): boolean {
    return this.cut.size > 0;
  }

  // ---------------------------------------------------------------- traffic

  /** Broadcast ops made at replica `from` to every other replica. */
  broadcast(from: number, ops: Op[]): void {
    if (!ops.length) return;
    for (let to = 0; to < this.replicas.length; to++) if (to !== from) this.send(from, to, ops);
  }

  /** Make a random edit at replica `i` and broadcast it. */
  edit(i: number): Op[] {
    const ops = randomEdit(this.replicas[i], this.r);
    this.broadcast(i, ops);
    return ops;
  }

  private send(from: number, to: number, ops: Op[]): void {
    this.stats.sent++;
    const delay = this.opts.minLatency + this.r() * (this.opts.maxLatency - this.opts.minLatency);
    this.inflight.push({ seq: this.seq++, from, to, ops, sent: this.now, at: this.now + delay });
    if (this.r() < this.opts.duplicate) {
      this.stats.duplicated++;
      this.inflight.push({ seq: this.seq++, from, to, ops, sent: this.now, at: this.now + delay + this.r() * this.opts.maxLatency });
    }
  }

  /** Advance simulated time by `ms`, delivering whatever is due. Returns ops applied. */
  tick(ms: number): number {
    this.now += ms;
    let applied = 0;
    this.stats.held = 0;
    const due = this.inflight.filter((m) => m.at <= this.now).sort((a, b) => a.at - b.at || a.seq - b.seq);
    const keep = this.inflight.filter((m) => m.at > this.now);
    for (const m of due) {
      if (this.isCut(m.from, m.to)) {
        // partitioned: hold it and try again later
        m.sent = this.now;
        m.at = this.now + this.opts.maxLatency;
        keep.push(m);
        this.stats.held++;
        continue;
      }
      if (this.r() < this.opts.drop) {
        // lost: the sender's retry will deliver it again later (at-least-once delivery)
        this.stats.dropped++;
        m.sent = this.now;
        m.at = this.now + this.opts.maxLatency * (1 + this.r());
        keep.push(m);
        continue;
      }
      applied += this.replicas[m.to].applyRemote(m.ops);
      this.stats.delivered++;
    }
    this.inflight = keep;
    return applied;
  }

  /** Messages on the wire, for drawing: where each is and how far along. */
  messages(): { from: number; to: number; progress: number; blocked: boolean }[] {
    return this.inflight.map((m) => ({
      from: m.from,
      to: m.to,
      progress: Math.max(0, Math.min(1, (this.now - m.sent) / Math.max(1, m.at - m.sent))),
      blocked: this.isCut(m.from, m.to),
    }));
  }

  get inFlight(): number {
    return this.inflight.length;
  }

  /** Keep ticking until every message has been delivered. Requires the network to be healed. */
  drain(maxSteps = 100_000): void {
    let steps = 0;
    while (this.inflight.length) {
      if (++steps > maxSteps) throw new Error("Network did not drain (still partitioned?)");
      this.tick(this.opts.maxLatency);
    }
  }

  hashes(): string[] {
    return this.replicas.map((d) => d.hash());
  }

  converged(): boolean {
    const h = this.hashes();
    return h.every((x) => x === h[0]);
  }
}
