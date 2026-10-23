// Copy the compiled CRDT modules into the lattice-index edge function, so the server replays
// boards with exactly the code the browsers run. Run after `npm run build`.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
const from = new URL("../build/src/crdt/", import.meta.url);
const to = new URL("../supabase/functions/lattice-index/crdt/", import.meta.url);
mkdirSync(to, { recursive: true });
for (const f of readdirSync(from).filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(new URL(f, from), "utf8").replace(/\n\/\/# sourceMappingURL=.*$/m, "");
  writeFileSync(new URL(f, to), `// Generated from src/crdt by scripts/copy-crdt.mjs. Do not edit.\n${src}`);
}
console.log("CRDT copied into supabase/functions/lattice-index/crdt");
