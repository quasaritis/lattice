// Lattice index: a readable copy of what is on a board.
//
// The op log is the source of truth, but it's a stream of CRDT operations, not something you
// can read. This function replays a board's snapshot and ops with the exact CRDT code the
// browsers run (copied into ./lib by scripts/copy-crdt.mjs), then
//   - writes one row per item to lattice.board_items (text, strokes, photos, videos), and
//   - draws the whole board, every stroke included, as an SVG in the lattice-boards bucket.
//
// Browsers call it after they save a board preview. It only does work when the log has grown
// since the last run, and at most once every few seconds per board.
//
// POST /lattice-index  { board }  ->  200 { items, seq } | { fresh: true }

import postgres from "npm:postgres@3.4.5";
import { Doc } from "./lib/crdt/doc.js";
import { boardSvg } from "./lib/draw/board-svg.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const DB_URL = Deno.env.get("SUPABASE_DB_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sql = postgres(DB_URL, { prepare: false, max: 2, idle_timeout: 20, connect_timeout: 10 });

const ALLOWED = ["https://quasarboard.vercel.app", "https://quasarboard-byditors.vercel.app"];
const PREVIEW_RE = /^https:\/\/quasarboard-[a-z0-9-]+-byditors\.vercel\.app$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_OPS = 60000;

function corsFor(req: Request): string {
  const o = req.headers.get("origin") ?? "";
  if (ALLOWED.includes(o) || PREVIEW_RE.test(o) || /^http:\/\/localhost:\d+$/.test(o)) return o;
  return ALLOWED[0];
}

function reply(body: unknown, status: number, origin: string) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
      "Vary": "Origin",
      "Content-Type": "application/json",
    },
  });
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const IMAGE_RE = /\.(webp|jpe?g|png|gif)$/;
const VIDEO_RE = /\.(mp4|webm|mov)$/;
function mediaUrl(kind: string, src: string): string | null {
  if (!src) return null;
  if (kind === "video") return VIDEO_RE.test(src) ? `${SUPABASE_URL}/storage/v1/object/public/lattice-videos/${src}` : null;
  return IMAGE_RE.test(src) ? `${SUPABASE_URL}/storage/v1/object/public/lattice-images/${src}` : null;
}

/** Put the board's picture in Storage (service role; browsers can't write this bucket). */
async function savePicture(board: string, svg: string | null): Promise<string | null> {
  const path = `${board}.svg`;
  const url = `${SUPABASE_URL}/storage/v1/object/lattice-boards/${path}`;
  if (!svg) {
    await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY } }).catch(() => {});
    return null;
  }
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, "content-type": "image/svg+xml", "x-upsert": "true", "cache-control": "60" },
    body: svg,
  });
  if (!r.ok) throw new Error(`picture upload ${r.status}: ${await r.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/lattice-boards/${path}`;
}

async function index(board: string) {
  const [b] = await sql`select id, indexed_seq, indexed_at, (indexed_at > now() - interval '4 seconds') as busy from lattice.boards where id = ${board}`;
  if (!b) return { status: 404, body: { error: "No such board" } };
  const [{ top }] = await sql`select coalesce(max(seq), 0)::bigint as top from lattice.ops where board_id = ${board}`;
  if (b.indexed_at && BigInt(b.indexed_seq) === BigInt(top)) return { status: 200, body: { fresh: true } };
  if (b.busy) return { status: 200, body: { later: true } };

  const doc = new Doc("indexer");
  let after = 0n;
  const [snap] = await sql`select upto_seq, state from lattice.snapshots where board_id = ${board}`;
  if (snap) {
    try {
      doc.merge(snap.state);
      after = BigInt(snap.upto_seq);
    } catch {
      after = 0n; // a snapshot that doesn't merge: fall back to the full log
    }
  }
  const rows = await sql`select op from lattice.ops where board_id = ${board} and seq > ${after.toString()} order by seq limit ${MAX_OPS}`;
  doc.applyRemote(rows.map((r) => r.op));

  const items = doc.itemIds().map((id: string) => {
    const kind = str(doc.prop(id, "kind")) ?? "note";
    const d = str(doc.prop(id, "d"));
    const src = str(doc.prop(id, "src"));
    return {
      board_id: board,
      item_id: id.slice(0, 64),
      kind,
      text: doc.text(id).slice(0, 2000),
      color: str(doc.prop(id, "color")),
      brush: str(doc.prop(id, "brush")),
      font_size: num(doc.prop(id, "fs")),
      x: num(doc.prop(id, "x")),
      y: num(doc.prop(id, "y")),
      w: num(doc.prop(id, "w")),
      h: num(doc.prop(id, "h")),
      rotation: num(doc.prop(id, "r")) ?? 0,
      z: num(doc.prop(id, "z")),
      image_url: src ? mediaUrl(kind, src) : null,
      points: d ? d.split(";").length : null,
      stroke: d,
    };
  });

  const [{ title }] = await sql`select coalesce(nullif(title, ''), 'Untitled board') as title from lattice.boards where id = ${board}`;
  // Photos go inside the picture as data, so it shows them anywhere (an <img> never loads outside links).
  const inline = new Map<string, string>();
  let budget = 7_500_000;
  for (const it of items) {
    if (it.kind !== "image" || !it.image_url) continue;
    const src = String(doc.prop(it.item_id, "src") ?? "");
    if (inline.has(src) || budget <= 0) continue;
    try {
      const r = await fetch(it.image_url);
      if (!r.ok) continue;
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length * 1.37 > budget) continue;
      const type = (r.headers.get("content-type") ?? "image/webp").split(";")[0];
      if (!/^image\/(webp|jpeg|png|gif)$/.test(type)) continue;
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const data = `data:${type};base64,${btoa(bin)}`;
      budget -= data.length;
      inline.set(src, data);
    } catch {
      /* leave the link */
    }
  }
  const pictureUrl = (kind: string, src: string) => (kind === "image" && inline.get(src)) || mediaUrl(kind, src);
  const picture = await savePicture(board, boardSvg(doc, { full: true, mediaUrl: pictureUrl, title }));

  await sql.begin(async (tx) => {
    await tx`delete from lattice.board_items where board_id = ${board}`;
    for (let i = 0; i < items.length; i += 500) {
      await tx`insert into lattice.board_items ${tx(items.slice(i, i + 500))}`;
    }
    await tx`update lattice.boards set item_count = ${items.length}, indexed_seq = ${top}, indexed_at = now(), picture_url = ${picture} where id = ${board}`;
  });
  return { status: 200, body: { items: items.length, seq: String(top), picture } };
}

Deno.serve(async (req) => {
  const origin = corsFor(req);
  if (req.method === "OPTIONS") return reply(null, 204, origin);
  if (req.method !== "POST") return reply({ error: "POST only" }, 405, origin);
  let board = "";
  try {
    board = String((await req.json())?.board ?? "").toLowerCase();
  } catch {
    return reply({ error: "Send JSON: { board }" }, 400, origin);
  }
  if (!UUID_RE.test(board)) return reply({ error: "Not a board id" }, 400, origin);
  try {
    const r = await index(board);
    return reply(r.body, r.status, origin);
  } catch (err) {
    console.error("index failed", board, err);
    return reply({ error: "Indexing failed" }, 500, origin);
  }
});
