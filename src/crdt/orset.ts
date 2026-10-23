/**
 * OR-Set: Observed-Remove Set (Shapiro et al., Spec. 15).
 *
 * add(e) tags the element with a fresh unique tag. remove(e) removes only the tags the
 * remover has observed. So when an add and a remove of the same element are concurrent,
 * the remove cannot have seen the new tag, and the add wins. That is the behaviour people
 * expect on a whiteboard: if you delete a sticky note while I duplicate it offline,
 * my copy survives.
 *
 * Removed tags are kept as tombstones so the state forms a join-semilattice:
 *   state = (adds: set of (element, tag), removed: set of tag), merge = pairwise union.
 * Union is commutative, associative and idempotent, so state-based merge converges.
 */

export interface ORSetState {
  /** [element, tag] pairs, sorted. */
  adds: [string, string][];
  /** Removed tags, sorted. */
  removed: string[];
}

export class ORSet {
  /** element -> tags that added it (live or removed) */
  private tags = new Map<string, Set<string>>();
  /** tag -> element, for every tag ever added */
  private tagOwner = new Map<string, string>();
  private removed = new Set<string>();

  has(element: string): boolean {
    const t = this.tags.get(element);
    if (!t) return false;
    for (const tag of t) if (!this.removed.has(tag)) return true;
    return false;
  }

  values(): string[] {
    return [...this.tags.keys()].filter((e) => this.has(e)).sort();
  }

  hasTag(tag: string): boolean {
    return this.tagOwner.has(tag);
  }

  /** Tags of `element` this replica currently observes as live: what a remove must carry. */
  liveTags(element: string): string[] {
    return [...(this.tags.get(element) ?? [])].filter((t) => !this.removed.has(t)).sort();
  }

  /** Downstream add. Returns true if the element became visible. */
  add(element: string, tag: string): boolean {
    const owner = this.tagOwner.get(tag);
    if (owner !== undefined) {
      if (owner !== element) throw new Error(`Tag ${tag} already belongs to ${owner}`);
      return false;
    }
    const was = this.has(element);
    this.tagOwner.set(tag, element);
    let t = this.tags.get(element);
    if (!t) this.tags.set(element, (t = new Set()));
    t.add(tag);
    return !was && this.has(element);
  }

  /**
   * Downstream remove. Precondition (causal delivery): every tag has already been added here.
   * Callers check `hasTag` first; see Doc.isReady. Returns true if the element became invisible.
   */
  remove(element: string, tags: string[]): boolean {
    const was = this.has(element);
    for (const tag of tags) {
      const owner = this.tagOwner.get(tag);
      if (owner === undefined) throw new Error(`Remove before add for tag ${tag}`);
      if (owner !== element) throw new Error(`Tag ${tag} belongs to ${owner}, not ${element}`);
      this.removed.add(tag);
    }
    return was && !this.has(element);
  }

  toState(): ORSetState {
    const adds: [string, string][] = [];
    for (const [tag, el] of this.tagOwner) adds.push([el, tag]);
    adds.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    return { adds, removed: [...this.removed].sort() };
  }

  merge(state: ORSetState): void {
    for (const [el, tag] of state.adds) this.add(el, tag);
    for (const tag of state.removed) {
      const owner = this.tagOwner.get(tag);
      if (owner === undefined) throw new Error(`State lists removed tag ${tag} that it never added`);
      this.removed.add(tag);
    }
  }
}
