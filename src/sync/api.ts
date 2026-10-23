/** Thin client for the lattice_* Postgres functions, Storage uploads, over Supabase's HTTP API. */
import type { DocState, Op } from "../crdt/doc.js";
import { accessToken } from "./auth.js";
import { IMAGE_BUCKET, SUPABASE_KEY, SUPABASE_URL } from "./config.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function headers(json = true): Promise<Record<string, string>> {
  const h: Record<string, string> = { apikey: SUPABASE_KEY };
  if (json) h["content-type"] = "application/json";
  const token = await accessToken();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function rpc<T>(fn: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: await headers(), body: JSON.stringify(args), signal });
  } catch {
    throw new ApiError("Can't reach the server. Check your connection.", 0);
  }
  if (!res.ok) {
    let msg = `Server error (${res.status})`;
    try {
      const body = await res.json();
      if (body?.message) msg = body.message;
    } catch {
      /* not json */
    }
    throw new ApiError(msg, res.status);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export interface BoardInfo {
  id: string;
  title: string;
  created_at: string;
  op_count: number;
}

export interface BoardSummary {
  id: string;
  title: string;
  created_at: string;
  last_active_at: string;
  opened_at?: string;
  preview: string | null;
  op_count?: number;
}

export const api = {
  createBoard: (title: string) => rpc<string>("lattice_create_board", { p_title: title }),

  board: async (id: string): Promise<BoardInfo | null> => {
    const rows = await rpc<BoardInfo[]>("lattice_board", { p_board: id });
    return rows[0] ?? null;
  },

  push: (board: string, ops: Op[]) => rpc<number>("lattice_push", { p_board: board, p_ops: ops }),

  pull: (board: string, after: number, limit = 2000) =>
    rpc<{ seq: number; op: Op }[]>("lattice_pull", { p_board: board, p_after: after, p_limit: limit }),

  snapshot: async (board: string): Promise<{ upto_seq: number; state: DocState } | null> => {
    const rows = await rpc<{ upto_seq: number; state: DocState }[]>("lattice_get_snapshot", { p_board: board });
    return rows[0] ?? null;
  },

  putSnapshot: (board: string, upto: number, state: DocState) =>
    rpc<boolean>("lattice_put_snapshot", { p_board: board, p_upto: upto, p_state: state }),

  rename: (board: string, title: string) => rpc<string>("lattice_rename_board", { p_board: board, p_title: title }),

  setPreview: (board: string, svg: string) => rpc<boolean>("lattice_set_preview", { p_board: board, p_svg: svg }),

  /** Signed-in only: remember this board in "Your boards". */
  saveBoard: (board: string) => rpc<boolean>("lattice_save_board", { p_board: board }),

  forgetBoard: (board: string) => rpc<boolean>("lattice_forget_board", { p_board: board }),

  myBoards: () => rpc<BoardSummary[]>("lattice_my_boards", {}),

  boardsInfo: (ids: string[]) => (ids.length ? rpc<BoardSummary[]>("lattice_boards_info", { p_ids: ids.slice(0, 100) }) : Promise.resolve([])),

  /** Upload an image into the board's folder. Returns the storage path to keep in the item's "src". */
  uploadImage: async (board: string, blob: Blob, ext: "webp" | "jpg" | "png" | "gif"): Promise<string> => {
    const a = new Uint8Array(9);
    crypto.getRandomValues(a);
    const name = Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
    const path = `${board}/${name}.${ext}`;
    let res: Response;
    try {
      res = await fetch(`${SUPABASE_URL}/storage/v1/object/${IMAGE_BUCKET}/${path}`, {
        method: "POST",
        headers: { ...(await headers(false)), "content-type": blob.type || "application/octet-stream", "x-upsert": "false", "cache-control": "31536000" },
        body: blob,
      });
    } catch {
      throw new ApiError("Can't reach the server to upload the image.", 0);
    }
    if (!res.ok) {
      let msg = `Upload failed (${res.status})`;
      try {
        const j = await res.json();
        if (/row-level security|policy/i.test(String(j?.message))) msg = "This board can't take more images.";
        else if (/size|too large|exceed/i.test(String(j?.message))) msg = "That image is too big, even after shrinking it.";
        else if (j?.message) msg = String(j.message);
      } catch {
        /* not json */
      }
      throw new ApiError(msg, res.status);
    }
    return path;
  },
};
