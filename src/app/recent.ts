/**
 * Boards opened on this device. Works without an account; when you sign in, these are added
 * to your account so they follow you to other devices.
 */
import { api } from "../sync/api.js";
import { currentUser } from "../sync/auth.js";

const KEY = "lattice:recent";

export interface Recent {
  id: string;
  title: string;
  at: number;
}

export function recentBoards(): Recent[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((r) => r && typeof r.id === "string").slice(0, 60) : [];
  } catch {
    return [];
  }
}

function write(list: Recent[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 60)));
  } catch {
    /* storage full or blocked */
  }
}

/** Note that a board was opened (and save it to the account when signed in). */
export function rememberBoard(id: string, title: string): void {
  write([{ id, title, at: Date.now() }, ...recentBoards().filter((r) => r.id !== id)]);
  if (currentUser()) api.saveBoard(id).catch(() => {});
}

export function forgetRecent(id: string): void {
  write(recentBoards().filter((r) => r.id !== id));
}

/** After signing in, copy this device's boards into the account. */
export async function claimRecents(): Promise<void> {
  for (const r of recentBoards().slice(0, 30).reverse()) {
    await api.saveBoard(r.id).catch(() => {});
  }
}
