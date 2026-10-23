// Generated from src/crdt by scripts/copy-crdt.mjs. Do not edit.
/**
 * Hybrid Logical Clock (Kulkarni et al., 2014).
 *
 * The CRDT paper (Shapiro et al., 2011) needs timestamps that are
 *   1. unique,
 *   2. totally ordered, and
 *   3. consistent with causality (if a happened-before b, then ts(a) < ts(b)).
 *
 * A Lamport clock gives (1)-(3) but drifts away from real time; wall clocks are
 * close to real time but break (3) when machines disagree. An HLC gives both:
 * it stays within clock skew of physical time and never goes backwards.
 *
 * Encoded as a fixed-width string so plain string comparison is the total order:
 *   <wall ms, 13 digits>.<counter, 5 base-36 digits>.<replica id>
 */
const WALL_WIDTH = 13;
const COUNTER_WIDTH = 5;
const MAX_COUNTER = 36 ** COUNTER_WIDTH - 1;
/** Refuse remote clocks more than this far ahead of ours, so one bad peer cannot drag everyone into the future. */
export const MAX_DRIFT_MS = 60 * 60 * 1000;
export function encode(wall, counter, replica) {
    return `${String(wall).padStart(WALL_WIDTH, "0")}.${counter.toString(36).padStart(COUNTER_WIDTH, "0")}.${replica}`;
}
export function parse(ts) {
    const a = ts.indexOf(".");
    const b = ts.indexOf(".", a + 1);
    if (a !== WALL_WIDTH || b !== a + 1 + COUNTER_WIDTH)
        throw new Error(`Bad timestamp: ${ts}`);
    return { wall: Number(ts.slice(0, a)), counter: parseInt(ts.slice(a + 1, b), 36), replica: ts.slice(b + 1) };
}
export function compare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
export class HLC {
    replica;
    physicalNow;
    wall = 0;
    counter = 0;
    constructor(replica, physicalNow = () => Date.now()) {
        this.replica = replica;
        this.physicalNow = physicalNow;
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(replica))
            throw new Error("Replica id must be 1-32 url-safe characters");
    }
    /** Physical time in whole milliseconds (performance-style clocks can be fractional). */
    pt() {
        return Math.floor(this.physicalNow());
    }
    /** Timestamp for a new local event. */
    now() {
        const pt = this.pt();
        if (pt > this.wall) {
            this.wall = pt;
            this.counter = 0;
        }
        else {
            this.counter++;
        }
        this.checkCounter();
        return encode(this.wall, this.counter, this.replica);
    }
    /** Merge a timestamp seen on a remote event, so every later local event is ordered after it. */
    receive(remote) {
        const r = parse(remote);
        const pt = this.pt();
        if (r.wall - pt > MAX_DRIFT_MS)
            throw new Error(`Remote clock is too far ahead (${r.wall - pt} ms)`);
        const wall = Math.max(this.wall, r.wall, pt);
        if (wall === this.wall && wall === r.wall)
            this.counter = Math.max(this.counter, r.counter) + 1;
        else if (wall === this.wall)
            this.counter++;
        else if (wall === r.wall)
            this.counter = r.counter + 1;
        else
            this.counter = 0;
        this.wall = wall;
        this.checkCounter();
    }
    /** Latest timestamp this clock has produced or seen (without advancing it). */
    peek() {
        return encode(this.wall, this.counter, this.replica);
    }
    checkCounter() {
        if (this.counter > MAX_COUNTER)
            throw new Error("HLC counter overflow");
    }
}