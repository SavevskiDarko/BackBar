import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!URL || !ANON) {
  console.warn("Supabase env vars missing — copy .env.example to .env.local");
}

/* The platform account (you) is a normal Supabase Auth user: email, password,
   and MFA if you turn it on. It's the account that controls billing, so it gets
   real auth rather than a 4-digit PIN. */
export const supabase = createClient(URL, ANON, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "backbar.platform" },
});

/* Staff sessions use a token minted by the staff-login Edge Function, so they
   need their own client carrying that Authorization header. realtime.setAuth
   matters: without it the websocket subscribes as anon and RLS returns nothing,
   which looks exactly like "realtime is broken". */
export function staffClient(token) {
  const c = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  c.realtime.setAuth(token);
  return c;
}

export const FUNCTIONS_URL = `${URL}/functions/v1`;
