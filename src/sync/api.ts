/** Thin client for the lattice_* Postgres functions, over Supabase's REST endpoint. */
import type { DocState, Op } from "../crdt/doc.js";
import { SUPABASE_KEY, SUPABASE_URL } from "./config.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "content-type": "application/json" },
      body: JSON.stringify(args),
      signal,
    });
  } catch (err) {
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
  return res.json() as Promise<T>;
}

export interface BoardInfo {
  id: string;
  title: string;
  created_at: string;
  op_count: number;
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
};
