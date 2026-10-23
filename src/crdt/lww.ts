/**
 * LWW-Map: a map of Last-Writer-Wins registers (Shapiro et al., Spec. 8 & 9).
 *
 * Each key holds (value, timestamp). An update wins only if its timestamp is larger,
 * so concurrent assignments commute: whichever arrives first, the highest timestamp
 * survives. Timestamps are HLC strings, which are unique, so there are never ties.
 *
 * State-based merge takes the per-key maximum, which is a join on the product
 * lattice of (timestamp-ordered) registers: commutative, associative, idempotent.
 */
import type { Timestamp } from "./hlc.js";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface LWWEntry {
  value: Json;
  ts: Timestamp;
}

export type LWWState = Record<string, [Json, Timestamp]>;

export class LWWMap {
  private entries = new Map<string, LWWEntry>();

  get(key: string): Json | undefined {
    return this.entries.get(key)?.value;
  }

  timestamp(key: string): Timestamp | undefined {
    return this.entries.get(key)?.ts;
  }

  /** Apply an assignment. Returns true if it changed the visible value. */
  set(key: string, value: Json, ts: Timestamp): boolean {
    const cur = this.entries.get(key);
    if (cur && cur.ts >= ts) return false;
    this.entries.set(key, { value, ts });
    return true;
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  toState(): LWWState {
    const out: LWWState = {};
    for (const k of [...this.entries.keys()].sort()) {
      const e = this.entries.get(k)!;
      out[k] = [e.value, e.ts];
    }
    return out;
  }

  /** Join another replica's state into this one. */
  merge(state: LWWState): void {
    for (const [k, [value, ts]] of Object.entries(state)) this.set(k, value, ts);
  }
}
