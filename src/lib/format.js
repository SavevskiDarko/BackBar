/* ===========================================================================
   The pure bits: money, dates, reporting periods, subscription state.

   These lived in App.jsx, where nothing could reach them. They are the
   arithmetic a bar's takings are printed from, so they are the part most worth
   testing — see test/format.test.mjs. Nothing here touches React, the DOM or
   the network, which is the whole point.
   =========================================================================== */

export const DAY = 86400000;

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

/* Not every currency is a symbol in front of two decimals. The denar goes
   after the number and is written in whole units — "250 ден", not "MKD250.00".
   Anything not listed falls back to being treated as a leading symbol, so a
   bar can still type something unusual and get a sensible result. */
export const CURRENCIES = {
  MKD: { label: "Denar", sign: "ден", after: true, decimals: 0 },
  RSD: { label: "Dinar", sign: "дин", after: true, decimals: 0 },
  BGN: { label: "Lev", sign: "лв", after: true, decimals: 2 },
  ALL: { label: "Lek", sign: "L", after: true, decimals: 0 },
  EUR: { label: "Euro", sign: "€", after: false, decimals: 2 },
  USD: { label: "Dollar", sign: "$", after: false, decimals: 2 },
  GBP: { label: "Pound", sign: "£", after: false, decimals: 2 },
  CHF: { label: "Franc", sign: "CHF", after: true, decimals: 2 },
  TRY: { label: "Lira", sign: "₺", after: false, decimals: 2 },
};

export const curOf = (cur) =>
  CURRENCIES[String(cur || "EUR").toUpperCase()] ||
  { sign: cur || "€", after: false, decimals: 2 };

/** Just the number, correctly rounded for the currency. Use where a column
    header already carries the sign. */
export function amount(n, cur) {
  const { decimals } = curOf(cur);
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** The full thing: 250 ден · €12.50 */
export function money(n, cur = "EUR") {
  const c = curOf(cur);
  const v = amount(n, cur);
  return c.after ? `${v} ${c.sign}` : `${c.sign}${v}`;
}

/** What a table's lines come to, after the discount. The database decides the
    real figure — this is the same sum, for the screen. */
export function linesTotal(lines, discount = 0) {
  const gross = (lines || []).reduce((a, l) => a + (l.price || 0) * (l.qty || 0), 0);
  return round2(gross * (1 - (discount || 0) / 100));
}

/** What a write the queue gave up on was worth, where its payload still says.
    A close carries no lines, so its figure is only known when it was split
    across methods; null means "we genuinely cannot say", which the screen
    shows as nothing rather than as zero. */
export function failedValue(item) {
  const p = item?.payload || {};
  if (Array.isArray(p.lines) && p.lines.some((l) => l.price != null)) {
    return linesTotal(p.lines, p.discount);
  }
  if (Array.isArray(p.payments) && p.payments.length) {
    return round2(p.payments.reduce((a, x) => a + (Number(x.amount) || 0), 0));
  }
  return null;
}

export function since(ts, now) {
  const m = Math.max(0, Math.floor((now - ts) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function shortDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function daysBetween(a, b) {
  return Math.round((a - b) / DAY);
}

/* ---------------------------------------------------- subscription lifecycle
   This mirrors bar_is_live() in the database. It exists only to render banners
   and pills — the database is what actually enforces access, so a tampered
   copy of this function gains nobody anything. */

export function subState(venue, now) {
  const s = venue.subscription;
  if (s.suspended) return "suspended";
  if (s.trialEndsAt && now < s.trialEndsAt) return "trial";
  if (now <= s.nextDueAt) return "active";
  return daysBetween(now, s.nextDueAt) <= (s.graceDays ?? 7) ? "past_due" : "locked";
}

export const canOperate = (st) => st === "active" || st === "trial" || st === "past_due";

/* ---------------------------------------------------------------- reporting */

export const startOfWeek = (d) => {             // Monday
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};

export const iso = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

/** The range on screen, and how to step it. Everything is a business day —
    see business_day() in reports.sql for why a bar's Friday runs past midnight. */
export function periodRange(mode, anchor) {
  const a = new Date(anchor);
  if (mode === "day") return { from: iso(a), to: iso(a) };
  if (mode === "week") {
    const s = startOfWeek(a);
    const e = new Date(s); e.setDate(s.getDate() + 6);
    return { from: iso(s), to: iso(e) };
  }
  const s = new Date(a.getFullYear(), a.getMonth(), 1);
  const e = new Date(a.getFullYear(), a.getMonth() + 1, 0);
  return { from: iso(s), to: iso(e) };
}

export function periodLabel(mode, anchor, today = new Date()) {
  const a = new Date(anchor);
  if (mode === "day") {
    const same = iso(a) === iso(today);
    const y = new Date(today); y.setDate(today.getDate() - 1);
    if (same) return "Today";
    if (iso(a) === iso(y)) return "Yesterday";
    return a.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  }
  if (mode === "week") {
    const { from, to } = periodRange("week", a);
    const f = new Date(from), t = new Date(to);
    if (iso(startOfWeek(today)) === from) return "This week";
    return `${f.getDate()} – ${t.getDate()} ${t.toLocaleDateString(undefined, { month: "short" })}`;
  }
  if (a.getMonth() === today.getMonth() && a.getFullYear() === today.getFullYear()) return "This month";
  return a.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function stepAnchor(mode, anchor, dir) {
  const a = new Date(anchor);
  if (mode === "day") a.setDate(a.getDate() + dir);
  else if (mode === "week") a.setDate(a.getDate() + 7 * dir);
  else a.setMonth(a.getMonth() + dir);
  return a;
}
