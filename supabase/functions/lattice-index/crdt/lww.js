// Generated from src/crdt by scripts/copy-crdt.mjs. Do not edit.
export class LWWMap {
    entries = new Map();
    get(key) {
        return this.entries.get(key)?.value;
    }
    timestamp(key) {
        return this.entries.get(key)?.ts;
    }
    /** Apply an assignment. Returns true if it changed the visible value. */
    set(key, value, ts) {
        const cur = this.entries.get(key);
        if (cur && cur.ts >= ts)
            return false;
        this.entries.set(key, { value, ts });
        return true;
    }
    keys() {
        return this.entries.keys();
    }
    toState() {
        const out = {};
        for (const k of [...this.entries.keys()].sort()) {
            const e = this.entries.get(k);
            out[k] = [e.value, e.ts];
        }
        return out;
    }
    /** Join another replica's state into this one. */
    merge(state) {
        for (const [k, [value, ts]] of Object.entries(state))
            this.set(k, value, ts);
    }
}