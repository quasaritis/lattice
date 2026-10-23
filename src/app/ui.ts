/** Small shared UI pieces: identity, the state fingerprint, toasts, DOM helpers. */
import { PEER_COLORS } from "./palette.js";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const SWATCH_HEX = ["#17191e", "#1f4fd6", "#df3a2e", "#138a4f", "#ea7a14", "#7444d0", "#f2cf00", "#c2187a"];

/** Render a hash as four marker dots + the hex, so two screens can be compared at a glance. */
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
 * Who am I? The display name is per browser (or the account name when signed in). The
 * replica id is per tab, because two tabs are two replicas and must never mint the same op id.
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
    .split(/[\s._-]+/)
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

// ------------------------------------------------------------------ toasts

let stack: HTMLElement | null = null;

/** Stacked toasts: newest in front, older ones tuck behind it. */
export function toast(text: string, opts: { action?: { label: string; run: () => void }; tone?: "default" | "error" } = {}): void {
  if (!stack) {
    stack = el("ol", "toasts");
    stack.setAttribute("aria-live", "polite");
    stack.setAttribute("aria-label", "Notifications");
    document.body.append(stack);
  }
  const t = el("li", `toast${opts.tone === "error" ? " error" : ""}`);
  const msg = el("span", "toast-text", text);
  t.append(msg);
  if (opts.action) {
    const b = el("button", "toast-action", opts.action.label);
    b.type = "button";
    b.addEventListener("click", () => {
      opts.action!.run();
      dismiss();
    });
    t.append(b);
  }
  stack.prepend(t);
  const items = [...stack.children] as HTMLElement[];
  items.slice(3).forEach((x) => x.remove());
  layout();
  let timer = setTimeout(dismiss, opts.action ? 5200 : 3200);
  t.addEventListener("pointerenter", () => clearTimeout(timer));
  t.addEventListener("pointerleave", () => (timer = setTimeout(dismiss, 1600)));
  function dismiss() {
    clearTimeout(timer);
    if (!t.isConnected) return;
    t.classList.add("out");
    setTimeout(() => {
      t.remove();
      layout();
    }, 180);
  }
}

function layout(): void {
  if (!stack) return;
  [...stack.children].forEach((c, i) => {
    const e = c as HTMLElement;
    e.style.setProperty("--i", String(i));
    e.inert = i > 0;
  });
}

/** Run a View Transition when the browser has one and motion is welcome. */
export function transition(fn: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(fn);
  else fn();
}
