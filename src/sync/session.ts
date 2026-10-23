/**
 * BoardSession ties a CRDT document to the network.
 *
 *   Realtime broadcast   low latency, best effort: ops reach other open tabs in ~50 ms
 *   Postgres op log      reliable: every op is pushed, and every client pulls what it missed
 *   Snapshot             compaction: a CvRDT state so new clients don't replay the whole log
 *   localStorage         offline: the board and any unsent edits survive a reload
 *
 * Because the CRDT tolerates duplicates and any delivery order, these paths can overlap
 * freely. Nothing here needs locks, leaders, or "last save wins".
 */
import { Doc, isOp, type DocState, type Op } from "../crdt/doc.js";
import { api, ApiError } from "./api.js";
import { RealtimeChannel, type PresenceMeta, type Status } from "./realtime.js";

export type SyncStatus = "loading" | "live" | "connecting" | "offline" | "paused" | "error";

export interface Cursor {
  replica: string;
  name: string;
  color: string;
  x: number;
  y: number;
  at: number;
}

export interface SyncStats {
  unsent: number;
  lastSeq: number;
  snapshotSeq: number;
  peers: number;
  pending: number;
  hash: string;
}

export interface SessionEvents {
  status(s: SyncStatus, detail?: string): void;
  peers(peers: PresenceMeta[]): void;
  cursor(c: Cursor): void;
  stats(s: SyncStats): void;
}

const PULL_EVERY_MS = 8_000;
const PUSH_BATCH = 300;
const SNAPSHOT_AFTER = 300;

export class BoardSession {
  readonly doc: Doc;
  /** Mirror holding only what is persisted on the server; used to build safe snapshots. */
  private shadow: Doc;
  private outbox: Op[] = [];
  private lastSeq = 0;
  private snapshotSeq = 0;
  private channel: RealtimeChannel;
  private paused = false;
  private rtStatus: Status = "offline";
  private netError: string | null = null;
  private pushing = false;
  private pulling = false;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private backoff = 1000;
  private peers: PresenceMeta[] = [];
  private status: SyncStatus = "loading";

  constructor(
    readonly board: string,
    readonly me: PresenceMeta,
    private readonly on: SessionEvents,
  ) {
    this.doc = new Doc(me.replica);
    this.shadow = new Doc(`${me.replica}s`.slice(0, 32));
    this.channel = new RealtimeChannel(`lattice:${board}`, me, {
      onBroadcast: (event, payload) => this.onBroadcast(event, payload),
      onPresence: (peers) => {
        this.peers = [...peers.values()];
        this.on.peers(this.peers);
        this.emitStats();
      },
      onStatus: (s) => {
        this.rtStatus = s;
        if (s === "live") {
          // we may have missed broadcasts while connecting; catch up and send ours
          void this.pull();
          this.schedulePush(0);
        }
        this.updateStatus();
      },
    });
    this.doc.onChange((_c, source) => {
      this.scheduleSave();
      if (source === "remote") this.emitStats();
    });
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    this.loadCache();
    const info = await api.board(this.board).catch((e: unknown) => {
      if (this.doc.itemIds().length) return "offline" as const; // we have a cached copy: keep working offline
      throw e;
    });
    if (info === null) throw new ApiError("This board doesn't exist.", 404);
    if (info !== "offline") {
      const snap = await api.snapshot(this.board).catch(() => null);
      if (snap) {
        try {
          this.doc.merge(snap.state);
          this.shadow.merge(snap.state);
          this.snapshotSeq = snap.upto_seq;
        } catch (err) {
          console.warn("Ignoring a snapshot that does not merge cleanly", err);
        }
      }
      // pull from the snapshot, not from our cache: the shadow must see every persisted op
      this.lastSeq = this.snapshotSeq;
      await this.pull();
    }
    if (!this.paused) this.channel.connect();
    this.pullTimer = setInterval(() => void this.pull(), PULL_EVERY_MS);
    this.schedulePush(0);
    this.updateStatus();
    this.emitStats();
  }

  stop(): void {
    if (this.pullTimer) clearInterval(this.pullTimer);
    this.channel.disconnect();
    this.saveCache();
  }

  /** Simulate losing the network. Edits keep working locally and are queued. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.channel.disconnect();
    else {
      this.channel.connect();
      void this.pull();
      this.schedulePush(0);
    }
    this.updateStatus();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  // ------------------------------------------------------------------ local edits

  /** Hand every op produced by a local edit to this. */
  commit(ops: Op[]): void {
    if (!ops.length) return;
    this.outbox.push(...ops);
    if (!this.paused) {
      for (let i = 0; i < ops.length; i += 100) this.channel.broadcast("ops", { ops: ops.slice(i, i + 100) });
    }
    this.schedulePush(120);
    this.scheduleSave();
    this.emitStats();
  }

