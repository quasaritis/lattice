// Generated from src/crdt by scripts/copy-crdt.mjs. Do not edit.
/**
 * RGA: Replicated Growable Array (Shapiro et al., Spec. 19), used for the text inside notes.
 *
 * Every character is a vertex with a unique, causally increasing id. Inserting means
 * "put this character right after vertex u". Deleting leaves a tombstone, so a concurrent
 * insert next to a deleted character still has an anchor.
 *
 * We store it in the tree form: each vertex is a child of the vertex it was inserted after.
 * Document order is a pre-order walk where siblings go newest-first. This gives exactly the
 * paper's rule ("two inserts at the same position are ordered in opposite order of their
 * timestamps") and one more property people care about in an editor: two people typing
 * at the same spot never get their words interleaved letter by letter.
 *
 * Because the order is a pure function of the vertex set, state-based merge is just set
 * union of vertices and of tombstones, which is trivially a join-semilattice.
 *
 * Vertex ids for a run of typed characters share one HLC timestamp: the first character
 * gets `ts`, later ones `ts:001`, `ts:002`, ... These sort after `ts` and before any later
 * timestamp, so ids stay unique and consistent with causality while one op carries a
 * whole run of text.
 */
export const ROOT = "";
/** Fixed-width so string order matches numeric order (":00a" < ":010"). 36^3 > MAX_TEXT. */
export function runIds(baseId, length) {
    const ids = [baseId];
    for (let i = 1; i < length; i++)
        ids.push(`${baseId}:${i.toString(36).padStart(3, "0")}`);
    return ids;
}
export class RGA {
    vertices = new Map();
    children = new Map(); // kept sorted newest-first
    order = []; // all ids in document order, incl. tombstones; null = stale
    visibleCache = { ids: [], text: "" };
    has(id) {
        return id === ROOT || this.vertices.has(id);
    }
    get size() {
        return this.vertices.size;
    }
    /**
     * Downstream insert of a run of characters after `after`.
     * Precondition: `after` exists (causal delivery). Idempotent.
     * Returns true if anything changed.
     */
    insert(baseId, after, text) {
        if (!this.has(after))
            throw new Error(`Insert after unknown vertex ${after}`);
        const chars = Array.from(text);
        const ids = runIds(baseId, chars.length);
        let parent = after;
        let changed = false;
        for (let i = 0; i < chars.length; i++) {
            const id = ids[i];
            if (!this.vertices.has(id)) {
                this.addVertex({ id, after: parent, ch: chars[i], deleted: false });
                changed = true;
            }
            parent = id;
        }
        return changed;
    }
    /** Downstream delete. Precondition: the vertices exist. Idempotent. */
    delete(ids) {
        let changed = false;
        for (const id of ids) {
            const v = this.vertices.get(id);
            if (!v)
                throw new Error(`Delete of unknown vertex ${id}`);
            if (!v.deleted) {
                v.deleted = true;
                changed = true;
            }
        }
        if (changed)
            this.visibleCache = null;
        return changed;
    }
    text() {
        return this.visible().text;
    }
    /** Ids of the visible characters, in order. */
    visibleIds() {
        return this.visible().ids;
    }
    /** Id of the visible character just before `index` (ROOT for index 0). */
    idBefore(index) {
        if (index <= 0)
            return ROOT;
        const ids = this.visible().ids;
        return ids[Math.min(index, ids.length) - 1];
    }
    /**
     * Visible index just after the vertex `id`, even if it has since been deleted.
     * Used to keep a caret anchored to "after this character" while remote edits land.
     */
    indexAfter(id) {
        if (id === ROOT)
            return 0;
        if (!this.vertices.has(id))
            return 0;
        const order = this.fullOrder();
        let visible = 0;
        for (const cur of order) {
            if (!this.vertices.get(cur).deleted)
                visible++;
            if (cur === id)
                return visible;
        }
        return visible;
    }
    toState() {
        const nodes = [];
        const tomb = [];
        for (const v of this.vertices.values()) {
            nodes.push([v.id, v.after, v.ch]);
            if (v.deleted)
                tomb.push(v.id);
        }
        nodes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        tomb.sort();
        return { nodes, tomb };
    }
    merge(state) {
        // Sorted by id, and a child's id is always larger than its parent's, so parents arrive first.
        const pending = [...state.nodes].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        for (const [id, after, ch] of pending) {
            const existing = this.vertices.get(id);
            if (existing) {
                if (existing.after !== after || existing.ch !== ch)
                    throw new Error(`Conflicting definitions of vertex ${id}`);
                continue;
            }
            if (!this.has(after))
                throw new Error(`State has vertex ${id} whose parent ${after} is missing`);
            this.addVertex({ id, after, ch, deleted: false });
        }
        this.delete(state.tomb);
    }
    addVertex(v) {
        if (v.after !== ROOT && !(v.id > v.after))
            throw new Error(`Vertex ${v.id} is not newer than its anchor ${v.after}`);
        this.vertices.set(v.id, v);
        let sibs = this.children.get(v.after);
        if (!sibs)
            this.children.set(v.after, (sibs = []));
        // newest first: find the first sibling older than v
        let i = 0;
        while (i < sibs.length && sibs[i] > v.id)
            i++;
        sibs.splice(i, 0, v.id);
        this.order = null;
        this.visibleCache = null;
    }
    fullOrder() {
        if (this.order)
            return this.order;
        const out = [];
        // iterative pre-order walk (text can be long; avoid deep recursion)
        const stack = [...(this.children.get(ROOT) ?? [])].reverse();
        while (stack.length) {
            const id = stack.pop();
            out.push(id);
            const kids = this.children.get(id);
            if (kids)
                for (let i = kids.length - 1; i >= 0; i--)
                    stack.push(kids[i]);
        }
        this.order = out;
        return out;
    }
    visible() {
        if (this.visibleCache)
            return this.visibleCache;
        const ids = [];
        let text = "";
        for (const id of this.fullOrder()) {
            const v = this.vertices.get(id);
            if (!v.deleted) {
                ids.push(id);
                text += v.ch;
            }
        }
        this.visibleCache = { ids, text };
        return this.visibleCache;
    }
}