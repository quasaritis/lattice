/** Landing page: the live two-replica hero, the tray, the scroll-driven merge stage. */
import { Doc } from "../crdt/doc.js";
import { encodeStroke, BRUSH_SIZE, type Brush } from "../draw/stroke.js";
import { mountAccount } from "./account.js";
import { DemoBoards, arrowLine, check, heart, loopAround, star, underline, type Person } from "./demo.js";
import { wireNewBoardButtons } from "./landing-buttons.js";
import { BoardView } from "./view.js";

const PEOPLE: Person[] = [
  { name: "Asha", device: "laptop", color: "#df3a2e" },
  { name: "Rohan", device: "phone", color: "#1f4fd6" },
];

// ------------------------------------------------------------------ hero

let ids = 0;
const nid = (p: string) => `${p}${(ids++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function heroScript(d: DemoBoards): Promise<void> {
  const plan = nid("plan"), title = nid("ttl");
  d.reset((doc) => [
    ...doc.createItem(title, { kind: "text", x: 34, y: 24, w: 330, h: 46, color: "ink", z: 1 }, "Hack night plan"),
    ...doc.createItem(plan, { kind: "note", x: 40, y: 92, w: 168, h: 122, color: "sun", z: 2 }, "Pitch at 6 pm"),
  ]);
  d.say("Asha and Rohan are on the same board.");
  await d.wait(900);
  await d.draw(0, loopAround(124, 152, 112, 82, 5), "red", "pen", 1100);
  await d.wait(250);
  await d.note(1, 300, 120, "sky", "bring HDMI", 156, 112);
  await d.wait(700);
  d.say("The Wi‑Fi drops. Both keep going.");
  d.cut();
  await d.wait(600);
  await Promise.all([
    (async () => {
      await d.draw(0, star(470, 300, 34), "orange", "pen", 900);
      await d.type(0, plan, " → slides");
      await d.draw(0, underline(42, 74, 210, 7), "yellow", "hl", 650);
    })(),
    (async () => {
      await d.wait(350);
      await d.draw(1, arrowLine({ x: 296, y: 290 }, { x: 222, y: 210 }, 16), "blue", "pen", 800);
      await d.note(1, 120, 250, "rose", "pizza at 9", 150, 104);
    })(),
  ]);
  d.say("Two different boards now. Check the codes above them.");
  await d.wait(2200);
  d.say("Back online. Merging…");
  d.heal();
  await d.settle();
  await d.wait(250);
  d.say("The same board on both. Nobody's work was lost.");
  await d.draw(0, check(520, 64, 36), "green", "marker", 450);
  await d.wait(4200);
}

// ------------------------------------------------------------------ tray (a static board showing every tool)

function trayDoc(): Doc {
  const doc = new Doc("tray", () => 1_700_000_000_000);
  const ink = (id: string, pts: { x: number; y: number }[], color: string, brush: Brush = "pen") => {
    const s = encodeStroke(pts.map((p) => ({ ...p, p: 0.5 })), BRUSH_SIZE[brush] / 2 + 3);
    doc.createItem(id, { kind: "ink", brush, color, x: s.x, y: s.y, w: s.w, h: s.h, d: s.d, z: 20 });
  };
  doc.createItem("t1", { kind: "text", x: 56, y: 40, w: 420, h: 50, color: "ink", z: 1 }, "Demo day, 6 pm");
  ink("h1", underline(56, 78, 300, 3), "yellow", "hl");
  doc.createItem("n1", { kind: "note", x: 60, y: 120, w: 210, h: 170, color: "sun", z: 2 }, "3 min pitch, then a live demo");
  doc.createItem("n2", { kind: "note", x: 296, y: 150, w: 190, h: 150, color: "rose", z: 3 }, "What will judges ask?");
  doc.createItem("r1", { kind: "rect", x: 80, y: 360, w: 170, h: 96, color: "sky", z: 4 }, "Browser");
  doc.createItem("e1", { kind: "ellipse", x: 330, y: 352, w: 190, h: 112, color: "mint", z: 5 }, "Realtime");
  const sa = encodeStroke([{ x: 252, y: 408, p: 0.5 }, { x: 328, y: 408, p: 0.5 }], 20);
  doc.createItem("a1", { kind: "arrow", color: "ink", x: sa.x, y: sa.y, w: sa.w, h: sa.h, d: sa.d, z: 6 });
  doc.createItem("img", { kind: "image", x: 590, y: 70, w: 380, h: 238, z: 7 });
  ink("c1", loopAround(392, 225, 118, 92, 11), "red");
  ink("s1", star(560, 400, 30), "orange");
  ink("hh", heart(640, 410, 2.2), "red", "marker");
  ink("ar", arrowLine({ x: 700, y: 360 }, { x: 760, y: 318 }, 10), "blue");
  doc.createItem("t2", { kind: "text", x: 700, y: 380, w: 290, h: 46, color: "blue", z: 8 }, "pasted screenshot");
  return doc;
}

function mountTray(): void {
  const host = document.getElementById("trayBoard");
  if (!host) return;
  const world = document.createElement("div");
  world.className = "world";
  host.append(world);
  const view = new BoardView(world, trayDoc(), { animateRemote: false });
  view.showLocalImage("img", "/img/screenshot.jpg");
  view.nodes.get("img")?.classList.remove("uploading");
  view.nodes.get("img")?.classList.add("loaded");
  const sizer = document.createElement("div");
  sizer.className = "tray-sizer";
  host.append(sizer);
  const fit = () => {
    const W = host.clientWidth, H = host.clientHeight;
    if (W < 640) {
      // phones: keep the board readable and let it scroll sideways
      const z = H / 540;
      world.style.transform = `translate(8px, ${(H - 500 * z) / 2}px) scale(${z})`;
      sizer.style.width = `${1040 * z + 16}px`;
      return;
    }
    sizer.style.width = "0";
    const z = Math.min(W / 1040, H / 520);
    world.style.transform = `translate(${(W - 1040 * z) / 2}px, ${(H - 500 * z) / 2}px) scale(${z})`;
  };
  new ResizeObserver(fit).observe(host);
  fit();
}

// ------------------------------------------------------------------ merge stage

const scenarios: ((d: DemoBoards) => Promise<void>)[] = [
  async (d) => {
    const n = nid("n");
    d.reset((doc) => doc.createItem(n, { kind: "note", x: 200, y: 110, w: 200, h: 150, color: "sun", z: 1 }, "Old pitch idea"));
    d.say("Both offline.");
    d.cut();
    await d.wait(700);
    await Promise.all([d.remove(0, n), (async () => (await d.wait(250), await d.type(1, n, ", v2")))()]);
    d.say("Asha deleted it. Rohan kept writing.");
    await d.wait(1600);
    d.say("Reconnect…");
    d.heal();
    await d.settle();
    d.say("The note survives on both, with Rohan's edit.");
    await d.wait(3600);
  },
  async (d) => {
    const n = nid("n");
    d.reset((doc) => doc.createItem(n, { kind: "note", x: 220, y: 120, w: 160, h: 130, color: "mint", z: 1 }, "Lunch?"));
    d.say("Both offline.");
    d.cut();
    await d.wait(600);
    await Promise.all([d.drag(0, n, 40, 60), (async () => (await d.wait(500), await d.drag(1, n, 400, 220)))()]);
    d.say("Each sees the note where they left it.");
    await d.wait(1500);
    d.say("Reconnect…");
    d.heal();
    await d.settle();
    d.say("Both pick the later move. Same spot on both screens.");
    await d.wait(3600);
  },
  async (d) => {
    const n = nid("n");
    d.reset((doc) => doc.createItem(n, { kind: "note", x: 170, y: 100, w: 260, h: 160, color: "sky", z: 1 }, "Meet at 6"));
    d.say("Both offline, typing at the same spot.");
    d.cut();
    await d.wait(600);
    await Promise.all([d.type(0, n, " in Lab 2", 9), (async () => (await d.wait(200), await d.type(1, n, " sharp", 9)))()]);
    await d.wait(1200);
    d.say("Reconnect…");
    d.heal();
    await d.settle();
    d.say("Whole words, in the same order, on both.");
    await d.wait(3600);
  },
];

function mountStage(): void {
  const host = document.getElementById("stage");
  if (!host) return;
  const d = new DemoBoards(host, PEOPLE, { compact: true, latency: [80, 260], drop: 0.04 });
  const steps = [...document.querySelectorAll<HTMLElement>(".step")];
  let active = -1;
  const show = (i: number) => {
    if (i === active || d.manual) return;
    active = i;
    steps.forEach((s, k) => s.classList.toggle("on", k === i));
    void d.play(scenarios[i]);
  };
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) show(Number((e.target as HTMLElement).dataset.step));
    },
    { rootMargin: "-45% 0px -45% 0px" },
  );
  steps.forEach((s) => io.observe(s));
  show(0);
}

// ------------------------------------------------------------------ test transcript

/** Output of a real `npm run test:long`, trimmed to the test names and the summary. */
const TEST_OUTPUT = `✔ HLC: timestamps strictly increase even when the wall clock stands still or goes back (7.7ms)
✔ HLC: after receiving a remote timestamp, every local event is ordered after it (causality) (0.5ms)
✔ HLC: fractional physical clocks still give valid timestamps (regression: lab demo dropped every op) (1.1ms)
✔ HLC: refuses timestamps far in the future (0.5ms)
✔ LWW-Map: concurrent writes converge to the highest timestamp, in any order (0.6ms)
✔ OR-Set: a concurrent add beats a remove that never saw it (add-wins) (0.4ms)
✔ OR-Set: remove of everything observed deletes the element everywhere (0.1ms)
✔ RGA: concurrent inserts at the same spot: newer goes first, same result in any order (0.2ms)
✔ RGA: two people typing at the same spot do not interleave letter by letter (1.0ms)
✔ RGA: deleted characters stay as anchors for concurrent inserts (tombstones) (2.0ms)
✔ RGA: a long typed run keeps its order (regression: run ids ':10' once sorted before ':9') (0.7ms)
✔ RGA: emoji and other multi-unit characters stay whole (0.2ms)
✔ Doc: ops that arrive before their dependencies wait, then apply (0.8ms)
✔ Doc: applying the same op many times changes nothing (idempotence) (0.8ms)
✔ Doc: snapshot (state) + later ops equals receiving every op (1.0ms)
✔ Doc: hostile ops are rejected or dropped without breaking the replica (0.2ms)
✔ Strokes: encode → decode keeps the shape to half a pixel, and validates as a field (5.1ms)
✔ Fields: images only point at board storage paths, strokes only carry numbers (1.5ms)
✔ Undo of a delete brings the item back with its props and text (0.4ms)
✔ Editing wins over a concurrent delete (edits re-assert the item with a fresh tag) (3.8ms)
✔ strong eventual consistency over 3000 hostile network schedules (8627ms)
✔ state merge is commutative, associative and idempotent (3000 cases) (3075ms)
✔ op-based and state-based replication agree (3000 cases) (1856ms)
✔ worst case: every op delivered one at a time in reverse order (12ms)
ℹ tests 24
ℹ pass 24
ℹ fail 0
ℹ duration_ms 13764`;

const RUN: [string, string][] = [
  ["cmd", "$ npm run test:long"],
  ["dim", "> SEEDS=3000 node --test build/test/*.test.js"],
  ["", ""],
  ...TEST_OUTPUT.split("\n").filter(Boolean).map((l): [string, string] => [l.startsWith("ℹ") ? "dim" : "ok", l]),
];

function mountTerminal(): void {
  const out = document.getElementById("termOut");
  if (!out) return;
  const lines = RUN;
  out.replaceChildren();
  const pre = out;
  let shown = false;
  const render = (n: number) => {
    pre.replaceChildren(
      ...lines.slice(0, n).map(([cls, text]) => {
        const s = document.createElement("span");
        if (cls) s.className = cls;
        s.textContent = text + "\n";
        return s;
      }),
    );
  };
  render(0);
  new IntersectionObserver((es) => {
    if (shown || !es.some((e) => e.isIntersecting)) return;
    shown = true;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return render(lines.length);
    let n = 0;
    const tick = () => {
      render(++n);
      if (n < lines.length) setTimeout(tick, n < 3 ? 260 : 70);
    };
    tick();
  }, { threshold: 0.4 }).observe(pre);
}

// ------------------------------------------------------------------ boot

wireNewBoardButtons();
const account = document.getElementById("account");
if (account) mountAccount(account);

const heroHost = document.getElementById("heroDemo");
if (heroHost) {
  const hero = new DemoBoards(heroHost, PEOPLE);
  void hero.play(heroScript);
}
mountTray();
mountStage();
mountTerminal();

const flow = document.querySelector(".flow-figure");
if (flow) new IntersectionObserver((es, o) => {
  if (es.some((e) => e.isIntersecting)) {
    flow.classList.add("is-in");
    o.disconnect();
  }
}, { threshold: 0.35 }).observe(flow);
