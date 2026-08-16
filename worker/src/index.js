/* ===========================================================================
   backbar — Cloudflare Worker
   ---------------------------------------------------------------------------
   Serves the whole product from one origin:
     /api/auth   → this script
     everything  → the built React app, straight from the edge

   Because the app and the API share a hostname, there is no CORS in
   production. The only origin check that matters is for local development,
   where Vite runs on :5173.

   POST /api/auth
     { action: "pair",  barCode }       → { barId, barName }
     { action: "login", barCode, pin }  → { token, staff, bar }

   No npm dependencies. It reaches Supabase over PostgREST with plain fetch and
   signs JWTs with WebCrypto, both native to Workers — nothing to bundle and
   effectively no cold start.

   Its own name, its own secrets, its own Supabase project. Shares nothing
   with your Elaks Worker.
   =========================================================================== */

const TOKEN_HOURS = 12; // one shift: long enough to serve, short enough that a
                        // tablet left in a taxi is dead by morning

const MESSAGES = {
  unknown_bar: "No bar uses that code",
  subscription_inactive: "This bar's subscription is not active. Contact Backbar.",
  bad_pin: "That PIN is not recognised here",
  locked: "Too many wrong PINs. Try again in 15 minutes.",
  bad_request: "Malformed request",
  server: "Could not reach the server",
};

/* ------------------------------------------------------------------- helpers */

/* In production the app is served by this same Worker, so requests are
   same-origin and these headers are never needed. They exist for `npm run dev`,
   where Vite serves the app on :5173 and calls the deployed Worker. */
const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

function corsHeaders(req) {
  const origin = req.headers.get("Origin");
  if (!origin || !DEV_ORIGINS.includes(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });

const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** HS256, the algorithm Supabase signs its own tokens with — so PostgREST and
    every RLS policy accept this token exactly as if Supabase Auth issued it. */
async function signJWT(payload, secret) {
  const enc = new TextEncoder();
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${head}.${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

class RpcError extends Error {}

/** Calls a Postgres function through PostgREST using the service_role key.
    That key bypasses RLS, which is exactly why it lives only in Worker secrets
    and never anywhere the browser can see. */
async function rpc(env, fn, args) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });

  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

  if (!res.ok) throw new RpcError(body?.message || body?.hint || `rpc_${res.status}`);
  return body;
}

const firstRow = (v) => (Array.isArray(v) ? v[0] ?? null : v ?? null);

function mapDbError(message = "") {
  if (message.includes("subscription_inactive")) return "subscription_inactive";
  if (message.includes("unknown_bar")) return "unknown_bar";
  return null;
}

const clientIp = (req) =>
  req.headers.get("CF-Connecting-IP") ||
  (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
  "unknown";

/* -------------------------------------------------------------------- worker */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req);

    // run_worker_first only sends /api/* here, but be explicit: anything else
    // that reaches this script gets handed back to the static assets.
    if (url.pathname !== "/api/auth") {
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Not found", { status: 404 });
    }

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return json({ error: MESSAGES.bad_request }, 405, cors);

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: MESSAGES.bad_request }, 400, cors);
    }

    const barCode = String(body.barCode ?? "").trim();
    const ip = clientIp(req);

    if (!/^[0-9]{4}$/.test(barCode)) return json({ error: MESSAGES.unknown_bar }, 400, cors);

    try {
      // Throttle before anything else, so brute force costs the attacker time
      // rather than costing us database work. 8 misses in 15 minutes = locked.
      const locked = await rpc(env, "login_is_locked", { p_bar_code: barCode, p_ip: ip });
      if (locked === true) return json({ error: MESSAGES.locked }, 429, cors);

      /* ---- pair: confirm the code, hand back only the name ---------------- */
      if (body.action === "pair") {
        try {
          const row = firstRow(await rpc(env, "bar_public_info", { p_bar_code: barCode }));
          await rpc(env, "login_record", { p_bar_code: barCode, p_ip: ip, p_ok: true });
          return json({ barId: row.bar_id, barName: row.bar_name }, 200, cors);
        } catch (e) {
          await rpc(env, "login_record", { p_bar_code: barCode, p_ip: ip, p_ok: false });
          const key = mapDbError(e.message) || "unknown_bar";
          return json({ error: MESSAGES[key] }, 403, cors);
        }
      }

      /* ---- login: verify the PIN, mint the token -------------------------- */
      if (body.action !== "login") return json({ error: MESSAGES.bad_request }, 400, cors);

      const pin = String(body.pin ?? "");
      if (!/^[0-9]{4}$/.test(pin)) return json({ error: MESSAGES.bad_pin }, 400, cors);

      let staff;
      try {
        staff = firstRow(await rpc(env, "verify_staff_pin", { p_bar_code: barCode, p_pin: pin }));
      } catch (e) {
        await rpc(env, "login_record", { p_bar_code: barCode, p_ip: ip, p_ok: false });
        const key = mapDbError(e.message) || "unknown_bar";
        return json({ error: MESSAGES[key] }, 403, cors);
      }

      if (!staff) {
        await rpc(env, "login_record", { p_bar_code: barCode, p_ip: ip, p_ok: false });
        return json({ error: MESSAGES.bad_pin }, 401, cors);
      }

      await rpc(env, "login_record", { p_bar_code: barCode, p_ip: ip, p_ok: true });

      const now = Math.floor(Date.now() / 1000);
      // `role: authenticated` is what makes PostgREST accept the token at all.
      // `sub` becomes auth.uid(); the custom claims are what the RLS policies read.
      const token = await signJWT(
        {
          aud: "authenticated",
          role: "authenticated",
          sub: staff.staff_id,
          iat: now,
          exp: now + TOKEN_HOURS * 3600,
          bar_id: staff.bar_id,
          staff_id: staff.staff_id,
          staff_role: staff.staff_role,
          staff_name: staff.staff_name,
          session_id: crypto.randomUUID(),
        },
        env.JWT_SECRET
      );

      return json(
        {
          token,
          expiresAt: Date.now() + TOKEN_HOURS * 3600_000,
          staff: { id: staff.staff_id, name: staff.staff_name, role: staff.staff_role },
          bar: { id: staff.bar_id, name: staff.bar_name },
        },
        200,
        cors
      );
    } catch (e) {
      // Never leak database internals to the login screen.
      console.error("backbar auth", e.message);
      return json({ error: MESSAGES.server }, 500, cors);
    }
  },
};
