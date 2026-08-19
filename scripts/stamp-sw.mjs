/* Vite fingerprints JS and CSS but not files copied from public/, so sw.js
   would otherwise ship with whatever cache name it was written with. Stamp it
   with the build id — the same one the app displays, so a device's visible
   version and its cache always agree. */
import fs from "node:fs";

const sw = "dist/sw.js";
if (!fs.existsSync(sw)) {
  console.error("stamp-sw: dist/sw.js not found — did the build run?");
  process.exit(1);
}

let id;
try {
  id = fs.readFileSync("dist/build-id.txt", "utf8").trim();
} catch {
  id = Date.now().toString(36);
  console.warn("stamp-sw: no build-id.txt, falling back to a timestamp");
}

fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replaceAll("__BUILD_ID__", id));
console.log(`  version ${id} — sw cache backbar-shell-${id}`);
