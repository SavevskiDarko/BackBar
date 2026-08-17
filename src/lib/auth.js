import { supabase, staffClient, AUTH_URL } from "./supabase";

/* ===========================================================================
   Sessions
   ---------------------------------------------------------------------------
   Device pairing survives restarts (a tablet belongs to one bar for good).
   The staff token does not — it lives in sessionStorage and expires after a
   shift, so a stolen tablet is useless by morning and a closed browser means
   the next person has to enter their own PIN.
   =========================================================================== */

const PAIR_KEY = "backbar.device";
const TOKEN_KEY = "backbar.staff";

export function loadPairing() {
  try {
    return JSON.parse(localStorage.getItem(PAIR_KEY) || "null");
  } catch {
    return null;
  }
}
export function savePairing(bar) {
  localStorage.setItem(PAIR_KEY, JSON.stringify(bar)); // { code, id, name }
}
export function clearPairing() {
  localStorage.removeItem(PAIR_KEY);
  clearStaffSession();
}

export function loadStaffSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null");
    if (!s || s.expiresAt < Date.now()) {
      sessionStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}
function saveStaffSession(s) {
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(s));
}
export function clearStaffSession() {
  sessionStorage.removeItem(TOKEN_KEY);
}

/* --------------------------------------------------------------------------
   Talking to the login function
   -------------------------------------------------------------------------- */

async function callLogin(payload) {
  // AUTH_URL points at the backbar-auth Cloudflare Worker. No apikey header:
  // the Worker holds the service_role key, the browser holds nothing.
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A non-JSON body means the request never reached the Worker at all —
    // usually a routing problem, not a login problem.
    const msg = body.error || `The sign-in service returned ${res.status}. Check /api/health.`;
    throw new Error(msg);
  }
  return body;
}

/** Step 1 — tie this device to one bar. Runs once per tablet. */
export async function pairDevice(barCode) {
  const r = await callLogin({ action: "pair", barCode });
  const bar = {
    id: r.barId, name: r.barName, code: barCode,
    accent: r.accent || null, surface: r.surface || null, logoPath: r.logoPath || null,
  };
  savePairing(bar);
  return bar;
}

/** Step 2 — a PIN, checked only against the paired bar. */
export async function signInStaff(pin) {
  const paired = loadPairing();
  if (!paired) throw new Error("Set up this device first");

  const { token, expiresAt, staff, bar } = await callLogin({
    action: "login",
    barCode: paired.code,
    pin,
  });

  const session = {
    token,
    expiresAt,
    role: staff.role, // 'owner' | 'waiter'
    actorId: staff.id,
    actorName: staff.name,
    barId: bar.id,
    barName: bar.name,
  };
  saveStaffSession(session);
  return session;
}

/** Your own sign-in. Email and password, not a PIN. */
export async function signInPlatform(email, password) {
  if (!supabase) throw new Error("The app is not configured to reach Supabase.");
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error("Wrong email or password");

  const { data: isAdmin } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", data.user.id)
    .maybeSingle();

  if (!isAdmin) {
    await supabase.auth.signOut();
    throw new Error("That account isn't a platform administrator");
  }
  return { role: "platform", actorName: data.user.email, userId: data.user.id };
}

/** Called on every page load. A platform session is a normal Supabase Auth
    session, so it survives a refresh — but we re-check admin status rather
    than trusting a stored flag. */
export async function restorePlatformSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  if (!data?.session) return null;
  const { data: isAdmin } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", data.session.user.id)
    .maybeSingle();
  if (!isAdmin) return null;
  return { role: "platform", actorName: data.session.user.email, userId: data.session.user.id };
}

export async function signOut() {
  clearStaffSession();
  if (supabase) await supabase.auth.signOut();
}

/* --------------------------------------------------------------------------
   Which client should a query use?
   -------------------------------------------------------------------------- */

export function clientFor(session) {
  if (!session) return null;
  return session.role === "platform" ? supabase : staffClient(session.token);
}

/** Wrap calls so an expired shift token drops the user back to the PIN pad
    instead of showing a wall of red errors mid-service. */
export function onExpired(session, handler) {
  if (!session?.expiresAt) return () => {};
  const ms = session.expiresAt - Date.now();
  if (ms <= 0) {
    handler();
    return () => {};
  }
  const t = setTimeout(handler, ms);
  return () => clearTimeout(t);
}
