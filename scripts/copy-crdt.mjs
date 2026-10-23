// Copy the compiled CRDT and drawing modules into the lattice-index edge function, so the server
// replays and draws boards with exactly the code the browsers run. Run after `tsc` (npm run build does).
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

/** Drop whole-line comments (the source in src/ keeps them); code lines are left untouched. */
function stripComments(code) {
  const out = [];
  let inBlock = false;
  for (const line of code.split("\n")) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      continue;
    }
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inBlock = true;
      continue;
    }
    if (t.startsWith("//")) continue;
    out.push(line);
  }
  return out.join("\n").trimEnd() + "\n";
}
const dest = new URL("supabase/functions/lattice-index/lib/", root);
const pick = { "crdt/": null, "draw/": null, "app/": ["palette.js"] };

rmSync(new URL("supabase/functions/lattice-index/crdt/", root), { recursive: true, force: true });
rmSync(dest, { recursive: true, force: true });
for (const [dir, only] of Object.entries(pick)) {
  const from = new URL(`build/src/${dir}`, root);
  const to = new URL(dir, dest);
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(from).filter((f) => f.endsWith(".js") && (!only || only.includes(f)))) {
    const src = stripComments(readFileSync(new URL(f, from), "utf8"));
    writeFileSync(new URL(f, to), `// Generated from src/${dir}${f.replace(/\.js$/, ".ts")} by scripts/copy-crdt.mjs. Do not edit.\n${src}`);
  }
}
console.log("CRDT and drawing code copied into supabase/functions/lattice-index/lib");
