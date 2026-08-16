import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

/* A missing env var used to throw here at module load, which killed the bundle
   before React mounted — a black screen with no explanation. Now it degrades
   into a message the app can actually show someone. */
export const configError = !URL
  ? "VITE_SUPABASE_URL is missing from the build."
  : !ANON
  ? "VITE_SUPABASE_ANON_KEY is missing from the build."
  : null;

/* The platform account (you) is a normal Supabase Auth user: email, password,
   and MFA if you turn it on. It's the account that controls billing, so it gets
   real auth rather than a 4-digit PIN. */
export const supabase = configError
  ? null
  : createClient(URL, ANON, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: "backbar.platform" },
    });

/* Staff sessions use a token minted by the auth Worker, so they need their own
   client carrying that Authorization header. realtime.setAuth matters: without
   it the websocket subscribes as anon and RLS returns nothing, which looks
   exactly like "realtime is broken". */
export function staffClient(token) {
  if (configError) return null;
  const c = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  c.realtime.setAuth(token);
  return c;
}

/* The auth endpoint. In production the same Worker serves this app, so a
   relative path is correct and there is no CORS. Set VITE_AUTH_URL only for
   `npm run dev`, where Vite is on :5173 and the Worker is elsewhere.
   It is the only endpoint that ever sees a PIN. */
export const AUTH_URL = import.meta.env.VITE_AUTH_URL || "/api/auth";
