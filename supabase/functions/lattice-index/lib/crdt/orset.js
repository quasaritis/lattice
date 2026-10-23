// Generated from src/crdt/orset.ts by scripts/copy-crdt.mjs. Do not edit.
export class ORSet {
    tags = new Map();
    tagOwner = new Map();
    removed = new Set();
    has(element) {
        const t = this.tags.get(element);
        if (!t)
            return false;
        for (const tag of t)
            if (!this.removed.has(tag))
                return true;
        return false;
    }
    values() {
        return [...this.tags.keys()].filter((e) => this.has(e)).sort();
    }
    hasTag(tag) {
        return this.tagOwner.has(tag);
    }
    liveTags(element) {
        return [...(this.tags.get(element) ?? [])].filter((t) => !this.removed.has(t)).sort();
    }
    add(element, tag) {
        const owner = this.tagOwner.get(tag);
        if (owner !== undefined) {
            if (owner !== element)
                throw new Error(`Tag ${tag} already belongs to ${owner}`);
            return false;
        }
        const was = this.has(element);
        this.tagOwner.set(tag, element);
        let t = this.tags.get(element);
        if (!t)
            this.tags.set(element, (t = new Set()));
        t.add(tag);
        return !was && this.has(element);
    }
    remove(element, tags) {
        const was = this.has(element);
        for (const tag of tags) {
            const owner = this.tagOwner.get(tag);
            if (owner === undefined)
                throw new Error(`Remove before add for tag ${tag}`);
            if (owner !== element)
                throw new Error(`Tag ${tag} belongs to ${owner}, not ${element}`);
            this.removed.add(tag);
        }
        return was && !this.has(element);
    }
    toState() {
        const adds = [];
        for (const [tag, el] of this.tagOwner)
            adds.push([el, tag]);
        adds.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
        return { adds, removed: [...this.removed].sort() };
    }
    merge(state) {
        for (const [el, tag] of state.adds)
            this.add(el, tag);
        for (const tag of state.removed) {
            const owner = this.tagOwner.get(tag);
            if (owner === undefined)
                throw new Error(`State lists removed tag ${tag} that it never added`);
            this.removed.add(tag);
        }
    }
}
