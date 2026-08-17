/* Vite fingerprints JS and CSS but not files copied from public/, so sw.js
   would otherwise ship with whatever cache name it was written with. Stamp it
   with the build time so every deploy retires the previous cache. */
import fs from "node:fs";

const p = "dist/sw.js";
if (!fs.existsSync(p)) {
  console.error("stamp-sw: dist/sw.js not found — did the build run?");
  process.exit(1);
}
const id = Date.now().toString(36);
fs.writeFileSync(p, fs.readFileSync(p, "utf8").replaceAll("__BUILD_ID__", id));
console.log(`  sw.js cache stamped: backbar-shell-${id}`);
