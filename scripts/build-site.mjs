// Assemble the static site: public/ as-is, plus the compiled browser modules under /js.
import { cpSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const out = "dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync("public", out, { recursive: true });

// Only browser code ships: src/ compiled to build/src (tests stay out of the site)
const copyJs = (from, to) => {
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) {
      mkdirSync(dst, { recursive: true });
      copyJs(src, dst);
    } else if (name.endsWith(".js")) {
      cpSync(src, dst);
    }
  }
};
mkdirSync(join(out, "js"), { recursive: true });
copyJs("build/src", join(out, "js"));
console.log("Site built in dist/");
