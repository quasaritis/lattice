/**
 * A small Supabase Realtime client written against the Phoenix channel protocol directly
 * (no SDK): one WebSocket, one channel, broadcast + presence, heartbeats and reconnect
 * with backoff.
 *
 * Broadcast is fire-and-forget: messages can be lost while a socket reconnects. That is
 * fine here, because the CRDT layer only needs eventual delivery, and the op log in
 * Postgres fills any gap on the next pull.
 */
import { SUPABASE_KEY, SUPABASE_URL } from "./config.js";

export type Status = "connecting" | "live" | "offline";

interface PhxMessage {
  topic: string;
  event: string;
  payload: any;
  ref: string | null;
  join_ref?: string | null;
}

export interface PresenceMeta {
  name: string;
  color: string;
  replica: string;
  phx_ref?: string;
}

export interface RealtimeHandlers {
  onBroadcast(event: string, payload: any): void;
  onPresence(peers: Map<string, PresenceMeta>): void;
  onStatus(status: Status): void;
}

const HEARTBEAT_MS = 25_000;

export class RealtimeChannel {
  private ws: WebSocket | null = null;
  private ref = 0;
  private joinRef: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private wanted = false;
  private presence = new Map<string, PresenceMeta>();
  status: Status = "offline";

  constructor(
    private readonly topic: string,
    private readonly me: PresenceMeta,
    private readonly handlers: RealtimeHandlers,
  ) {}

  connect(): void {
    this.wanted = true;
    if (this.ws) return;
    this.setStatus("connecting");
    const url = `${SUPABASE_URL.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_KEY)}&vsn=1.0.0`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.joinRef = this.nextRef();
      this.send({
        topic: this.fullTopic,
        event: "phx_join",
        payload: { config: { broadcast: { self: false, ack: false }, presence: { key: this.me.replica }, private: false } },
        ref: this.joinRef,
        join_ref: this.joinRef,
      });
      this.heartbeat = setInterval(() => this.send({ topic: "phoenix", event: "heartbeat", payload: {}, ref: this.nextRef() }), HEARTBEAT_MS);
    };
    ws.onmessage = (e) => this.receive(JSON.parse(String(e.data)) as PhxMessage);
    ws.onclose = () => this.dropped();
    ws.onerror = () => ws.close();
  }

  /** Go offline on purpose (the "offline" toggle). */
  disconnect(): void {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.teardown();
    this.setStatus("offline");
  }

  broadcast(event: string, payload: unknown): boolean {
    if (this.status !== "live") return false;
    this.send({ topic: this.fullTopic, event: "broadcast", payload: { type: "broadcast", event, payload }, ref: this.nextRef(), join_ref: this.joinRef });
    return true;
  }

  private get fullTopic(): string {
    return `realtime:${this.topic}`;
  }

  private receive(msg: PhxMessage): void {
    if (msg.topic !== this.fullTopic) return;
    switch (msg.event) {
      case "phx_reply":
        if (msg.ref === this.joinRef) {
          if (msg.payload?.status === "ok") {
            this.attempts = 0;
            this.setStatus("live");
            this.send({ topic: this.fullTopic, event: "presence", payload: { type: "presence", event: "track", payload: this.me }, ref: this.nextRef(), join_ref: this.joinRef });
          } else {
            console.warn("Realtime join refused", msg.payload);
            this.ws?.close();
          }
        }
        break;
      case "broadcast":
        if (msg.payload?.type === "broadcast") this.handlers.onBroadcast(msg.payload.event, msg.payload.payload);
        break;
      case "presence_state":
        this.presence.clear();
        this.applyJoins(msg.payload);
        this.handlers.onPresence(new Map(this.presence));
        break;
      case "presence_diff":
        this.applyJoins(msg.payload?.joins ?? {});
        for (const key of Object.keys(msg.payload?.leaves ?? {})) this.presence.delete(key);
        this.handlers.onPresence(new Map(this.presence));
        break;
      case "phx_error":
      case "phx_close":
        this.ws?.close();
        break;
    }
  }

  private applyJoins(joins: Record<string, { metas: PresenceMeta[] }>): void {
    for (const [key, v] of Object.entries(joins ?? {})) {
      const meta = v?.metas?.[v.metas.length - 1];
      if (meta && key !== this.me.replica) this.presence.set(key, meta);
    }
  }

  private dropped(): void {
    this.teardown();
    if (!this.wanted) return;
    this.setStatus("connecting");
    const delay = Math.min(15_000, 500 * 2 ** this.attempts++) * (0.75 + Math.random() / 2);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
  }

  private teardown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.presence.clear();
    this.handlers.onPresence(new Map());
  }

  private send(msg: PhxMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private nextRef(): string {
    return String(++this.ref);
  }

  private setStatus(s: Status): void {
    if (this.status === s) return;
    this.status = s;
    this.handlers.onStatus(s);
  }
}
