/* A build without VITE_SUPABASE_URL doesn't fail — it silently produces a
   "Not configured yet" stub, because configError becomes a compile-time
   constant and Vite drops the rest of the app as dead code. That is very hard
   to spot: the build is green and the bundle is just smaller.

   So: refuse to build instead. */
import fs from "node:fs";

const NEEDED = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];

// Vite loads .env files itself; this check runs before that, so read them too.
const fromFiles = {};
for (const f of [".env", ".env.local", ".env.production"]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) fromFiles[m[1]] = m[2];
  }
}

const missing = NEEDED.filter((k) => !process.env[k] && !fromFiles[k]);

if (missing.length) {
  console.error(`
  Build stopped: ${missing.join(", ")} not set.

  Without these the bundle compiles to a "Not configured yet" screen and
  nothing else — a green build that ships a broken app.

  Locally:    cp .env.example .env.local and fill it in
  Cloudflare: the Worker's Settings > Build > Variables and secrets
`);
  process.exit(1);
}
