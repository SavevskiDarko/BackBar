// ===========================================================================
// staff-login — the only way a waiter or bar owner gets into the system.
//
// Two actions:
//   { action: "pair",  barCode }        → { barId, barName }
//   { action: "login", barCode, pin }   → { token, staff, bar }
//
// The browser never sees a PIN hash and never gets to say who it is. This
// function checks the PIN, checks the subscription, and mints a JWT whose
// claims every RLS policy in the database reads. Tamper with the token and
// the signature breaks; drop the claims and every query returns zero rows.
//
// Deploy:
//   supabase functions deploy staff-login --no-verify-jwt
//   supabase secrets set JWT_SECRET="<Settings → API → JWT Secret>"
//
// --no-verify-jwt is correct here: nobody has a token yet when they log in.
// ===========================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { cors, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const JWT_SECRET = Deno.env.get("JWT_SECRET")!;

// A shift is long. Twelve hours means a tablet isn't asking for a PIN mid-service,
// but a device left in a taxi stops working by morning.
const TOKEN_HOURS = 12;

// service_role bypasses RLS. This key must never reach the browser.
const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const signingKey = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(JWT_SECRET),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign", "verify"],
);

function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
}

const MESSAGES: Record<string, string> = {
  unknown_bar: "No bar uses that code",
  subscription_inactive: "This bar's subscription is not active. Contact Backbar.",
  bad_pin: "That PIN is not recognised here",
  locked: "Too many wrong PINs. Try again in 15 minutes.",
  bad_request: "Malformed request",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: MESSAGES.bad_request }, 405);

  let body: { action?: string; barCode?: string; pin?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: MESSAGES.bad_request }, 400);
  }

  const barCode = String(body.barCode ?? "").trim();
  const ip = clientIp(req);

  if (!/^[0-9]{4}$/.test(barCode)) return json({ error: MESSAGES.unknown_bar }, 400);

  // Throttle before touching anything else, so a brute force costs the attacker
  // time rather than costing us database work.
  const { data: locked } = await admin.rpc("login_is_locked", {
    p_bar_code: barCode,
    p_ip: ip,
  });
  if (locked) return json({ error: MESSAGES.locked }, 429);

  // ---- pair: confirm the bar code, hand back only the name -----------------
  if (body.action === "pair") {
    const { data, error } = await admin.rpc("bar_public_info", { p_bar_code: barCode });
    if (error) {
      await admin.rpc("login_record", { p_bar_code: barCode, p_ip: ip, p_ok: false });
      const key = error.message.includes("subscription_inactive")
        ? "subscription_inactive"
        : "unknown_bar";
      return json({ error: MESSAGES[key] }, 403);
    }
    const row = Array.isArray(data) ? data[0] : data;
    await admin.rpc("login_record", { p_bar_code: barCode, p_ip: ip, p_ok: true });
    return json({ barId: row.bar_id, barName: row.bar_name });
  }

  // ---- login: verify the PIN, mint the token -------------------------------
  if (body.action !== "login") return json({ error: MESSAGES.bad_request }, 400);

  const pin = String(body.pin ?? "");
  if (!/^[0-9]{4}$/.test(pin)) return json({ error: MESSAGES.bad_pin }, 400);

  const { data, error } = await admin.rpc("verify_staff_pin", {
    p_bar_code: barCode,
    p_pin: pin,
  });

  if (error) {
    await admin.rpc("login_record", { p_bar_code: barCode, p_ip: ip, p_ok: false });
    const key = error.message.includes("subscription_inactive")
      ? "subscription_inactive"
      : "unknown_bar";
    return json({ error: MESSAGES[key] }, 403);
  }

  const staff = Array.isArray(data) ? data[0] : data;
  if (!staff) {
    await admin.rpc("login_record", { p_bar_code: barCode, p_ip: ip, p_ok: false });
    return json({ error: MESSAGES.bad_pin }, 401);
  }

  await admin.rpc("login_record", { p_bar_code: barCode, p_ip: ip, p_ok: true });

  // `role: authenticated` is what makes PostgREST accept the token at all.
  // `sub` becomes auth.uid(); the custom claims are what the policies read.
  const token = await create(
    { alg: "HS256", typ: "JWT" },
    {
      aud: "authenticated",
      role: "authenticated",
      sub: staff.staff_id,
      iat: getNumericDate(0),
      exp: getNumericDate(60 * 60 * TOKEN_HOURS),
      bar_id: staff.bar_id,
      staff_id: staff.staff_id,
      staff_role: staff.staff_role,
      staff_name: staff.staff_name,
      session_id: crypto.randomUUID(),
    },
    signingKey,
  );

  return json({
    token,
    expiresAt: Date.now() + TOKEN_HOURS * 3600_000,
    staff: {
      id: staff.staff_id,
      name: staff.staff_name,
      role: staff.staff_role,
    },
    bar: { id: staff.bar_id, name: staff.bar_name },
  });
});
