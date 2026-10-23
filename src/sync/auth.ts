/**
 * Optional accounts, written against Supabase Auth's HTTP API directly (no SDK).
 *
 *   email + password   sign-up goes through the lattice-signup edge function, which creates an
 *                      already-confirmed account; sign-in is the standard password grant.
 *   GitHub             OAuth with PKCE. The button only shows when the provider is switched on
 *                      in the project (checked through /auth/v1/settings).
 *
 * The session lives in localStorage and is refreshed shortly before it expires. Boards never
 * need an account: signing in only adds a list of saved boards that follows you around.
 */
import { SUPABASE_KEY, SUPABASE_URL } from "./config.js";

export interface User {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
}

interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // seconds since epoch
  user: User;
}

const KEY = "lattice:session";
const VERIFIER = "lattice:pkce";
const listeners = new Set<(u: User | null) => void>();
let session: Session | null = load();
let refreshing: Promise<void> | null = null;

function load(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function save(s: Session | null): void {
  session = s;
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the session lasts as long as the tab */
  }
  for (const fn of listeners) fn(s?.user ?? null);
}

// another tab signed in or out
try {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    session = load();
    for (const fn of listeners) fn(session?.user ?? null);
  });
} catch {
  /* not in a browser (tests) */
}

export function currentUser(): User | null {
  return session?.user ?? null;
}

export function onAuthChange(fn: (u: User | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export class AuthError extends Error {}

function toUser(u: any): User {
  const meta = u?.user_metadata ?? {};
  const email = String(u?.email ?? "");
  return {
    id: String(u?.id ?? ""),
    email,
    name: String(meta.user_name ?? meta.preferred_username ?? meta.full_name ?? meta.name ?? email.split("@")[0] ?? "You").slice(0, 40),
    avatar: typeof meta.avatar_url === "string" && /^https:\/\//.test(meta.avatar_url) ? meta.avatar_url : null,
  };
}

function fromTokenResponse(j: any): Session {
  if (!j?.access_token || !j?.refresh_token) throw new AuthError("Sign-in didn't return a session.");
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Number(j.expires_at) || Math.floor(Date.now() / 1000) + Number(j.expires_in || 3600),
    user: toUser(j.user),
  };
}

async function authFetch(path: string, body: unknown): Promise<any> {
  let r: Response;
  try {
    r = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError("Can't reach the server. Check your connection.");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = String(j?.error_code ?? j?.error ?? "");
    if (code === "invalid_credentials" || /invalid login/i.test(j?.msg ?? j?.error_description ?? "")) {
      throw new AuthError("That email and password don't match an account.");
    }
    throw new AuthError(String(j?.msg ?? j?.error_description ?? j?.message ?? `Sign-in failed (${r.status})`));
  }
  return j;
}

// ------------------------------------------------------------------ email + password

export async function signIn(email: string, password: string): Promise<User> {
  const j = await authFetch("token?grant_type=password", { email: email.trim(), password });
  const s = fromTokenResponse(j);
  save(s);
  return s.user;
}

export async function signUp(email: string, password: string): Promise<User> {
  let r: Response;
  try {
    r = await fetch(`${SUPABASE_URL}/functions/v1/lattice-signup`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "content-type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password }),
    });
  } catch {
    throw new AuthError("Can't reach the server. Check your connection.");
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new AuthError(String(j?.error ?? `Couldn't create the account (${r.status}).`));
  }
  return signIn(email, password);
}

// ------------------------------------------------------------------ GitHub (PKCE)

let providers: Promise<Record<string, boolean>> | null = null;

/** Which OAuth providers are switched on for this project. */
export function enabledProviders(): Promise<Record<string, boolean>> {
  providers ??= fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_KEY } })
    .then((r) => (r.ok ? r.json() : {}))
    .then((j: any) => (j?.external ?? {}) as Record<string, boolean>)
    .catch(() => ({}));
  return providers;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function signInWithGitHub(returnTo = location.pathname + location.search): Promise<void> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = b64url(raw);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  sessionStorage.setItem(VERIFIER, JSON.stringify({ verifier, returnTo }));
  const redirect = `${location.origin}/auth/callback`;
  const q = new URLSearchParams({ provider: "github", redirect_to: redirect, code_challenge: challenge, code_challenge_method: "s256" });
  location.href = `${SUPABASE_URL}/auth/v1/authorize?${q}`;
}

/** Finish an OAuth sign-in on /auth/callback. Returns where to send the user next. */
export async function completeOAuth(): Promise<string> {
  const params = new URLSearchParams(location.search);
  const err = params.get("error_description") ?? params.get("error");
  const stored = JSON.parse(sessionStorage.getItem(VERIFIER) ?? "{}") as { verifier?: string; returnTo?: string };
  sessionStorage.removeItem(VERIFIER);
  const back = stored.returnTo && stored.returnTo.startsWith("/") && !stored.returnTo.startsWith("//") ? stored.returnTo : "/boards";
  if (err) throw new AuthError(err);
  const code = params.get("code");
  if (!code || !stored.verifier) throw new AuthError("This sign-in link has expired. Try again.");
  const j = await authFetch("token?grant_type=pkce", { auth_code: code, code_verifier: stored.verifier });
  save(fromTokenResponse(j));
  return back;
}

// ------------------------------------------------------------------ tokens

/** A valid access token for the signed-in user, refreshing it if needed. Null when signed out. */
export async function accessToken(): Promise<string | null> {
  if (!session) return null;
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  refreshing ??= (async () => {
    try {
      const j = await authFetch("token?grant_type=refresh_token", { refresh_token: session!.refresh_token });
      save(fromTokenResponse(j));
    } catch (e) {
      // a refresh token that no longer works means the session is over
      if (e instanceof AuthError && !/reach the server/.test(e.message)) save(null);
    } finally {
      refreshing = null;
    }
  })();
  await refreshing;
  return session?.access_token ?? null;
}

export async function signOut(): Promise<void> {
  const token = session?.access_token;
  save(null);
  if (token) {
    fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: "POST", headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } }).catch(() => {});
  }
}
