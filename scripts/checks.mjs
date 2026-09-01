/* The bespoke checks, in one place. ESLint covers hooks, undefined variables,
   duplicate keys and unused bindings; these cover the failures particular to
   this codebase that no general linter knows about.

   They live outside the repo — point CHECKS_DIR at wherever you keep them.
   A machine that doesn't have them (a fresh clone, CI) skips them and still
   passes, because a check you cannot run is not a check that failed. Before
   this, `npm run check` was broken everywhere but the one laptop that held
   them. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DIR = process.env.CHECKS_DIR || "/home/claude";
const list = ["orphans", "unused"];

let bad = 0;
let ran = 0;

for (const c of list) {
  const script = path.join(DIR, `${c}.mjs`);
  if (!fs.existsSync(script)) {
    console.log(`  ${c}: skipped (no ${script})`);
    continue;
  }
  ran++;
  try {
    const out = execFileSync("node", [script], { encoding: "utf8" });
    process.stdout.write(out);
    if (/problem|unreachable|unused prop/i.test(out) && !/^\s*No |Every dialog/m.test(out)) bad++;
  } catch (e) {
    console.error(`  ${c}: failed to run — ${e.message.split("\n")[0]}`);
    bad++;
  }
}

if (!ran) console.log("  no bespoke checks available; lint is the whole check here");

process.exit(bad ? 1 : 0);
