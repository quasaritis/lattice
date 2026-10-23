// Lattice sign-up.
//
// Accounts are optional and only hold a list of saved boards. Supabase's built-in mailer only
// delivers to a project's own team, so a public "confirm your email" step would never arrive.
// This function creates the account already confirmed (through the Auth admin API, with the
// service role key that only exists on the server) and rate-limits sign-ups per network.
// The browser then signs in normally with the password grant.
//
// POST /lattice-signup  { email, password }  ->  201 { ok: true }

import postgres from "npm:postgres@3.4.5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DB_URL = Deno.env.get("SUPABASE_DB_URL")!;
const sql = postgres(DB_URL, { prepare: false, max: 2, idle_timeout: 20, connect_timeout: 10 });

const ALLOWED = ["https://quasarboard.vercel.app", "https://quasarboard-byditors.vercel.app"];
const PREVIEW_RE = /^https:\/\/quasarboard-[a-z0-9-]+-byditors\.vercel\.app$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

function corsFor(req: Request): string | null {
  const o = req.headers.get("origin") ?? "";
  if (ALLOWED.includes(o) || PREVIEW_RE.test(o) || /^http:\/\/localhost:\d+$/.test(o)) return o;
  return null;
}

function reply(body: unknown, status: number, origin: string) {
  // a 204 must not carry a body, or the Response constructor throws
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

async function sha(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

Deno.serve(async (req) => {
  const origin = corsFor(req);
  if (!origin) return new Response("Not allowed", { status: 403 });
  if (req.method === "OPTIONS") return reply(null, 204, origin);
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405, origin);

  let body: { email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return reply({ error: "Send your email and a password." }, 400, origin);
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!EMAIL_RE.test(email)) return reply({ error: "That doesn't look like an email address." }, 400, origin);
  if (password.length < 8) return reply({ error: "Use a password of at least 8 characters." }, 400, origin);
  if (password.length > 72) return reply({ error: "That password is too long (72 characters at most)." }, 400, origin);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const ipHash = await sha(`signup|${ip}|${SERVICE_KEY.slice(-16)}`);
  try {
    const [{ mine, total }] = await sql`
      select
        (select count(*) from lattice.signups where ip_hash = ${ipHash} and created_at > now() - interval '1 hour')::int as mine,
        (select count(*) from lattice.signups where created_at > now() - interval '1 hour')::int as total`;
    if (mine >= 5 || total >= 300) return reply({ error: "Too many new accounts from here. Try again in an hour." }, 429, origin);

    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const msg = String(j?.msg ?? j?.message ?? j?.error_description ?? "");
      if (/already|registered|exists/i.test(msg)) return reply({ error: "An account with this email already exists. Sign in instead." }, 409, origin);
      if (/password/i.test(msg)) return reply({ error: msg.slice(0, 160) }, 400, origin);
      console.error("admin create failed", r.status, msg);
      return reply({ error: "Couldn't create the account. Try again in a moment." }, 502, origin);
    }
    await sql`insert into lattice.signups (ip_hash) values (${ipHash})`;
    return reply({ ok: true }, 201, origin);
  } catch (err) {
    console.error(err);
    return reply({ error: "Couldn't create the account. Try again in a moment." }, 502, origin);
  }
});