  sendCursor(x: number, y: number): void {
    if (this.paused) return;
    this.channel.broadcast("cursor", { replica: this.me.replica, name: this.me.name, color: this.me.color, x: Math.round(x), y: Math.round(y) });
  }

  // ------------------------------------------------------------------ network

  private onBroadcast(event: string, payload: any): void {
    if (event === "ops" && Array.isArray(payload?.ops)) {
      this.doc.applyRemote(payload.ops.filter(isOp));
    } else if (event === "cursor" && payload && typeof payload.replica === "string" && payload.replica !== this.me.replica) {
      const x = Number(payload.x);
      const y = Number(payload.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        this.on.cursor({ replica: payload.replica, name: String(payload.name ?? "").slice(0, 24), color: String(payload.color ?? "#888").slice(0, 16), x, y, at: Date.now() });
      }
    }
  }

  private schedulePush(ms: number): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.push();
    }, ms);
  }

  private async push(): Promise<void> {
    if (this.paused || this.pushing || !this.outbox.length) return;
    this.pushing = true;
    const batch = this.outbox.slice(0, PUSH_BATCH);
    try {
      await api.push(this.board, batch);
      this.outbox.splice(0, batch.length);
      this.netError = null;
      this.backoff = 1000;
      this.scheduleSave();
    } catch (err) {
      this.netError = err instanceof Error ? err.message : String(err);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    } finally {
      this.pushing = false;
      this.updateStatus();
      this.emitStats();
    }
    if (this.outbox.length) this.schedulePush(this.netError ? this.backoff : 0);
  }

  /** Fetch every persisted op we have not seen yet (anti-entropy). */
  async pull(): Promise<void> {
    if (this.paused || this.pulling) return;
    this.pulling = true;
    try {
      for (;;) {
        const rows = await api.pull(this.board, this.lastSeq);
        if (!rows.length) break;
        const ops = rows.map((r) => r.op).filter(isOp);
        this.shadow.applyRemote(ops);
        this.doc.applyRemote(ops);
        this.lastSeq = rows[rows.length - 1].seq;
        if (rows.length < 2000) break;
      }
      this.netError = null;
      await this.maybeSnapshot();
    } catch (err) {
      this.netError = err instanceof Error ? err.message : String(err);
    } finally {
      this.pulling = false;
      this.updateStatus();
      this.emitStats();
    }
  }

  private async maybeSnapshot(): Promise<void> {
    if (this.lastSeq - this.snapshotSeq < SNAPSHOT_AFTER || this.shadow.pendingCount) return;
    const upto = this.lastSeq;
    if (await api.putSnapshot(this.board, upto, this.shadow.toState()).catch(() => false)) this.snapshotSeq = upto;
  }

  // ------------------------------------------------------------------ offline cache

  private get cacheKey(): string {
    return `lattice:board:${this.board}`;
  }

  private loadCache(): void {
    try {
      const raw = localStorage.getItem(this.cacheKey);
      if (!raw) return;
      const c = JSON.parse(raw) as { state: DocState; outbox: Op[] };
      this.doc.merge(c.state);
      this.outbox = (c.outbox ?? []).filter(isOp);
      this.doc.applyRemote(this.outbox);
    } catch {
      /* corrupt or unavailable cache: start clean */
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveCache();
    }, 800);
  }

  private saveCache(): void {
    try {
      localStorage.setItem(this.cacheKey, JSON.stringify({ state: this.doc.toState(), outbox: this.outbox }));
    } catch {
      /* storage full or blocked: the server copy still has everything that was pushed */
    }
  }

  // ------------------------------------------------------------------ status

  private updateStatus(): void {
    let s: SyncStatus;
    if (this.paused) s = "paused";
    else if (this.netError && this.rtStatus !== "live") s = "offline";
    else if (this.rtStatus === "live") s = "live";
    else s = "connecting";
    if (s !== this.status) {
      this.status = s;
      this.on.status(s, this.netError ?? undefined);
    }
  }

  private emitStats(): void {
    this.on.stats({
      unsent: this.outbox.length,
      lastSeq: this.lastSeq,
      snapshotSeq: this.snapshotSeq,
      peers: this.peers.length,
      pending: this.doc.pendingCount,
      hash: this.doc.hash(),
    });
  }
}
