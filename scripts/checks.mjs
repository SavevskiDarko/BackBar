/* The bespoke checks, in one place. ESLint covers hooks, undefined variables,
   duplicate keys and unused bindings; these cover the failures particular to
   this codebase that no general linter knows about. */
import { execFileSync } from "node:child_process";
const list = ["orphans", "unused"];
let bad = 0;
for (const c of list) {
  try {
    const out = execFileSync("node", [`/home/claude/${c}.mjs`], { encoding: "utf8" });
    process.stdout.write(out);
    if (/problem|unreachable|unused prop/i.test(out) && !/^\s*No |Every dialog/m.test(out)) bad++;
  } catch { bad++; }
}
process.exit(bad ? 1 : 0);
