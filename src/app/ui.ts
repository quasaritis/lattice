/** Small shared UI helpers: identity, inks, the state fingerprint. */

export const INKS: Record<string, { fill: string; misreg: string; label: string }> = {
  sun: { fill: "var(--sun)", misreg: "var(--rose)", label: "Yellow" },
  mint: { fill: "var(--mint)", misreg: "var(--sky)", label: "Green" },
  sky: { fill: "var(--sky)", misreg: "var(--lilac)", label: "Aqua" },
  rose: { fill: "var(--rose)", misreg: "var(--sun)", label: "Pink" },
  lilac: { fill: "var(--lilac)", misreg: "var(--rose)", label: "Violet" },
  paper: { fill: "var(--white)", misreg: "var(--sky)", label: "White" },
};
export const INK_KEYS = Object.keys(INKS);

const SWATCH_HEX = ["#ffe03d", "#3fbf7f", "#5ec3e3", "#ff5fae", "#a989df", "#fbfbf8", "#ff8a3d", "#2f4fd0"];

/** Render a hash as four ink swatches + the hex, so two screens can be compared at a glance. */
export function renderFingerprint(swatches: HTMLElement, text: HTMLElement, hash: string): void {
  if (text.textContent === hash) return;
  text.textContent = hash;
  swatches.replaceChildren(
    ...[0, 2, 4, 6].map((i) => {
      const s = document.createElement("i");
      s.style.background = SWATCH_HEX[parseInt(hash.slice(i, i + 2), 16) % SWATCH_HEX.length];
      return s;
    }),
  );
}

const ADJ = ["Swift", "Quiet", "Brave", "Lucky", "Sunny", "Clever", "Gentle", "Bold", "Witty", "Calm", "Zesty", "Nimble"];
const NOUN = ["Otter", "Heron", "Lynx", "Panda", "Falcon", "Koala", "Gecko", "Tiger", "Mango", "Comet", "Pixel", "Lotus"];
export const PEER_COLORS = ["#ffe03d", "#3fbf7f", "#5ec3e3", "#ff5fae", "#a989df", "#ff8a3d"];

function randomId(len: number): string {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}

function storage(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Who am I? The display name is per browser. The replica id is per tab, because two tabs
 * are two replicas: they must never mint the same op id.
 */
export function identity(): { replica: string; name: string; color: string } {
  const ls = storage("local");
  const ss = storage("session");
  let name = ls?.getItem("lattice:name") ?? "";
  let color = ls?.getItem("lattice:color") ?? "";
  if (!name) {
    name = `${ADJ[Math.floor(Math.random() * ADJ.length)]} ${NOUN[Math.floor(Math.random() * NOUN.length)]}`;
    ls?.setItem("lattice:name", name);
  }
  if (!PEER_COLORS.includes(color)) {
    color = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
    ls?.setItem("lattice:color", color);
  }
  let replica = ss?.getItem("lattice:replica") ?? "";
  if (!/^[a-z0-9]{10}$/.test(replica)) {
    replica = randomId(10);
    ss?.setItem("lattice:replica", replica);
  }
  return { replica, name, color };
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** Convert between UTF-16 offsets (what textareas use) and code-point offsets (what the RGA uses). */
export function utf16ToCp(s: string, i: number): number {
  return Array.from(s.slice(0, i)).length;
}
export function cpToUtf16(s: string, cp: number): number {
  return Array.from(s).slice(0, cp).join("").length;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
