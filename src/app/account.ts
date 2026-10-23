/** The account button in the header and the sign-in dialog. Signing in is always optional. */
import { AuthError, currentUser, enabledProviders, onAuthChange, signIn, signInWithGitHub, signOut, signUp, type User } from "../sync/auth.js";
import { icon } from "./icons.js";
import { claimRecents } from "./recent.js";
import { el, initials, toast } from "./ui.js";

let dialog: HTMLDialogElement | null = null;

/** Mount the account control into `slot` (a header element). */
export function mountAccount(slot: HTMLElement, opts: { compact?: boolean } = {}): void {
  const render = (u: User | null) => {
    slot.replaceChildren();
    if (!u) {
      const b = el("button", "btn ghost account-btn");
      b.type = "button";
      b.innerHTML = `${icon("user")}<span>Sign in</span>`;
      if (opts.compact) b.querySelector("span")!.classList.add("sr-only");
      b.addEventListener("click", () => openSignIn());
      slot.append(b);
      return;
    }
    const wrap = el("div", "account");
    const b = el("button", "avatar-btn");
    b.type = "button";
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    b.setAttribute("aria-label", `Account: ${u.name}`);
    if (u.avatar) {
      const img = el("img");
      img.src = u.avatar;
      img.alt = "";
      b.append(img);
    } else b.textContent = initials(u.name);
    const menu = el("div", "menu");
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    const who = el("p", "menu-who");
    who.append(el("strong", undefined, u.name), el("span", undefined, u.email));
    const boards = el("a", "menu-item");
    boards.href = "/boards";
    boards.setAttribute("role", "menuitem");
    boards.innerHTML = `${icon("boards")}<span>Your boards</span>`;
    const out = el("button", "menu-item");
    out.type = "button";
    out.setAttribute("role", "menuitem");
    out.innerHTML = `${icon("logout")}<span>Sign out</span>`;
    out.addEventListener("click", async () => {
      await signOut();
      toast("Signed out. Your boards are still here when you come back.");
    });
    menu.append(who, boards, out);
    const close = () => {
      menu.hidden = true;
      b.setAttribute("aria-expanded", "false");
    };
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      b.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", (e) => !wrap.contains(e.target as Node) && close());
    document.addEventListener("keydown", (e) => e.key === "Escape" && close());
    wrap.append(b, menu);
    slot.append(wrap);
  };
  render(currentUser());
  onAuthChange(render);
}

export function openSignIn(reason?: string): void {
  if (!dialog) dialog = build();
  const lede = dialog.querySelector<HTMLElement>(".dlg-lede")!;
  lede.textContent = reason ?? "Boards work without an account. Signing in keeps a list of every board you open, on all your devices.";
  dialog.showModal();
  dialog.querySelector<HTMLInputElement>("input[type=email]")?.focus();
}

function build(): HTMLDialogElement {
  const d = el("dialog", "dlg");
  d.setAttribute("aria-labelledby", "dlgTitle");
  d.innerHTML = `
    <form method="dialog" class="dlg-x"><button class="icon-btn" aria-label="Close">${icon("close")}</button></form>
    <h2 id="dlgTitle" class="dlg-title">Keep your boards</h2>
    <p class="dlg-lede"></p>
    <div class="dlg-oauth" hidden>
      <button type="button" class="btn dark wide gh">${icon("github")}<span>Continue with GitHub</span></button>
      <p class="dlg-or"><span>or with email</span></p>
    </div>
    <form class="dlg-form" novalidate>
      <label class="field"><span>Email</span><input type="email" name="email" autocomplete="email" required inputmode="email" spellcheck="false"></label>
      <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required minlength="8"></label>
      <p class="dlg-err" role="alert" hidden></p>
      <button class="btn primary wide" type="submit"><span>Sign in</span></button>
      <p class="dlg-switch"><span>New here?</span> <button type="button" class="link-btn">Create an account</button></p>
    </form>`;
  document.body.append(d);
  const form = d.querySelector<HTMLFormElement>(".dlg-form")!;
  const err = d.querySelector<HTMLElement>(".dlg-err")!;
  const submit = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const switchText = d.querySelector<HTMLElement>(".dlg-switch span")!;
  const switchBtn = d.querySelector<HTMLButtonElement>(".link-btn")!;
  const pw = form.querySelector<HTMLInputElement>("input[name=password]")!;
  let mode: "in" | "up" = "in";
  const setMode = (m: "in" | "up") => {
    mode = m;
    d.querySelector(".dlg-title")!.textContent = m === "in" ? "Keep your boards" : "Make an account";
    submit.querySelector("span")!.textContent = m === "in" ? "Sign in" : "Create account";
    switchText.textContent = m === "in" ? "New here?" : "Already have one?";
    switchBtn.textContent = m === "in" ? "Create an account" : "Sign in instead";
    pw.autocomplete = m === "in" ? "current-password" : "new-password";
    pw.placeholder = m === "up" ? "At least 8 characters" : "";
    err.hidden = true;
  };
  switchBtn.addEventListener("click", () => setMode(mode === "in" ? "up" : "in"));
  enabledProviders().then((p) => {
    if (p.github) d.querySelector<HTMLElement>(".dlg-oauth")!.hidden = false;
  });
  d.querySelector(".gh")!.addEventListener("click", () => void signInWithGitHub());
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close(); // backdrop
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = String(new FormData(form).get("email") ?? "").trim();
    const password = String(new FormData(form).get("password") ?? "");
    if (!/^\S+@\S+\.\S+$/.test(email)) return showErr("Enter your email address.");
    if (password.length < 8) return showErr(mode === "up" ? "Use a password of at least 8 characters." : "Enter your password.");
    submit.disabled = true;
    submit.classList.add("busy");
    try {
      const u = mode === "in" ? await signIn(email, password) : await signUp(email, password);
      d.close();
      form.reset();
      await claimRecents();
      toast(mode === "in" ? `Signed in as ${u.name}.` : `Welcome, ${u.name}. Boards you open are saved to your account.`);
      document.dispatchEvent(new CustomEvent("lattice:signed-in"));
    } catch (e2) {
      showErr(e2 instanceof AuthError ? e2.message : "Something went wrong. Try again.");
    } finally {
      submit.disabled = false;
      submit.classList.remove("busy");
    }
  });
  function showErr(m: string) {
    err.textContent = m;
    err.hidden = false;
  }
  return d;
}
