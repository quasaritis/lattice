/** "Your boards": the account's saved boards when signed in, plus boards opened on this device. */
import { api, type BoardSummary } from "../sync/api.js";
import { currentUser, onAuthChange } from "../sync/auth.js";
import { mountAccount, openSignIn } from "./account.js";
import { icon } from "./icons.js";
import { wireNewBoardButtons } from "./landing-buttons.js";
import { forgetRecent, recentBoards } from "./recent.js";
import { el, toast } from "./ui.js";

const grid = document.getElementById("grid")!;
const empty = document.getElementById("empty")!;
const sub = document.getElementById("boardsSub")!;
const note = document.getElementById("signinNote")!;

mountAccount(document.getElementById("account")!);
wireNewBoardButtons();
document.getElementById("signinBtn")!.addEventListener("click", () => openSignIn());

function ago(iso: string | number): string {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function card(b: BoardSummary, n: number, opened: string | number, onForget: () => void): HTMLLIElement {
  const li = el("li");
  const a = el("a", "board-card");
  a.href = `/b/${b.id}`;
  a.style.setProperty("--n", String(Math.min(n, 12)));
  const thumb = el("div", "board-thumb");
  if (b.preview) {
    const img = el("img");
    img.alt = "";
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(b.preview)}`;
    thumb.append(img);
  } else thumb.append(el("span", "blank", "Empty board"));
  const meta = el("div", "board-meta");
  meta.append(el("b", undefined, b.title || "Untitled board"), el("span", undefined, ago(opened)));
  a.append(thumb, meta);
  const forget = el("button", "board-forget");
  forget.type = "button";
  forget.innerHTML = icon("close");
  forget.setAttribute("aria-label", `Remove "${b.title}" from this list`);
  forget.title = "Remove from this list (the board itself stays)";
  forget.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onForget();
    li.remove();
    if (!grid.querySelector(".board-card")) empty.hidden = false;
  });
  thumb.append(forget);
  li.append(a);
  return li;
}

async function load(): Promise<void> {
  const user = currentUser();
  note.hidden = !!user;
  sub.textContent = user ? `Every board you've opened, signed in as ${user.name}.` : "Boards you've opened on this device.";
  let list: { b: BoardSummary; opened: string | number }[] = [];
  try {
    if (user) {
      list = (await api.myBoards()).map((b) => ({ b, opened: b.opened_at ?? b.last_active_at }));
    } else {
      const recent = recentBoards();
      const info = await api.boardsInfo(recent.map((r) => r.id));
      const byId = new Map(info.map((b) => [b.id, b]));
      list = recent.filter((r) => byId.has(r.id)).map((r) => ({ b: byId.get(r.id)!, opened: r.at }));
    }
  } catch (e) {
    toast(e instanceof Error ? e.message : "Couldn't load your boards.", { tone: "error" });
  }
  grid.replaceChildren(
    ...list.map(({ b, opened }, n) =>
      card(b, n, opened, () => {
        forgetRecent(b.id);
        if (currentUser()) api.forgetBoard(b.id).catch(() => {});
        toast("Removed from your list. The board still works for anyone with the link.");
      }),
    ),
  );
  empty.hidden = list.length > 0;
}

onAuthChange(() => void load());
document.addEventListener("lattice:signed-in", () => void load());
void load();
