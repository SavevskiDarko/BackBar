import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  LayoutGrid, Store, BarChart3, Plus, Minus, Trash2, X, Check, Circle, Square,
  RectangleHorizontal, Users, Clock, CreditCard, Banknote, Search, ChevronRight,
  Copy, Save, Receipt, RotateCw, Loader2, Wine, ListOrdered, LogOut, Delete,
  ShieldCheck, UserPlus, CalendarClock, TrendingUp, AlertTriangle, Lock, ArrowLeft,
  KeyRound, Pause, Play, Wallet,
} from "lucide-react";

/* ============================================================================
   BACKBAR — bar floor & order tracking, sold as a subscription
   Three seats: platform (you) · bar owner (your client) · waiter (their staff)
   ========================================================================== */

const C = {
  ink: "#0A1411", panel: "#101D18", raise: "#16261F", line: "#23392F", line2: "#2F4C40",
  brass: "#E6B450", brassDim: "#8A6C2E", cream: "#F4EDDF", creamDim: "#CFC4AC",
  sage: "#8CA69B", sageDim: "#5C736A", copper: "#D4674A", mint: "#67C9A0",
};
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const PLAN_W = 1000, PLAN_H = 700;
const K_CFG = "backbar:v2:config";
const K_ORD = "backbar:v2:orders";
const K_SAL = "backbar:v2:sales";
const K_DEV = "backbar:v2:device";
const DAY = 86400000;

const PLANS = {
  starter: { id: "starter", name: "Starter", price: 29, maxRooms: 1, maxTables: 16, maxStaff: 3 },
  pro: { id: "pro", name: "Pro", price: 59, maxRooms: 5, maxTables: 60, maxStaff: 15 },
  chain: { id: "chain", name: "Chain", price: 119, maxRooms: 20, maxTables: 400, maxStaff: 100 },
};

/* ---------------------------------------------------------------- utilities */

const uid = (p = "id") => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const money = (n, cur = "€") => `${cur}${(Number.isFinite(n) ? n : 0).toFixed(2)}`;

function since(ts, now) {
  const m = Math.max(0, Math.floor((now - ts) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function shortDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
function addMonth(ts) {
  const d = new Date(ts);
  d.setMonth(d.getMonth() + 1);
  return d.getTime();
}
function daysBetween(a, b) {
  return Math.round((a - b) / DAY);
}
function makeRng(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
// Bar codes are issued by the platform, so they must be unique everywhere.
// PINs are only ever checked inside one bar, so they may repeat across bars.
function newBarCode(taken) {
  let c;
  do { c = String(1000 + Math.floor(Math.random() * 8999)); } while (taken.includes(c));
  return c;
}

/* ---------------------------------------------------- subscription lifecycle */

function subState(venue, now) {
  const s = venue.subscription;
  if (s.suspended) return "suspended";
  if (s.trialEndsAt && now < s.trialEndsAt) return "trial";
  if (now <= s.nextDueAt) return "active";
  return daysBetween(now, s.nextDueAt) <= (s.graceDays ?? 7) ? "past_due" : "locked";
}
const STATE_META = {
  active: { label: "Paid", color: C.mint },
  trial: { label: "Trial", color: C.mint },
  past_due: { label: "Payment due", color: C.brass },
  locked: { label: "Locked — unpaid", color: C.copper },
  suspended: { label: "Suspended", color: C.copper },
};
const canOperate = (st) => st === "active" || st === "trial" || st === "past_due";

/* ------------------------------------------------------------------ storage */

/* Local-only persistence. This is a stand-in: it keeps data on ONE device.
   See supabase/schema.sql for the real multi-device backend. */
const hasStore = typeof window !== "undefined" && !!window.localStorage;
async function sget(key) {
  if (!hasStore) return null;
  try {
    const v = window.localStorage.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch { return null; }
}
async function sset(key, val) {
  if (!hasStore) return false;
  try { window.localStorage.setItem(key, JSON.stringify(val)); return true; } catch { return false; }
}

/* --------------------------------------------------------------- seed data */

function seedArticles() {
  const rows = [
    ["Draft lager 0.3", "Beer", 0.75, 3.0], ["Draft lager 0.5", "Beer", 1.2, 4.2],
    ["IPA bottle", "Beer", 1.6, 5.0], ["Wheat beer", "Beer", 1.4, 4.5],
    ["Alcohol-free beer", "Beer", 0.9, 3.2], ["Negroni", "Cocktails", 2.4, 9.5],
    ["Aperol spritz", "Cocktails", 1.9, 8.0], ["Mojito", "Cocktails", 2.1, 8.5],
    ["Espresso martini", "Cocktails", 2.6, 10.0], ["Gin & tonic", "Cocktails", 2.0, 8.0],
    ["Old fashioned", "Cocktails", 2.8, 11.0], ["Vodka shot", "Spirits", 0.9, 3.5],
    ["Whisky 12y", "Spirits", 2.2, 7.5], ["Dark rum", "Spirits", 1.3, 5.0],
    ["Tequila shot", "Spirits", 1.1, 4.0], ["Herbal shot", "Spirits", 1.0, 3.5],
    ["House red, glass", "Wine", 1.2, 4.5], ["House white, glass", "Wine", 1.2, 4.5],
    ["Prosecco, glass", "Wine", 1.6, 6.0], ["Red bottle 0.75", "Wine", 7.0, 26.0],
    ["Cola 0.25", "Soft", 0.55, 2.5], ["Sparkling water", "Soft", 0.35, 2.2],
    ["Orange juice", "Soft", 0.8, 3.5], ["Tonic water", "Soft", 0.6, 2.8],
    ["Energy drink", "Soft", 1.1, 4.0], ["Espresso", "Coffee", 0.28, 1.8],
    ["Cappuccino", "Coffee", 0.42, 2.6], ["Tea", "Coffee", 0.2, 2.2],
    ["Salted peanuts", "Food", 0.6, 2.5], ["Olives", "Food", 0.9, 3.8],
    ["Nachos", "Food", 1.8, 6.5], ["Club sandwich", "Food", 2.9, 9.0],
  ];
  return rows.map(([name, category, cost, price], i) => ({
    id: `a${i + 1}`, name, category, cost, price, active: true,
  }));
}

const T = (label, shape, x, y, w, h, seats, rot = 0) => ({ id: uid("t"), label, shape, x, y, w, h, seats, rot });

function sub(planId, opts = {}) {
  const now = Date.now();
  return {
    plan: planId,
    price: PLANS[planId].price,
    startedAt: opts.startedAt ?? now - 120 * DAY,
    nextDueAt: opts.nextDueAt ?? now + 18 * DAY,
    trialEndsAt: opts.trialEndsAt ?? null,
    graceDays: 7,
    suspended: opts.suspended ?? false,
    payments: opts.payments ?? [],
  };
}
function pastPayments(n, price, endTs) {
  const out = [];
  for (let i = n; i >= 1; i--) {
    out.push({ id: uid("p"), amount: price, paidAt: endTs - i * 30 * DAY, note: "Card" });
  }
  return out;
}

function seedVenues() {
  const now = Date.now();
  return [
    {
      id: "v1", name: "Neon Lounge", address: "Kralja Petra 14", currency: "€", code: "4821",
      ownerName: "Marko", ownerPin: "1111", allowStaffDiscount: false,
      staff: [
        { id: "s1", name: "Ana", pin: "1234" },
        { id: "s2", name: "Luka", pin: "1235" },
      ],
      subscription: sub("pro", { nextDueAt: now + 18 * DAY, payments: pastPayments(4, 59, now) }),
      zones: [
        {
          id: "z1", name: "Main room",
          tables: [
            T("BAR", "bar", 500, 88, 460, 74, 8),
            T("1", "round", 130, 258, 96, 96, 4), T("2", "round", 290, 258, 96, 96, 4),
            T("3", "round", 450, 258, 96, 96, 4), T("4", "square", 646, 268, 104, 104, 4),
            T("5", "square", 828, 268, 104, 104, 4), T("6", "rect", 176, 438, 168, 96, 6),
            T("7", "rect", 420, 438, 168, 96, 6), T("8", "round", 660, 452, 96, 96, 4),
            T("9", "round", 838, 452, 96, 96, 4), T("10", "round", 190, 606, 88, 88, 3),
            T("11", "round", 372, 606, 88, 88, 3), T("12", "rect", 690, 612, 220, 96, 8),
          ],
        },
        {
          id: "z2", name: "Terrace",
          tables: [
            T("T1", "round", 160, 160, 92, 92, 4), T("T2", "round", 340, 160, 92, 92, 4),
            T("T3", "round", 520, 160, 92, 92, 4), T("T4", "round", 700, 160, 92, 92, 4),
            T("T5", "round", 160, 360, 92, 92, 4), T("T6", "round", 340, 360, 92, 92, 4),
            T("T7", "round", 520, 360, 92, 92, 4), T("T8", "round", 700, 360, 92, 92, 4),
            T("Lounge", "rect", 430, 560, 320, 110, 10),
          ],
        },
      ],
    },
    {
      id: "v2", name: "Harbour Tap", address: "Dock 3", currency: "€", code: "7390",
      ownerName: "Sara", ownerPin: "1111", allowStaffDiscount: true,
      staff: [{ id: "s3", name: "Ivan", pin: "1234" }],
      subscription: sub("starter", { startedAt: now - 6 * DAY, nextDueAt: now + 8 * DAY, trialEndsAt: now + 8 * DAY }),
      zones: [
        {
          id: "z3", name: "Taproom",
          tables: [
            T("BAR", "bar", 220, 100, 340, 70, 6), T("1", "rect", 720, 180, 200, 96, 6),
            T("2", "round", 200, 300, 96, 96, 4), T("3", "round", 380, 300, 96, 96, 4),
            T("4", "round", 200, 480, 96, 96, 4), T("5", "round", 380, 480, 96, 96, 4),
            T("6", "rect", 720, 440, 200, 96, 6),
          ],
        },
      ],
    },
    {
      id: "v3", name: "Kino Bar", address: "Cinema square 2", currency: "€", code: "5514",
      ownerName: "Petra", ownerPin: "1111", allowStaffDiscount: false,
      staff: [{ id: "s4", name: "Nina", pin: "1234" }],
      subscription: sub("starter", { nextDueAt: now - 3 * DAY, payments: pastPayments(2, 29, now - 30 * DAY) }),
      zones: [
        {
          id: "z4", name: "Foyer",
          tables: [
            T("BAR", "bar", 500, 110, 320, 70, 5), T("1", "round", 240, 320, 96, 96, 4),
            T("2", "round", 440, 320, 96, 96, 4), T("3", "round", 640, 320, 96, 96, 4),
            T("4", "rect", 380, 520, 200, 96, 6),
          ],
        },
      ],
    },
    {
      id: "v4", name: "Old Port", address: "Quay 9", currency: "€", code: "6602",
      ownerName: "Dino", ownerPin: "1111", allowStaffDiscount: false,
      staff: [],
      subscription: sub("starter", { nextDueAt: now - 44 * DAY, suspended: true, payments: pastPayments(1, 29, now - 60 * DAY) }),
      zones: [{ id: "z5", name: "Main room", tables: [T("1", "round", 300, 300, 96, 96, 4), T("2", "round", 500, 300, 96, 96, 4)] }],
    },
  ];
}

function seedSales(venues, articles) {
  const rng = makeRng(20260816);
  const now = Date.now();
  const out = [];
  [venues[0], venues[1], venues[2]].forEach((v, vi) => {
    const tables = v.zones.flatMap((z) => z.tables).filter((t) => t.shape !== "bar");
    const staff = v.staff.length ? v.staff : [{ id: "own", name: v.ownerName }];
    const count = vi === 0 ? 26 : 10;
    for (let i = 0; i < count; i++) {
      const minsAgo = 20 + Math.floor(rng() * 400);
      const n = 1 + Math.floor(rng() * 5);
      const lines = [];
      for (let j = 0; j < n; j++) {
        const a = articles[Math.floor(rng() * articles.length)];
        const qty = 1 + Math.floor(rng() * 3);
        const ex = lines.find((l) => l.articleId === a.id);
        if (ex) ex.qty += qty;
        else lines.push({ articleId: a.id, name: a.name, category: a.category, price: a.price, cost: a.cost, qty });
      }
      const total = round2(lines.reduce((s, l) => s + l.price * l.qty, 0));
      const cost = round2(lines.reduce((s, l) => s + l.cost * l.qty, 0));
      const tb = tables[Math.floor(rng() * tables.length)];
      const who = staff[Math.floor(rng() * staff.length)];
      const unpaid = rng() > 0.93;
      out.push({
        id: uid("b"), venueId: v.id, tableLabel: tb.label, closedAt: now - minsAgo * 60000,
        method: unpaid ? null : rng() > 0.45 ? "card" : "cash",
        paid: !unpaid, discount: 0, lines, total, cost, profit: round2(total - cost),
        staffId: who.id, staffName: who.name,
      });
    }
  });
  return out.sort((a, b) => a.closedAt - b.closedAt);
}

function seedOrders(venues, articles) {
  const v = venues[0];
  const main = v.zones[0].tables;
  const pick = (n) => articles.find((a) => a.name === n);
  const mk = (table, items, minsAgo, guests, who) => ({
    key: `${v.id}/${table.id}`, venueId: v.id, tableId: table.id, tableLabel: table.label,
    zoneId: v.zones[0].id, guests, openedAt: Date.now() - minsAgo * 60000,
    staffId: who.id, staffName: who.name,
    lines: items.map(([n, q]) => {
      const a = pick(n);
      return { articleId: a.id, name: a.name, category: a.category, price: a.price, cost: a.cost, qty: q };
    }),
  });
  const [ana, luka] = v.staff;
  const list = [
    mk(main[1], [["Draft lager 0.5", 4], ["Salted peanuts", 2]], 38, 4, ana),
    mk(main[6], [["Aperol spritz", 3], ["Negroni", 2], ["Olives", 1]], 92, 6, luka),
    mk(main[9], [["Espresso", 2], ["Cappuccino", 1]], 12, 2, ana),
    mk(main[12], [["Red bottle 0.75", 2], ["Nachos", 2], ["Sparkling water", 3]], 64, 8, luka),
  ];
  const map = {};
  list.forEach((o) => (map[o.key] = o));
  return map;
}

/* ------------------------------------------------------------- UI primitives */

function Eyebrow({ children, style }) {
  return (
    <div style={{ fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: C.sageDim, ...style }}>
      {children}
    </div>
  );
}

function Btn({ children, onClick, variant = "ghost", size = "md", icon: Icon, disabled, style, title }) {
  const pad = size === "sm" ? "6px 10px" : size === "lg" ? "13px 20px" : "9px 14px";
  const fs = size === "sm" ? 12 : size === "lg" ? 14 : 13;
  const styles = {
    ghost: { background: "transparent", color: C.sage, borderColor: C.line },
    solid: { background: C.brass, color: "#1A1305", borderColor: C.brass },
    quiet: { background: C.raise, color: C.cream, borderColor: C.line },
    danger: { background: "transparent", color: C.copper, borderColor: "rgba(212,103,74,0.35)" },
    bare: { background: "transparent", color: C.sage, borderColor: "transparent" },
  };
  return (
    <button
      type="button" title={title} onClick={disabled ? undefined : onClick}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7,
        padding: pad, fontSize: fs, fontFamily: SANS, fontWeight: 600, borderRadius: 10,
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1,
        transition: "background 140ms, border-color 140ms", border: "1px solid transparent",
        whiteSpace: "nowrap", ...styles[variant], ...style,
      }}
    >
      {Icon && <Icon size={size === "sm" ? 13 : 15} strokeWidth={2.2} />}
      {children}
    </button>
  );
}

function Field({ label, value, onChange, type = "text", suffix, mono, placeholder, step, maxLength }) {
  return (
    <label style={{ display: "block" }}>
      <Eyebrow style={{ marginBottom: 6 }}>{label}</Eyebrow>
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <input
          type={type} step={step} value={value} placeholder={placeholder} maxLength={maxLength}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: "100%", background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9,
            padding: "10px 12px", paddingRight: suffix ? 34 : 12, color: C.cream,
            fontFamily: mono ? MONO : SANS, fontSize: 14, outline: "none",
          }}
          onFocus={(e) => (e.target.style.borderColor = C.brassDim)}
          onBlur={(e) => (e.target.style.borderColor = C.line)}
        />
        {suffix && <span style={{ position: "absolute", right: 12, color: C.sageDim, fontFamily: MONO, fontSize: 12 }}>{suffix}</span>}
      </div>
    </label>
  );
}

function Stat({ label, value, sub, accent }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: "16px 18px", minWidth: 0 }}>
      <Eyebrow>{label}</Eyebrow>
      <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 600, color: accent || C.cream, marginTop: 8, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      {sub && <div style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Pill({ children, color }) {
  return (
    <span style={{
      fontFamily: SANS, fontSize: 11, fontWeight: 700, color, border: `1px solid ${color}55`,
      background: `${color}14`, borderRadius: 99, padding: "3px 9px", whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}

function Modal({ children, onClose, width = 400 }) {
  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, zIndex: 130, background: "rgba(4,10,8,0.74)", backdropFilter: "blur(6px)", display: "grid", placeItems: "center", padding: 16, overflowY: "auto" }}
    >
      <div style={{ width: "100%", maxWidth: width, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 20 }}>
        {children}
      </div>
    </div>
  );
}

function useNow(ms = 25000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
function useWidth(ref) {
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(ref.current);
    setW(ref.current.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/* -------------------------------------------------------------------- login */

function Keypad({ onDigit, onBack, onClear }) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
  const cell = {
    height: 58, borderRadius: 12, border: `1px solid ${C.line}`, background: C.raise,
    color: C.cream, fontFamily: MONO, fontSize: 21, cursor: "pointer",
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 9 }}>
      {keys.map((k) => (
        <button key={k} onClick={() => onDigit(k)} style={cell}>{k}</button>
      ))}
      <button onClick={onClear} style={{ ...cell, color: C.sageDim, fontSize: 12, fontFamily: SANS, fontWeight: 700 }}>CLEAR</button>
      <button onClick={() => onDigit("0")} style={cell}>0</button>
      <button onClick={onBack} style={{ ...cell, display: "grid", placeItems: "center" }}><Delete size={19} color={C.sageDim} /></button>
    </div>
  );
}

function CodeEntry({ length, onSubmit, error, dotLabel }) {
  const [code, setCode] = useState("");

  useEffect(() => { setCode(""); }, [dotLabel]);

  useEffect(() => {
    if (code.length === length) {
      const t = setTimeout(() => { onSubmit(code); setCode(""); }, 120);
      return () => clearTimeout(t);
    }
  }, [code, length, onSubmit]);

  useEffect(() => {
    const h = (e) => {
      if (/^[0-9]$/.test(e.key)) setCode((p) => (p.length < length ? p + e.key : p));
      if (e.key === "Backspace") setCode((p) => p.slice(0, -1));
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [length]);

  return (
    <>
      <div style={{ display: "flex", justifyContent: "center", gap: 11, marginBottom: 8 }}>
        {Array.from({ length }).map((_, i) => (
          <div key={i} style={{
            width: 12, height: 12, borderRadius: 99,
            border: `1.5px solid ${error ? C.copper : code.length > i ? C.brass : C.line2}`,
            background: code.length > i ? (error ? C.copper : C.brass) : "transparent",
            transition: "background 120ms",
          }} />
        ))}
      </div>
      <div style={{ minHeight: 34, textAlign: "center", fontSize: 12.5, color: C.copper, marginBottom: 10, lineHeight: 1.4, padding: "0 8px" }}>
        {error || ""}
      </div>
      <Keypad
        onDigit={(d) => setCode((p) => (p.length < length ? p + d : p))}
        onBack={() => setCode((p) => p.slice(0, -1))}
        onClear={() => setCode("")}
      />
    </>
  );
}

/* The device is tied to one bar. After that, a PIN only has to be unique
   inside that bar — two bars can both have a waiter on 1234. */
function AuthScreen({ platformName, pairedVenue, onPair, onUnpair, onPin, onPlatform, error, clearError }) {
  const [mode, setMode] = useState(pairedVenue ? "pin" : "pair");
  const [hint, setHint] = useState(false);

  useEffect(() => { setMode(pairedVenue ? "pin" : "pair"); }, [pairedVenue]);
  const go = (m) => { clearError(); setMode(m); };

  const heading =
    mode === "platform" ? { title: "Platform sign-in", sub: "Your code runs the whole network" }
    : mode === "pair" ? { title: "Set up this device", sub: "Enter the bar's code — you only do this once" }
    : { title: pairedVenue.name, sub: "Enter your PIN to open the floor" };

  return (
    <div style={{ minHeight: "100vh", background: C.ink, display: "grid", placeItems: "center", padding: 20, fontFamily: SANS }}>
      <div style={{ width: "100%", maxWidth: 330 }}>
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, border: `1.5px solid ${C.brass}`, display: "grid", placeItems: "center", margin: "0 auto 14px", boxShadow: "0 0 30px -6px rgba(230,180,80,0.55)" }}>
            {mode === "platform" ? <ShieldCheck size={21} color={C.brass} /> : <Wine size={22} color={C.brass} />}
          </div>
          <div style={{ fontWeight: 800, fontSize: 10, letterSpacing: "0.28em", color: C.sageDim, marginBottom: 8 }}>
            {platformName.toUpperCase()}
          </div>
          <div style={{ fontWeight: 700, fontSize: 18, color: C.cream }}>{heading.title}</div>
          <div style={{ fontSize: 12.5, color: C.sageDim, marginTop: 5 }}>{heading.sub}</div>
        </div>

        {mode === "pair" && <CodeEntry length={4} onSubmit={onPair} error={error} dotLabel="pair" />}
        {mode === "pin" && <CodeEntry length={4} onSubmit={onPin} error={error} dotLabel="pin" />}
        {mode === "platform" && <CodeEntry length={6} onSubmit={onPlatform} error={error} dotLabel="platform" />}

        <div style={{ display: "flex", justifyContent: "center", gap: 14, marginTop: 18, flexWrap: "wrap" }}>
          {mode === "pin" && (
            <button onClick={() => { onUnpair(); go("pair"); }} style={linkBtn}>Not this bar?</button>
          )}
          {mode !== "platform" && <button onClick={() => go("platform")} style={linkBtn}>I run {platformName}</button>}
          {mode === "platform" && <button onClick={() => go(pairedVenue ? "pin" : "pair")} style={linkBtn}>Back</button>}
        </div>

        <button onClick={() => setHint(!hint)} style={{ ...linkBtn, width: "100%", marginTop: 14 }}>
          {hint ? "Hide demo codes" : "Demo codes"}
        </button>
        {hint && (
          <div style={{ marginTop: 8, background: C.panel, border: `1px dashed ${C.line2}`, borderRadius: 11, padding: 13, fontFamily: MONO, fontSize: 11.5, color: C.sage, lineHeight: 1.85 }}>
            <div style={{ fontFamily: SANS, fontSize: 10, letterSpacing: "0.16em", color: C.sageDim, marginBottom: 5 }}>BAR CODES</div>
            <div><span style={{ color: C.brass }}>4821</span> Neon Lounge · <span style={{ color: C.brass }}>7390</span> Harbour Tap</div>
            <div><span style={{ color: C.brass }}>5514</span> Kino Bar (overdue) · <span style={{ color: C.brass }}>6602</span> Old Port (suspended)</div>
            <div style={{ fontFamily: SANS, fontSize: 10, letterSpacing: "0.16em", color: C.sageDim, margin: "9px 0 5px" }}>PINS — SAME AT EVERY BAR</div>
            <div><span style={{ color: C.brass }}>1111</span> the owner · <span style={{ color: C.brass }}>1234</span> a waiter</div>
            <div style={{ fontFamily: SANS, fontSize: 10, letterSpacing: "0.16em", color: C.sageDim, margin: "9px 0 5px" }}>PLATFORM</div>
            <div><span style={{ color: C.brass }}>900900</span> you</div>
            <div style={{ color: C.sageDim, marginTop: 7, fontFamily: SANS, fontSize: 11 }}>Remove this list before you ship.</div>
          </div>
        )}
      </div>
    </div>
  );
}
const linkBtn = { background: "transparent", border: "none", color: C.sageDim, fontSize: 11.5, cursor: "pointer", fontFamily: SANS, textDecoration: "underline", textUnderlineOffset: 3 };

/* ------------------------------------------------------------ floor drawing */

function SeatPips({ table, scale }) {
  const r = Math.max(2, 3.2 * scale * 1.6);
  const n = clamp(table.seats || 0, 0, 12);
  if (!n) return null;
  const pips = [];
  if (table.shape === "round") {
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
      pips.push({ left: `${50 + 61 * Math.cos(ang)}%`, top: `${50 + 61 * Math.sin(ang)}%` });
    }
  } else {
    const top = Math.ceil(n / 2), bot = n - top;
    for (let i = 0; i < top; i++) pips.push({ left: `${((i + 1) / (top + 1)) * 100}%`, top: "-11%" });
    for (let i = 0; i < bot; i++) pips.push({ left: `${((i + 1) / (bot + 1)) * 100}%`, top: "111%" });
  }
  return pips.map((p, i) => (
    <span key={i} style={{ position: "absolute", left: p.left, top: p.top, width: r, height: r, marginLeft: -r / 2, marginTop: -r / 2, borderRadius: 99, background: C.line2, pointerEvents: "none" }} />
  ));
}

function TableNode({ table, scale, order, selected, onPointerDown, onClick, mode, currency, now, showMoney }) {
  const occupied = !!order;
  const total = occupied ? order.lines.reduce((s, l) => s + l.price * l.qty, 0) : 0;
  const stale = occupied && (now - order.openedAt) / 60000 > 75;
  const isBar = table.shape === "bar";
  const radius = table.shape === "round" ? "50%" : isBar ? 8 : 12;
  const ring = selected ? C.brass : occupied ? (stale ? C.copper : "rgba(230,180,80,0.55)") : C.line2;
  const bg = isBar ? "linear-gradient(180deg,#1D3129,#152520)"
    : occupied ? "linear-gradient(180deg,rgba(230,180,80,0.16),rgba(230,180,80,0.05))"
    : "linear-gradient(180deg,#152521,#101C18)";
  const fs = clamp(13 * scale, 9, 18);

  return (
    <div
      onPointerDown={onPointerDown} onClick={onClick}
      style={{
        position: "absolute", left: `${(table.x / PLAN_W) * 100}%`, top: `${(table.y / PLAN_H) * 100}%`,
        width: `${(table.w / PLAN_W) * 100}%`, height: `${(table.h / PLAN_H) * 100}%`,
        transform: `translate(-50%,-50%) rotate(${table.rot || 0}deg)`,
        cursor: mode === "design" ? "grab" : isBar ? "default" : "pointer",
        touchAction: "none", zIndex: selected ? 30 : occupied ? 20 : 10,
      }}
    >
      {occupied && (
        <div style={{ position: "absolute", inset: "-70%", borderRadius: "50%", pointerEvents: "none",
          background: `radial-gradient(circle, ${stale ? "rgba(212,103,74,0.20)" : "rgba(230,180,80,0.20)"} 0%, rgba(0,0,0,0) 68%)` }} />
      )}
      <SeatPips table={table} scale={scale} />
      <div style={{
        position: "absolute", inset: 0, borderRadius: radius, background: bg,
        border: `${selected ? 2 : 1.5}px solid ${ring}`,
        boxShadow: occupied ? `0 6px 26px -6px ${stale ? "rgba(212,103,74,0.5)" : "rgba(230,180,80,0.45)"}` : "0 2px 10px rgba(0,0,0,0.4)",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, overflow: "hidden",
      }}>
        <div style={{ fontFamily: isBar ? SANS : MONO, fontWeight: 700, fontSize: isBar ? fs * 0.85 : fs, letterSpacing: isBar ? "0.24em" : "0.02em", color: occupied ? C.brass : isBar ? C.sage : C.creamDim }}>
          {table.label}
        </div>
        {occupied && !isBar && showMoney && (
          <div style={{ fontFamily: MONO, fontSize: clamp(11 * scale, 8, 14), color: C.cream, fontVariantNumeric: "tabular-nums" }}>
            {money(total, currency)}
          </div>
        )}
        {occupied && !isBar && scale > 0.55 && (
          <div style={{ fontFamily: MONO, fontSize: clamp(9 * scale, 7, 11), color: stale ? C.copper : C.sageDim }}>
            {since(order.openedAt, now)}
          </div>
        )}
        {!occupied && !isBar && scale > 0.6 && (
          <div style={{ display: "flex", alignItems: "center", gap: 3, color: C.sageDim }}>
            <Users size={clamp(9 * scale, 7, 12)} />
            <span style={{ fontFamily: MONO, fontSize: clamp(9 * scale, 7, 11) }}>{table.seats}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function FloorPlan({ zone, orders, venueId, mode, selectedId, onSelect, onMove, currency, now }) {
  const ref = useRef(null);
  const w = useWidth(ref);
  const scale = w ? w / PLAN_W : 0;
  const drag = useRef(null);

  const toPlan = useCallback((cx, cy) => {
    const r = ref.current.getBoundingClientRect();
    return { x: ((cx - r.left) / r.width) * PLAN_W, y: ((cy - r.top) / r.height) * PLAN_H };
  }, []);

  const down = (e, t) => {
    if (mode !== "design") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toPlan(e.clientX, e.clientY);
    drag.current = { id: t.id, dx: p.x - t.x, dy: p.y - t.y };
    onSelect(t.id);
  };
  const move = (e) => {
    if (!drag.current) return;
    const p = toPlan(e.clientX, e.clientY);
    const t = zone.tables.find((x) => x.id === drag.current.id);
    if (!t) return;
    onMove(t.id,
      clamp(Math.round((p.x - drag.current.dx) / 5) * 5, t.w / 2, PLAN_W - t.w / 2),
      clamp(Math.round((p.y - drag.current.dy) / 5) * 5, t.h / 2, PLAN_H - t.h / 2));
  };

  return (
    <div
      ref={ref} onPointerMove={move} onPointerUp={() => (drag.current = null)} onPointerCancel={() => (drag.current = null)}
      onClick={(e) => e.target === e.currentTarget && mode === "design" && onSelect(null)}
      style={{
        position: "relative", width: "100%", aspectRatio: `${PLAN_W} / ${PLAN_H}`,
        background: `radial-gradient(120% 90% at 50% 0%, rgba(230,180,80,0.05), rgba(0,0,0,0) 55%), linear-gradient(180deg, #0C1815, #08110E)`,
        borderRadius: 16, border: `1px solid ${C.line}`, overflow: "hidden", userSelect: "none",
      }}
    >
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        backgroundImage: `linear-gradient(${C.line}55 1px, transparent 1px), linear-gradient(90deg, ${C.line}55 1px, transparent 1px)`,
        backgroundSize: `${(50 / PLAN_W) * 100}% ${(50 / PLAN_H) * 100}%`,
        opacity: mode === "design" ? 0.75 : 0.28,
      }} />
      {zone.tables.map((t) => (
        <TableNode
          key={t.id} table={t} scale={scale} currency={currency} now={now} showMoney
          order={orders[`${venueId}/${t.id}`]} selected={selectedId === t.id} mode={mode}
          onPointerDown={(e) => down(e, t)}
          onClick={() => {
            if (mode === "design") onSelect(t.id);
            else if (t.shape !== "bar" && !drag.current) onSelect(t.id);
          }}
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- order sheet */

function OrderSheet({ table, zone, venue, order, articles, onClose, onCommit, onSettle, now, canSeeCost, canDiscount, actorName }) {
  const [lines, setLines] = useState(order ? order.lines.map((l) => ({ ...l })) : []);
  const [guests, setGuests] = useState(order ? order.guests : table.seats || 2);
  const [cat, setCat] = useState("All");
  const [q, setQ] = useState("");
  const [paying, setPaying] = useState(false);
  const [discount, setDiscount] = useState(0);

  const cats = useMemo(() => ["All", ...Array.from(new Set(articles.map((a) => a.category)))], [articles]);
  const shown = useMemo(() => articles.filter((a) =>
    a.active !== false && (cat === "All" || a.category === cat) && (!q || a.name.toLowerCase().includes(q.toLowerCase()))
  ), [articles, cat, q]);

  const gross = round2(lines.reduce((s, l) => s + l.price * l.qty, 0));
  const disc = round2((gross * discount) / 100);
  const total = round2(gross - disc);
  const cost = round2(lines.reduce((s, l) => s + l.cost * l.qty, 0));

  const add = (a) => setLines((prev) => {
    const i = prev.findIndex((l) => l.articleId === a.id);
    if (i >= 0) { const n = [...prev]; n[i] = { ...n[i], qty: n[i].qty + 1 }; return n; }
    return [...prev, { articleId: a.id, name: a.name, category: a.category, price: a.price, cost: a.cost, qty: 1 }];
  });
  const bump = (id, d) => setLines((prev) => prev.map((l) => (l.articleId === id ? { ...l, qty: l.qty + d } : l)).filter((l) => l.qty > 0));

  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(4,10,8,0.72)", backdropFilter: "blur(6px)", display: "flex" }}
    >
      <div style={{ width: "100%", maxWidth: 1080, margin: "auto", maxHeight: "100%", display: "flex", flexDirection: "column", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 18, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderBottom: `1px solid ${C.line}`, flexShrink: 0 }}>
          <div style={{ width: 44, height: 44, borderRadius: 11, border: `1.5px solid ${C.brass}`, display: "grid", placeItems: "center", fontFamily: MONO, fontWeight: 700, color: C.brass, fontSize: 16, flexShrink: 0 }}>
            {table.label}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 15 }}>Table {table.label}</div>
            <div style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim }}>
              {zone.name} · {order ? `open ${since(order.openedAt, now)} · ${order.staffName}` : `new bill · ${actorName}`}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Users size={14} color={C.sageDim} />
            <Btn size="sm" variant="bare" onClick={() => setGuests(Math.max(1, guests - 1))} icon={Minus} />
            <span style={{ fontFamily: MONO, color: C.cream, width: 18, textAlign: "center" }}>{guests}</span>
            <Btn size="sm" variant="bare" onClick={() => setGuests(guests + 1)} icon={Plus} />
          </div>
          <Btn variant="bare" icon={X} onClick={onClose} />
        </div>

        <div style={{ display: "flex", flex: 1, minHeight: 0, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 340px", minWidth: 280, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ padding: "12px 16px 8px" }}>
              <div style={{ position: "relative" }}>
                <Search size={14} color={C.sageDim} style={{ position: "absolute", left: 11, top: 11 }} />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a drink"
                  style={{ width: "100%", background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9, padding: "9px 12px 9px 32px", color: C.cream, fontFamily: SANS, fontSize: 13, outline: "none" }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, overflowX: "auto", padding: "0 16px 10px" }}>
              {cats.map((c) => (
                <button key={c} onClick={() => setCat(c)} style={{
                  padding: "6px 11px", borderRadius: 99, border: `1px solid ${cat === c ? C.brass : C.line}`,
                  background: cat === c ? "rgba(230,180,80,0.12)" : "transparent", color: cat === c ? C.brass : C.sage,
                  fontFamily: SANS, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer",
                }}>{c}</button>
              ))}
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "0 16px 16px", display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(132px,1fr))", gap: 8, alignContent: "start" }}>
              {shown.map((a) => (
                <button key={a.id} onClick={() => add(a)} style={{
                  textAlign: "left", background: C.raise, border: `1px solid ${C.line}`, borderRadius: 11,
                  padding: "10px 11px", cursor: "pointer", minHeight: 66, display: "flex", flexDirection: "column", justifyContent: "space-between",
                }}>
                  <span style={{ fontFamily: SANS, fontSize: 12.5, color: C.cream, lineHeight: 1.25 }}>{a.name}</span>
                  <span style={{ fontFamily: MONO, fontSize: 12, color: C.brass, marginTop: 6 }}>{money(a.price, venue.currency)}</span>
                </button>
              ))}
              {!shown.length && <div style={{ color: C.sageDim, fontFamily: SANS, fontSize: 13, gridColumn: "1/-1", padding: 12 }}>Nothing matches. Try another category.</div>}
            </div>
          </div>

          <div style={{ flex: "1 1 320px", minWidth: 288, background: C.cream, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ height: 10, background: `repeating-linear-gradient(90deg, ${C.cream} 0 8px, rgba(0,0,0,0.12) 8px 12px)`, flexShrink: 0 }} />
            <div style={{ padding: "14px 18px 6px", flexShrink: 0 }}>
              <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: "0.2em", color: "#8A7F66" }}>{venue.name.toUpperCase()}</div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: "#8A7F66", marginTop: 2 }}>TABLE {table.label} · {guests} GUESTS · {actorName.toUpperCase()}</div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 18px" }}>
              {!lines.length && <div style={{ fontFamily: MONO, fontSize: 12, color: "#9C927A", padding: "20px 0" }}>Nothing ordered yet. Tap a drink to start the bill.</div>}
              {lines.map((l) => (
                <div key={l.articleId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px dashed rgba(0,0,0,0.13)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                    <button onClick={() => bump(l.articleId, -1)} style={{ border: "none", background: "transparent", cursor: "pointer", color: "#6B6250", padding: 3 }}><Minus size={13} /></button>
                    <span style={{ fontFamily: MONO, fontSize: 13, width: 20, textAlign: "center", color: "#221E15" }}>{l.qty}</span>
                    <button onClick={() => bump(l.articleId, 1)} style={{ border: "none", background: "transparent", cursor: "pointer", color: "#6B6250", padding: 3 }}><Plus size={13} /></button>
                  </div>
                  <div style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 12.5, color: "#221E15" }}>{l.name}</div>
                  <div style={{ fontFamily: MONO, fontSize: 12.5, color: "#221E15", fontVariantNumeric: "tabular-nums" }}>{money(l.price * l.qty, venue.currency)}</div>
                </div>
              ))}
            </div>

            <div style={{ padding: "10px 18px 16px", borderTop: "1px solid rgba(0,0,0,0.15)", flexShrink: 0 }}>
              {discount > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 12, color: "#6B6250" }}>
                  <span>DISCOUNT {discount}%</span><span>-{money(disc, venue.currency)}</span>
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4 }}>
                <span style={{ fontFamily: MONO, fontSize: 12, letterSpacing: "0.18em", color: "#6B6250" }}>TOTAL</span>
                <span style={{ fontFamily: MONO, fontSize: 28, fontWeight: 700, color: "#1A1608", fontVariantNumeric: "tabular-nums" }}>{money(total, venue.currency)}</span>
              </div>
              {canSeeCost && (
                <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#9C927A", marginTop: 2 }}>
                  cost {money(cost, venue.currency)} · profit {money(total - cost, venue.currency)}
                </div>
              )}

              {!paying ? (
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <Btn variant="quiet" onClick={() => onCommit(lines, guests)} icon={Save} style={{ flex: 1, background: "#221E15", color: C.cream, borderColor: "#221E15" }}>Save order</Btn>
                  <Btn variant="solid" disabled={!lines.length} onClick={() => setPaying(true)} icon={Receipt} style={{ flex: 1 }}>Close bill</Btn>
                </div>
              ) : (
                <div style={{ marginTop: 14 }}>
                  {canDiscount && (
                    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                      {[0, 5, 10, 20].map((d) => (
                        <button key={d} onClick={() => setDiscount(d)} style={{
                          flex: 1, padding: "7px 0", borderRadius: 8,
                          border: `1px solid ${discount === d ? "#221E15" : "rgba(0,0,0,0.18)"}`,
                          background: discount === d ? "#221E15" : "transparent",
                          color: discount === d ? C.cream : "#6B6250", fontFamily: MONO, fontSize: 12, cursor: "pointer",
                        }}>{d === 0 ? "no disc." : `-${d}%`}</button>
                      ))}
                    </div>
                  )}
                  <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.16em", color: "#8A7F66", marginBottom: 7 }}>DID THEY PAY?</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Btn variant="quiet" icon={Banknote} onClick={() => onSettle(lines, "cash", true, discount, total, cost)} style={{ flex: 1, background: "#221E15", color: C.cream, borderColor: "#221E15" }}>Cash</Btn>
                    <Btn variant="solid" icon={CreditCard} onClick={() => onSettle(lines, "card", true, discount, total, cost)} style={{ flex: 1 }}>Card</Btn>
                  </div>
                  <Btn variant="ghost" icon={AlertTriangle} onClick={() => onSettle(lines, null, false, discount, total, cost)}
                    style={{ width: "100%", marginTop: 8, color: "#8A5A2E", borderColor: "rgba(0,0,0,0.2)" }}>
                    Not paid — leave on the tab
                  </Btn>
                  <Btn variant="bare" onClick={() => setPaying(false)} style={{ width: "100%", marginTop: 4, color: "#6B6250" }}>Back</Btn>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- designer */

function Designer({ venue, zoneId, setZoneId, updateVenue, orders, now, flash }) {
  const [sel, setSel] = useState(null);
  const plan = PLANS[venue.subscription.plan];
  const zone = venue.zones.find((z) => z.id === zoneId) || venue.zones[0];
  const table = zone.tables.find((t) => t.id === sel);
  const tableCount = venue.zones.reduce((s, z) => s + z.tables.length, 0);

  const writeZone = (fn) => updateVenue({ ...venue, zones: venue.zones.map((z) => (z.id === zone.id ? fn(z) : z)) });
  const move = (id, x, y) => writeZone((z) => ({ ...z, tables: z.tables.map((t) => (t.id === id ? { ...t, x, y } : t)) }));
  const patch = (id, p) => writeZone((z) => ({ ...z, tables: z.tables.map((t) => (t.id === id ? { ...t, ...p } : t)) }));

  const addTable = (shape) => {
    if (tableCount >= plan.maxTables) return flash(`${plan.name} covers ${plan.maxTables} tables. Ask your provider to upgrade.`);
    const n = zone.tables.filter((t) => t.shape !== "bar").length + 1;
    const preset = {
      round: { w: 96, h: 96, seats: 4, label: String(n) },
      square: { w: 100, h: 100, seats: 4, label: String(n) },
      rect: { w: 180, h: 96, seats: 6, label: String(n) },
      bar: { w: 360, h: 72, seats: 6, label: "BAR" },
    }[shape];
    const t = { id: uid("t"), shape, x: 500, y: 350, rot: 0, ...preset };
    writeZone((z) => ({ ...z, tables: [...z.tables, t] }));
    setSel(t.id);
  };

  const addZone = () => {
    if (venue.zones.length >= plan.maxRooms) return flash(`${plan.name} covers ${plan.maxRooms} room${plan.maxRooms > 1 ? "s" : ""}. Upgrade to add more.`);
    const z = { id: uid("z"), name: `Room ${venue.zones.length + 1}`, tables: [] };
    updateVenue({ ...venue, zones: [...venue.zones, z] });
    setZoneId(z.id);
    setSel(null);
  };

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 460px", minWidth: 300 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          {venue.zones.map((z) => (
            <button key={z.id} onClick={() => { setZoneId(z.id); setSel(null); }} style={{
              padding: "7px 13px", borderRadius: 9, border: `1px solid ${z.id === zone.id ? C.brass : C.line}`,
              background: z.id === zone.id ? "rgba(230,180,80,0.1)" : "transparent",
              color: z.id === zone.id ? C.brass : C.sage, fontFamily: SANS, fontWeight: 600, fontSize: 13, cursor: "pointer",
            }}>
              {z.name}<span style={{ fontFamily: MONO, fontSize: 11, opacity: 0.6, marginLeft: 7 }}>{z.tables.length}</span>
            </button>
          ))}
          <Btn size="sm" icon={Plus} onClick={addZone}>Room</Btn>
          <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 11.5, color: C.sageDim }}>
            {tableCount}/{plan.maxTables} tables · {plan.name}
          </span>
        </div>

        <FloorPlan zone={zone} orders={orders} venueId={venue.id} mode="design" selectedId={sel} onSelect={setSel} onMove={move} currency={venue.currency} now={now} />

        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <Btn icon={Circle} onClick={() => addTable("round")}>Round table</Btn>
          <Btn icon={Square} onClick={() => addTable("square")}>Square table</Btn>
          <Btn icon={RectangleHorizontal} onClick={() => addTable("rect")}>Long table</Btn>
          <Btn icon={Wine} onClick={() => addTable("bar")}>Bar counter</Btn>
        </div>
        <div style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim, marginTop: 10 }}>Drag anything to reposition. Everything saves as you go.</div>
      </div>

      <div style={{ flex: "0 1 280px", minWidth: 250, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16 }}>
        {!table ? (
          <div>
            <Eyebrow>Room</Eyebrow>
            <div style={{ marginTop: 12 }}>
              <Field label="Room name" value={zone.name} onChange={(v) => writeZone((z) => ({ ...z, name: v }))} />
            </div>
            <div style={{ marginTop: 14, fontFamily: SANS, fontSize: 13, color: C.sageDim, lineHeight: 1.6 }}>
              Pick a table on the plan to rename it, change its seats, or resize it.
            </div>
            {venue.zones.length > 1 && (
              <Btn variant="danger" icon={Trash2} style={{ marginTop: 16, width: "100%" }} onClick={() => {
                const rest = venue.zones.filter((z) => z.id !== zone.id);
                updateVenue({ ...venue, zones: rest });
                setZoneId(rest[0].id);
              }}>Delete room</Btn>
            )}
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Eyebrow>Selected table</Eyebrow>
              <Btn size="sm" variant="bare" icon={X} onClick={() => setSel(null)} />
            </div>
            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
              <Field label="Label" value={table.label} onChange={(v) => patch(table.id, { label: v })} mono />
              <div>
                <Eyebrow style={{ marginBottom: 6 }}>Seats</Eyebrow>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Btn size="sm" icon={Minus} onClick={() => patch(table.id, { seats: Math.max(0, table.seats - 1) })} />
                  <span style={{ fontFamily: MONO, fontSize: 18, color: C.cream, width: 26, textAlign: "center" }}>{table.seats}</span>
                  <Btn size="sm" icon={Plus} onClick={() => patch(table.id, { seats: Math.min(14, table.seats + 1) })} />
                </div>
              </div>
              <div>
                <Eyebrow style={{ marginBottom: 6 }}>Width</Eyebrow>
                <input type="range" min={60} max={380} value={table.w} style={{ width: "100%", accentColor: C.brass }}
                  onChange={(e) => {
                    const w = +e.target.value;
                    patch(table.id, { w, h: table.shape === "round" || table.shape === "square" ? w : table.h });
                  }} />
              </div>
              {table.shape !== "round" && table.shape !== "square" && (
                <div>
                  <Eyebrow style={{ marginBottom: 6 }}>Depth</Eyebrow>
                  <input type="range" min={50} max={200} value={table.h} onChange={(e) => patch(table.id, { h: +e.target.value })} style={{ width: "100%", accentColor: C.brass }} />
                </div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <Btn icon={RotateCw} style={{ flex: 1 }} onClick={() => patch(table.id, { rot: ((table.rot || 0) + 45) % 360 })}>Rotate</Btn>
                <Btn icon={Copy} style={{ flex: 1 }} onClick={() => {
                  if (tableCount >= plan.maxTables) return flash(`${plan.name} covers ${plan.maxTables} tables.`);
                  const c = { ...table, id: uid("t"), x: clamp(table.x + 60, 0, PLAN_W), y: clamp(table.y + 40, 0, PLAN_H) };
                  writeZone((z) => ({ ...z, tables: [...z.tables, c] }));
                  setSel(c.id);
                }}>Duplicate</Btn>
              </div>
              <Btn variant="danger" icon={Trash2} style={{ width: "100%" }} onClick={() => {
                writeZone((z) => ({ ...z, tables: z.tables.filter((t) => t.id !== table.id) }));
                setSel(null);
              }}>Remove table</Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- price list */

function PriceList({ articles, setArticles, currency }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("All");
  const [editing, setEditing] = useState(null);
  const cats = useMemo(() => ["All", ...Array.from(new Set(articles.map((a) => a.category)))], [articles]);
  const shown = articles.filter((a) => (cat === "All" || a.category === cat) && (!q || a.name.toLowerCase().includes(q.toLowerCase())));
  const avgMargin = articles.length ? articles.reduce((s, a) => s + (a.price ? (a.price - a.cost) / a.price : 0), 0) / articles.length : 0;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 18 }}>
        <Stat label="Articles" value={articles.length} />
        <Stat label="Average margin" value={`${(avgMargin * 100).toFixed(0)}%`} accent={C.brass} />
        <Stat label="Categories" value={cats.length - 1} />
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 200px" }}>
          <Search size={14} color={C.sageDim} style={{ position: "absolute", left: 11, top: 11 }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an article"
            style={{ width: "100%", background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9, padding: "9px 12px 9px 32px", color: C.cream, fontFamily: SANS, fontSize: 13, outline: "none" }} />
        </div>
        <Btn variant="solid" icon={Plus} onClick={() => setEditing({ id: uid("a"), name: "", category: cat === "All" ? "Beer" : cat, cost: 0, price: 0, active: true })}>New article</Btn>
      </div>

      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 12 }}>
        {cats.map((c) => (
          <button key={c} onClick={() => setCat(c)} style={{
            padding: "6px 11px", borderRadius: 99, border: `1px solid ${cat === c ? C.brass : C.line}`,
            background: cat === c ? "rgba(230,180,80,0.1)" : "transparent", color: cat === c ? C.brass : C.sage,
            fontFamily: SANS, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer",
          }}>{c}</button>
        ))}
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 82px 82px 76px 40px", gap: 8, padding: "10px 14px", borderBottom: `1px solid ${C.line}`, background: C.raise }}>
          <Eyebrow>Article</Eyebrow>
          <Eyebrow style={{ textAlign: "right" }}>Buy</Eyebrow>
          <Eyebrow style={{ textAlign: "right" }}>Sell</Eyebrow>
          <Eyebrow style={{ textAlign: "right" }}>Margin</Eyebrow>
          <span />
        </div>
        <div style={{ maxHeight: 460, overflowY: "auto" }}>
          {shown.map((a) => {
            const m = a.price ? (a.price - a.cost) / a.price : 0;
            return (
              <div key={a.id} style={{ display: "grid", gridTemplateColumns: "1fr 82px 82px 76px 40px", gap: 8, padding: "11px 14px", borderBottom: `1px solid ${C.line}55`, alignItems: "center" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: SANS, fontSize: 13.5, color: C.cream, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.sageDim }}>{a.category}</div>
                </div>
                <div style={{ fontFamily: MONO, fontSize: 13, color: C.sage, textAlign: "right" }}>{a.cost.toFixed(2)}</div>
                <div style={{ fontFamily: MONO, fontSize: 13, color: C.cream, textAlign: "right" }}>{a.price.toFixed(2)}</div>
                <div style={{ textAlign: "right", fontFamily: MONO, fontSize: 12, color: m > 0.65 ? C.mint : m > 0.4 ? C.brass : C.copper }}>{(m * 100).toFixed(0)}%</div>
                <button onClick={() => setEditing({ ...a })} style={{ background: "transparent", border: "none", color: C.sageDim, cursor: "pointer", justifySelf: "end" }}><ChevronRight size={16} /></button>
              </div>
            );
          })}
          {!shown.length && <div style={{ padding: 20, fontFamily: SANS, fontSize: 13, color: C.sageDim }}>No articles here yet. Add one to start pricing.</div>}
        </div>
      </div>

      {editing && (
        <Modal onClose={() => setEditing(null)} width={380}>
          <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16, marginBottom: 16 }}>
            {articles.some((a) => a.id === editing.id) ? "Edit article" : "New article"}
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            <Field label="Name" value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} placeholder="Draft lager 0.5" />
            <Field label="Category" value={editing.category} onChange={(v) => setEditing({ ...editing, category: v })} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Purchase price" type="number" step="0.01" mono suffix={currency} value={editing.cost} onChange={(v) => setEditing({ ...editing, cost: v })} />
              <Field label="Selling price" type="number" step="0.01" mono suffix={currency} value={editing.price} onChange={(v) => setEditing({ ...editing, price: v })} />
            </div>
            <div style={{ background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9, padding: "10px 12px", display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim }}>Profit per unit</span>
              <span style={{ fontFamily: MONO, fontSize: 13, color: C.brass }}>{money(Number(editing.price || 0) - Number(editing.cost || 0), currency)}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            {articles.some((a) => a.id === editing.id) && (
              <Btn variant="danger" icon={Trash2} onClick={() => { setArticles(articles.filter((a) => a.id !== editing.id)); setEditing(null); }} />
            )}
            <Btn variant="ghost" style={{ flex: 1 }} onClick={() => setEditing(null)}>Cancel</Btn>
            <Btn variant="solid" icon={Check} style={{ flex: 1 }} onClick={() => {
              const clean = { ...editing, name: editing.name.trim() || "Untitled", cost: round2(Number(editing.cost) || 0), price: round2(Number(editing.price) || 0) };
              setArticles(articles.some((a) => a.id === clean.id) ? articles.map((a) => (a.id === clean.id ? clean : a)) : [...articles, clean]);
              setEditing(null);
            }}>Save</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ owner reports */

function Reports({ sales, orders, venue, onSettleUnpaid }) {
  const [range, setRange] = useState("today");
  const cur = venue.currency;
  const now = Date.now();
  const from = range === "today" ? new Date().setHours(0, 0, 0, 0) : now - 7 * DAY;
  const bills = sales.filter((b) => b.venueId === venue.id && b.closedAt >= from);
  const paidBills = bills.filter((b) => b.paid);

  const revenue = round2(paidBills.reduce((s, b) => s + b.total, 0));
  const cost = round2(paidBills.reduce((s, b) => s + b.cost, 0));
  const profit = round2(revenue - cost);
  const margin = revenue ? (profit / revenue) * 100 : 0;
  const avg = paidBills.length ? revenue / paidBills.length : 0;

  const unpaid = sales.filter((b) => b.venueId === venue.id && !b.paid);
  const unpaidTotal = round2(unpaid.reduce((s, b) => s + b.total, 0));

  const open = Object.values(orders).filter((o) => o.venueId === venue.id);
  const openValue = round2(open.reduce((s, o) => s + o.lines.reduce((x, l) => x + l.price * l.qty, 0), 0));

  const byHour = useMemo(() => {
    const h = Array(24).fill(0);
    paidBills.forEach((b) => (h[new Date(b.closedAt).getHours()] += b.total));
    return h;
  }, [paidBills]);
  const peak = Math.max(...byHour, 0.01);
  const act = byHour.map((v, i) => ({ v, i })).filter((x) => x.v > 0);
  const firstH = act.length ? act[0].i : 8, lastH = act.length ? act[act.length - 1].i : 23;

  const byArticle = useMemo(() => {
    const m = new Map();
    paidBills.forEach((b) => b.lines.forEach((l) => {
      const e = m.get(l.articleId) || { name: l.name, category: l.category, qty: 0, rev: 0, cost: 0 };
      e.qty += l.qty; e.rev += l.price * l.qty; e.cost += l.cost * l.qty;
      m.set(l.articleId, e);
    }));
    return Array.from(m.values()).map((e) => ({ ...e, profit: e.rev - e.cost })).sort((a, b) => b.profit - a.profit);
  }, [paidBills]);

  const byStaff = useMemo(() => {
    const m = new Map();
    paidBills.forEach((b) => {
      const e = m.get(b.staffId) || { name: b.staffName, bills: 0, rev: 0 };
      e.bills++; e.rev += b.total;
      m.set(b.staffId, e);
    });
    return Array.from(m.values()).sort((a, b) => b.rev - a.rev);
  }, [paidBills]);
  const staffMax = byStaff.length ? byStaff[0].rev : 1;

  const cash = round2(paidBills.filter((b) => b.method === "cash").reduce((s, b) => s + b.total, 0));

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {[["today", "Today"], ["week", "Last 7 days"]].map(([k, l]) => (
          <button key={k} onClick={() => setRange(k)} style={{
            padding: "7px 14px", borderRadius: 9, border: `1px solid ${range === k ? C.brass : C.line}`,
            background: range === k ? "rgba(230,180,80,0.1)" : "transparent", color: range === k ? C.brass : C.sage,
            fontFamily: SANS, fontWeight: 600, fontSize: 13, cursor: "pointer",
          }}>{l}</button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(148px,1fr))", gap: 12 }}>
        <Stat label="Collected" value={money(revenue, cur)} sub={`${paidBills.length} paid bills`} />
        <Stat label="Goods cost" value={money(cost, cur)} sub="what it cost you" />
        <Stat label="Profit" value={money(profit, cur)} accent={C.brass} sub={`${margin.toFixed(0)}% margin`} />
        <Stat label="Average bill" value={money(avg, cur)} sub={`cash ${money(cash, cur)} · card ${money(revenue - cash, cur)}`} />
        <Stat label="Still open" value={money(openValue, cur)} accent={open.length ? C.mint : C.cream} sub={`${open.length} tables running`} />
        <Stat label="Unpaid" value={money(unpaidTotal, cur)} accent={unpaid.length ? C.copper : C.cream} sub={`${unpaid.length} bills on the tab`} />
      </div>

      {unpaid.length > 0 && (
        <div style={{ marginTop: 16, background: C.panel, border: `1px solid rgba(212,103,74,0.35)`, borderRadius: 14, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 8 }}>
            <AlertTriangle size={14} color={C.copper} />
            <Eyebrow style={{ color: C.copper }}>Bills marked not paid</Eyebrow>
          </div>
          {unpaid.map((b) => (
            <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", borderBottom: `1px solid ${C.line}55`, flexWrap: "wrap" }}>
              <span style={{ fontFamily: MONO, fontWeight: 700, color: C.brass, width: 40 }}>{b.tableLabel}</span>
              <span style={{ fontFamily: SANS, fontSize: 12.5, color: C.sage, flex: 1, minWidth: 120 }}>
                {b.staffName} · {shortDate(b.closedAt)} {new Date(b.closedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 15, color: C.cream }}>{money(b.total, cur)}</span>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn size="sm" icon={Banknote} onClick={() => onSettleUnpaid(b.id, "cash")}>Cash</Btn>
                <Btn size="sm" variant="solid" icon={CreditCard} onClick={() => onSettleUnpaid(b.id, "card")}>Card</Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 16, marginTop: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 380px", minWidth: 280, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18 }}>
          <Eyebrow>Takings by hour</Eyebrow>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 150, marginTop: 16 }}>
            {byHour.slice(firstH, lastH + 1).map((v, i) => (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <div title={money(v, cur)} style={{
                  width: "100%", height: `${Math.max(2, (v / peak) * 118)}px`, borderRadius: "4px 4px 2px 2px",
                  background: v === peak && v > 0 ? `linear-gradient(180deg, ${C.brass}, ${C.brassDim})` : "linear-gradient(180deg, #34564A, #22392F)",
                }} />
                <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.sageDim }}>{firstH + i}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ flex: "1 1 260px", minWidth: 240, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18 }}>
          <Eyebrow>Taken by each waiter</Eyebrow>
          <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
            {byStaff.map((s, i) => (
              <div key={i}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                  <span style={{ fontFamily: SANS, fontSize: 12.5, color: C.cream }}>{s.name}</span>
                  <span style={{ fontFamily: MONO, fontSize: 12, color: C.sage }}>{money(s.rev, cur)} · {s.bills}</span>
                </div>
                <div style={{ height: 5, background: C.raise, borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ width: `${(s.rev / staffMax) * 100}%`, height: "100%", background: C.brass, borderRadius: 99 }} />
                </div>
              </div>
            ))}
            {!byStaff.length && <div style={{ fontFamily: SANS, fontSize: 13, color: C.sageDim }}>No closed bills in this period yet.</div>}
          </div>
        </div>
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, marginTop: 16, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 54px 88px 88px", gap: 8, padding: "11px 16px", background: C.raise, borderBottom: `1px solid ${C.line}` }}>
          <Eyebrow>Best earners</Eyebrow>
          <Eyebrow style={{ textAlign: "right" }}>Qty</Eyebrow>
          <Eyebrow style={{ textAlign: "right" }}>Sold</Eyebrow>
          <Eyebrow style={{ textAlign: "right" }}>Profit</Eyebrow>
        </div>
        <div style={{ maxHeight: 340, overflowY: "auto" }}>
          {byArticle.slice(0, 14).map((a, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 54px 88px 88px", gap: 8, padding: "10px 16px", borderBottom: `1px solid ${C.line}55`, alignItems: "center" }}>
              <div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <span style={{ fontFamily: SANS, fontSize: 13, color: C.cream }}>{a.name}</span>
                <span style={{ fontFamily: SANS, fontSize: 11, color: C.sageDim, marginLeft: 8 }}>{a.category}</span>
              </div>
              <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.sage, textAlign: "right" }}>{a.qty}</span>
              <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.creamDim, textAlign: "right" }}>{money(a.rev, cur)}</span>
              <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.brass, textAlign: "right" }}>{money(a.profit, cur)}</span>
            </div>
          ))}
          {!byArticle.length && <div style={{ padding: 20, fontFamily: SANS, fontSize: 13, color: C.sageDim }}>Close a table and it will show up here.</div>}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- owner team */

function Team({ venue, updateVenue, flash }) {
  const [editing, setEditing] = useState(null);
  const plan = PLANS[venue.subscription.plan];

  const save = (s) => {
    const pin = String(s.pin).replace(/\D/g, "").slice(0, 4);
    if (pin.length !== 4) return flash("A PIN must be 4 digits.");
    // Only this bar's PINs matter — other bars are on their own devices.
    const taken = [{ id: venue.id, pin: venue.ownerPin }, ...venue.staff.map((x) => ({ id: x.id, pin: x.pin }))];
    if (taken.some((p) => p.pin === pin && p.id !== s.id)) return flash("Someone here already uses that PIN. Pick another.");
    const exists = venue.staff.some((x) => x.id === s.id);
    updateVenue({
      ...venue,
      staff: exists ? venue.staff.map((x) => (x.id === s.id ? { ...s, pin } : x)) : [...venue.staff, { ...s, pin }],
    });
    setEditing(null);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div>
          <Eyebrow>Your team</Eyebrow>
          <div style={{ fontFamily: SANS, fontSize: 13, color: C.sageDim, marginTop: 4 }}>
            Waiters sign in with their own PIN. Every bill records who took it.
          </div>
        </div>
        <Btn variant="solid" icon={UserPlus} onClick={() => {
          if (venue.staff.length >= plan.maxStaff) return flash(`${plan.name} covers ${plan.maxStaff} waiters.`);
          setEditing({ id: uid("s"), name: "", pin: "" });
        }}>Add waiter</Btn>
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, overflow: "hidden", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: `1px solid ${C.line}` }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: "rgba(230,180,80,0.12)", border: `1px solid ${C.brassDim}`, display: "grid", placeItems: "center" }}>
            <ShieldCheck size={15} color={C.brass} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: SANS, fontSize: 14, color: C.cream, fontWeight: 600 }}>{venue.ownerName}</div>
            <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim }}>Owner — sees money, floor plan and prices</div>
          </div>
          <span style={{ fontFamily: MONO, fontSize: 14, color: C.sage, letterSpacing: "0.25em" }}>{venue.ownerPin}</span>
        </div>
        {venue.staff.map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", borderBottom: `1px solid ${C.line}55` }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: C.raise, border: `1px solid ${C.line}`, display: "grid", placeItems: "center", fontFamily: MONO, color: C.sage, fontSize: 13 }}>
              {s.name.slice(0, 1).toUpperCase() || "?"}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: SANS, fontSize: 14, color: C.cream, fontWeight: 600 }}>{s.name}</div>
              <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim }}>Waiter — orders and payments only</div>
            </div>
            <span style={{ fontFamily: MONO, fontSize: 14, color: C.sage, letterSpacing: "0.25em" }}>{s.pin}</span>
            <Btn size="sm" variant="bare" icon={KeyRound} onClick={() => setEditing({ ...s })} />
            <Btn size="sm" variant="bare" icon={Trash2} style={{ color: C.sageDim }} onClick={() => updateVenue({ ...venue, staff: venue.staff.filter((x) => x.id !== s.id) })} />
          </div>
        ))}
        {!venue.staff.length && <div style={{ padding: 20, fontFamily: SANS, fontSize: 13, color: C.sageDim }}>No waiters yet. Add one so they can start taking orders.</div>}
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontFamily: SANS, fontSize: 14, color: C.cream, fontWeight: 600 }}>Let waiters give discounts</div>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim, marginTop: 3 }}>Off by default, so nobody discounts a bill without you.</div>
        </div>
        <button onClick={() => updateVenue({ ...venue, allowStaffDiscount: !venue.allowStaffDiscount })} style={{
          width: 50, height: 28, borderRadius: 99, border: `1px solid ${venue.allowStaffDiscount ? C.brass : C.line2}`,
          background: venue.allowStaffDiscount ? "rgba(230,180,80,0.2)" : C.raise, cursor: "pointer", position: "relative", padding: 0,
        }}>
          <span style={{
            position: "absolute", top: 3, left: venue.allowStaffDiscount ? 25 : 3, width: 20, height: 20,
            borderRadius: 99, background: venue.allowStaffDiscount ? C.brass : C.sageDim, transition: "left 150ms",
          }} />
        </button>
      </div>

      {editing && (
        <Modal onClose={() => setEditing(null)} width={340}>
          <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16, marginBottom: 16 }}>
            {venue.staff.some((s) => s.id === editing.id) ? "Edit waiter" : "Add waiter"}
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            <Field label="Name" value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} placeholder="Ana" />
            <Field label="4-digit PIN" value={editing.pin} onChange={(v) => setEditing({ ...editing, pin: v.replace(/\D/g, "").slice(0, 4) })} mono maxLength={4} placeholder="1234" />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            <Btn variant="ghost" style={{ flex: 1 }} onClick={() => setEditing(null)}>Cancel</Btn>
            <Btn variant="solid" icon={Check} style={{ flex: 1 }} onClick={() => save({ ...editing, name: editing.name.trim() || "Waiter" })}>Save</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ platform side */

function AdminBars({ venues, setVenues, sales, orders, now, openAsOwner, allCodes, flash }) {
  const [detail, setDetail] = useState(null);
  const [adding, setAdding] = useState(null);

  const states = venues.map((v) => subState(v, now));
  const mrr = venues.reduce((s, v, i) => s + (canOperate(states[i]) ? v.subscription.price : 0), 0);
  const overdue = venues.filter((_, i) => states[i] === "past_due" || states[i] === "locked");
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const collected = venues.reduce((s, v) => s + v.subscription.payments.filter((p) => p.paidAt >= monthStart).reduce((x, p) => x + p.amount, 0), 0);

  const recordPayment = (v) => {
    const s = v.subscription;
    const base = Math.max(now, s.nextDueAt);
    setVenues((prev) => prev.map((x) => x.id === v.id ? {
      ...x, subscription: {
        ...s, suspended: false, trialEndsAt: null, nextDueAt: addMonth(base),
        payments: [...s.payments, { id: uid("p"), amount: s.price, paidAt: now, note: "Recorded manually" }],
      },
    } : x));
    flash(`${v.name} marked paid until ${shortDate(addMonth(base))}`);
  };
  const toggleSuspend = (v) => {
    setVenues((prev) => prev.map((x) => x.id === v.id ? { ...x, subscription: { ...x.subscription, suspended: !x.subscription.suspended } } : x));
    flash(v.subscription.suspended ? `${v.name} reactivated` : `${v.name} suspended — nobody there can sign in`);
  };
  const changePlan = (v, planId) => {
    setVenues((prev) => prev.map((x) => x.id === v.id ? { ...x, subscription: { ...x.subscription, plan: planId, price: PLANS[planId].price } } : x));
  };

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 18 }}>
        <Stat label="Monthly recurring" value={money(mrr)} accent={C.brass} sub={`${venues.length} bars on the books`} />
        <Stat label="Collected this month" value={money(collected)} sub="payments you logged" />
        <Stat label="Chasing" value={money(overdue.reduce((s, v) => s + v.subscription.price, 0))} accent={overdue.length ? C.copper : C.cream} sub={`${overdue.length} bars behind`} />
        <Stat label="Paying now" value={venues.filter((_, i) => states[i] === "active").length} sub={`${venues.filter((_, i) => states[i] === "trial").length} on trial`} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12 }}>
        <Eyebrow>Your bars</Eyebrow>
        <Btn variant="solid" icon={Plus} onClick={() => setAdding({
          id: uid("v"), name: "", address: "", currency: "€", ownerName: "", ownerPin: "",
          plan: "starter", trialDays: 14,
        })}>Add a bar</Btn>
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, overflow: "hidden" }}>
        {venues.map((v, i) => {
          const st = states[i], meta = STATE_META[st];
          const today = sales.filter((b) => b.venueId === v.id && b.paid && b.closedAt >= new Date().setHours(0, 0, 0, 0));
          const openN = Object.values(orders).filter((o) => o.venueId === v.id).length;
          return (
            <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderBottom: `1px solid ${C.line}55`, flexWrap: "wrap" }}>
              <div style={{ minWidth: 160, flex: "1 1 160px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 15, color: C.cream }}>{v.name}</span>
                  <Pill color={meta.color}>{meta.label}</Pill>
                </div>
                <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim, marginTop: 3 }}>
                  {v.ownerName} · {v.address} · {v.staff.length} waiters
                </div>
              </div>
              <div style={{ minWidth: 92 }}>
                <Eyebrow>Plan</Eyebrow>
                <div style={{ fontFamily: MONO, fontSize: 13, color: C.cream, marginTop: 3 }}>{PLANS[v.subscription.plan].name} · {money(v.subscription.price)}</div>
              </div>
              <div style={{ minWidth: 104 }}>
                <Eyebrow>{st === "trial" ? "Trial ends" : "Next payment"}</Eyebrow>
                <div style={{ fontFamily: MONO, fontSize: 13, color: st === "past_due" || st === "locked" ? C.copper : C.cream, marginTop: 3 }}>
                  {shortDate(st === "trial" ? v.subscription.trialEndsAt : v.subscription.nextDueAt)}
                </div>
              </div>
              <div style={{ minWidth: 88 }}>
                <Eyebrow>Their day</Eyebrow>
                <div style={{ fontFamily: MONO, fontSize: 13, color: C.sage, marginTop: 3 }}>
                  {money(round2(today.reduce((s, b) => s + b.total, 0)), v.currency)}{openN ? ` · ${openN} open` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                <Btn size="sm" variant="solid" icon={Wallet} onClick={() => recordPayment(v)}>Mark paid</Btn>
                <Btn size="sm" onClick={() => setDetail(v.id)}>Manage</Btn>
              </div>
            </div>
          );
        })}
      </div>

      {detail && (() => {
        const v = venues.find((x) => x.id === detail);
        if (!v) return null;
        const st = subState(v, now), meta = STATE_META[st];
        return (
          <Modal onClose={() => setDetail(null)} width={470}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <span style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 18 }}>{v.name}</span>
              <Pill color={meta.color}>{meta.label}</Pill>
            </div>
            <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, marginBottom: 18 }}>{v.ownerName} · {v.address}</div>

            <Eyebrow style={{ marginBottom: 8 }}>Plan</Eyebrow>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {Object.values(PLANS).map((p) => (
                <button key={p.id} onClick={() => changePlan(v, p.id)} style={{
                  flex: 1, padding: "11px 8px", borderRadius: 11, cursor: "pointer",
                  border: `1px solid ${v.subscription.plan === p.id ? C.brass : C.line}`,
                  background: v.subscription.plan === p.id ? "rgba(230,180,80,0.1)" : "transparent",
                }}>
                  <div style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 700, color: v.subscription.plan === p.id ? C.brass : C.cream }}>{p.name}</div>
                  <div style={{ fontFamily: MONO, fontSize: 12, color: C.sage, marginTop: 3 }}>{money(p.price)}/mo</div>
                  <div style={{ fontFamily: SANS, fontSize: 10.5, color: C.sageDim, marginTop: 4 }}>{p.maxTables} tables · {p.maxStaff} staff</div>
                </button>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              <Btn variant="solid" icon={Wallet} onClick={() => recordPayment(v)} style={{ flex: 1 }}>Record {money(v.subscription.price)} payment</Btn>
              <Btn variant={v.subscription.suspended ? "quiet" : "danger"} icon={v.subscription.suspended ? Play : Pause} onClick={() => toggleSuspend(v)}>
                {v.subscription.suspended ? "Reactivate" : "Suspend"}
              </Btn>
            </div>

            <Btn icon={LayoutGrid} style={{ width: "100%", marginBottom: 16 }} onClick={() => { setDetail(null); openAsOwner(v.id); }}>
              Open this bar as the owner
            </Btn>

            <Eyebrow style={{ marginBottom: 8 }}>Bar code — put this into their tablets once</Eyebrow>
            <div style={{ background: C.ink, border: `1px dashed ${C.line2}`, borderRadius: 10, padding: "12px 14px", marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontFamily: MONO, fontSize: 26, color: C.brass, letterSpacing: "0.28em" }}>{v.code}</span>
              <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim, flex: 1, lineHeight: 1.45 }}>
                Unique across every bar you sell to. Regenerating it signs out their devices.
              </span>
              <Btn size="sm" icon={RotateCw} title="Issue a new code" onClick={() => {
                const code = newBarCode(allCodes);
                setVenues((prev) => prev.map((x) => (x.id === v.id ? { ...x, code } : x)));
                flash(`${v.name} now uses bar code ${code}`);
              }} />
            </div>

            <Eyebrow style={{ marginBottom: 8 }}>PINs inside this bar</Eyebrow>
            <div style={{ background: C.ink, border: `1px dashed ${C.line2}`, borderRadius: 10, padding: 12, marginBottom: 16, fontFamily: MONO, fontSize: 12.5, color: C.sage, lineHeight: 1.9 }}>
              <div><span style={{ color: C.brass }}>{v.ownerPin}</span> — {v.ownerName} (owner)</div>
              {v.staff.map((s) => <div key={s.id}><span style={{ color: C.brass }}>{s.pin}</span> — {s.name} (waiter)</div>)}
              <div style={{ fontFamily: SANS, fontSize: 11, color: C.sageDim, marginTop: 6 }}>
                These only work on a device paired to {v.name}. Other bars may use the same numbers.
              </div>
            </div>

            <Eyebrow style={{ marginBottom: 8 }}>Payment history</Eyebrow>
            <div style={{ maxHeight: 160, overflowY: "auto" }}>
              {[...v.subscription.payments].reverse().map((p) => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.line}55`, fontFamily: MONO, fontSize: 12.5 }}>
                  <span style={{ color: C.sage }}>{shortDate(p.paidAt)}</span>
                  <span style={{ color: C.sageDim, fontFamily: SANS, fontSize: 11.5 }}>{p.note}</span>
                  <span style={{ color: C.cream }}>{money(p.amount)}</span>
                </div>
              ))}
              {!v.subscription.payments.length && <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim }}>No payments recorded yet.</div>}
            </div>

            <Btn variant="ghost" style={{ width: "100%", marginTop: 16 }} onClick={() => setDetail(null)}>Close</Btn>
          </Modal>
        );
      })()}

      {adding && (
        <Modal onClose={() => setAdding(null)} width={400}>
          <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 17, marginBottom: 4 }}>Add a bar</div>
          <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, marginBottom: 18 }}>They get an empty room to lay out and a trial to try it.</div>
          <div style={{ display: "grid", gap: 12 }}>
            <Field label="Bar name" value={adding.name} onChange={(v) => setAdding({ ...adding, name: v })} placeholder="Neon Lounge" />
            <Field label="Address" value={adding.address} onChange={(v) => setAdding({ ...adding, address: v })} placeholder="Main street 1" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Owner name" value={adding.ownerName} onChange={(v) => setAdding({ ...adding, ownerName: v })} placeholder="Marko" />
              <Field label="Owner PIN" value={adding.ownerPin} onChange={(v) => setAdding({ ...adding, ownerPin: v.replace(/\D/g, "").slice(0, 4) })} mono maxLength={4} placeholder="1111" />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Currency" value={adding.currency} onChange={(v) => setAdding({ ...adding, currency: v })} mono />
              <Field label="Trial days" type="number" value={adding.trialDays} onChange={(v) => setAdding({ ...adding, trialDays: v })} mono />
            </div>
            <div>
              <Eyebrow style={{ marginBottom: 6 }}>Plan</Eyebrow>
              <div style={{ display: "flex", gap: 8 }}>
                {Object.values(PLANS).map((p) => (
                  <button key={p.id} onClick={() => setAdding({ ...adding, plan: p.id })} style={{
                    flex: 1, padding: "9px 6px", borderRadius: 10, cursor: "pointer",
                    border: `1px solid ${adding.plan === p.id ? C.brass : C.line}`,
                    background: adding.plan === p.id ? "rgba(230,180,80,0.1)" : "transparent",
                    color: adding.plan === p.id ? C.brass : C.sage, fontFamily: SANS, fontSize: 12, fontWeight: 700,
                  }}>{p.name}<div style={{ fontFamily: MONO, fontSize: 11, opacity: 0.8, marginTop: 2 }}>{money(p.price)}</div></button>
                ))}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            <Btn variant="ghost" style={{ flex: 1 }} onClick={() => setAdding(null)}>Cancel</Btn>
            <Btn variant="solid" icon={Check} style={{ flex: 1 }} onClick={() => {
              const pin = adding.ownerPin;
              if (pin.length !== 4) return flash("The owner needs a 4-digit PIN.");
              const code = newBarCode(allCodes);
              const days = Math.max(0, Number(adding.trialDays) || 0);
              const trialEnd = days ? now + days * DAY : null;
              setVenues((prev) => [...prev, {
                id: adding.id, name: adding.name.trim() || "New bar", address: adding.address,
                currency: adding.currency || "€", code,
                ownerName: adding.ownerName.trim() || "Owner", ownerPin: pin, allowStaffDiscount: false, staff: [],
                subscription: {
                  plan: adding.plan, price: PLANS[adding.plan].price, startedAt: now,
                  nextDueAt: trialEnd || now, trialEndsAt: trialEnd, graceDays: 7, suspended: false, payments: [],
                },
                zones: [{ id: uid("z"), name: "Main room", tables: [] }],
              }]);
              setAdding(null);
              flash(`${adding.name || "New bar"} added — bar code ${code}, owner PIN ${pin}`);
            }}>Create bar</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- app */

export default function App() {
  const [ready, setReady] = useState(false);
  const [platform, setPlatform] = useState({ name: "Backbar", adminPin: "900900" });
  const [venues, setVenues] = useState([]);
  const [articles, setArticles] = useState([]);
  const [orders, setOrders] = useState({});
  const [sales, setSales] = useState([]);
  const [session, setSession] = useState(null); // {role, venueId, actorId, actorName, support}
  const [deviceVenueId, setDeviceVenueId] = useState(null); // which bar this tablet belongs to
  const [loginError, setLoginError] = useState("");
  const [tab, setTab] = useState("floor");
  const [zoneId, setZoneId] = useState(null);
  const [openTableId, setOpenTableId] = useState(null);
  const [toast, setToast] = useState(null);
  const now = useNow(20000);

  useEffect(() => {
    let dead = false;
    (async () => {
      const cfg = await sget(K_CFG);
      const ord = await sget(K_ORD);
      const sal = await sget(K_SAL);
      const dev = await sget(K_DEV);
      if (dead) return;
      if (dev && dev.venueId) setDeviceVenueId(dev.venueId);
      if (cfg && cfg.venues && cfg.venues.length) {
        setPlatform(cfg.platform || { name: "Backbar", adminPin: "900900" });
        setVenues(cfg.venues);
        setArticles(cfg.articles || seedArticles());
        setOrders(ord || {});
        setSales(sal || []);
      } else {
        const v = seedVenues(), a = seedArticles();
        setVenues(v); setArticles(a);
        setOrders(seedOrders(v, a));
        setSales(seedSales(v, a));
      }
      setReady(true);
    })();
    return () => { dead = true; };
  }, []);

  const saveT = useRef(null);
  useEffect(() => {
    if (!ready) return;
    clearTimeout(saveT.current);
    saveT.current = setTimeout(() => {
      sset(K_CFG, { platform, venues, articles });
      sset(K_ORD, orders);
      sset(K_SAL, sales);
    }, 500);
    return () => clearTimeout(saveT.current);
  }, [ready, platform, venues, articles, orders, sales]);

  useEffect(() => {
    if (ready) sset(K_DEV, { venueId: deviceVenueId });
  }, [ready, deviceVenueId]);

  const flash = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const allCodes = useMemo(() => venues.map((v) => v.code), [venues]);
  const pairedVenue = useMemo(() => venues.find((v) => v.id === deviceVenueId) || null, [venues, deviceVenueId]);

  // Step 1: tie this device to one bar. Bar codes are issued by the platform,
  // so they are unique everywhere.
  const pairDevice = useCallback((code) => {
    const v = venues.find((x) => x.code === code);
    if (!v) return setLoginError("No bar uses that code");
    const st = subState(v, Date.now());
    if (!canOperate(st)) {
      return setLoginError(st === "suspended"
        ? `${v.name} is suspended. Contact ${platform.name}.`
        : `${v.name} has an unpaid subscription. Contact ${platform.name}.`);
    }
    setLoginError("");
    setDeviceVenueId(v.id);
    flash(`This device is set up for ${v.name}`);
  }, [venues, platform, flash]);

  // Step 2: PINs are only ever checked inside the paired bar, so two bars
  // can both hand a waiter 1234 without ever colliding.
  const resolvePin = useCallback((pin) => {
    const v = pairedVenue;
    if (!v) return setLoginError("Set up this device first");
    const st = subState(v, Date.now());
    if (!canOperate(st)) return setLoginError(`${v.name} is locked. Ask the owner.`);
    setLoginError("");
    if (v.ownerPin === pin) {
      setSession({ role: "owner", venueId: v.id, actorId: v.id, actorName: v.ownerName });
      setZoneId(v.zones[0]?.id); setTab("floor");
      return;
    }
    const s = v.staff.find((x) => x.pin === pin);
    if (s) {
      setSession({ role: "waiter", venueId: v.id, actorId: s.id, actorName: s.name });
      setZoneId(v.zones[0]?.id); setTab("floor");
      return;
    }
    setLoginError(`Nobody at ${v.name} uses that PIN`);
  }, [pairedVenue]);

  const resolvePlatform = useCallback((code) => {
    if (code !== platform.adminPin) return setLoginError("That is not your platform code");
    setLoginError("");
    setSession({ role: "platform", actorName: "Platform" });
    setTab("bars");
  }, [platform]);

  const venue = session?.venueId ? venues.find((v) => v.id === session.venueId) : null;
  useEffect(() => {
    if (venue && (!zoneId || !venue.zones.some((z) => z.id === zoneId))) setZoneId(venue.zones[0]?.id);
  }, [venue, zoneId]);

  const zone = venue?.zones.find((z) => z.id === zoneId) || venue?.zones[0];
  const table = zone?.tables.find((t) => t.id === openTableId);
  const orderKey = venue && table ? `${venue.id}/${table.id}` : null;
  const updateVenue = (v) => setVenues((prev) => prev.map((x) => (x.id === v.id ? v : x)));

  const commitOrder = (lines, guests) => {
    if (!orderKey) return;
    setOrders((prev) => {
      const next = { ...prev };
      if (!lines.length) delete next[orderKey];
      else next[orderKey] = {
        key: orderKey, venueId: venue.id, tableId: table.id, tableLabel: table.label, zoneId: zone.id,
        guests, openedAt: prev[orderKey]?.openedAt || Date.now(),
        staffId: prev[orderKey]?.staffId || session.actorId, staffName: prev[orderKey]?.staffName || session.actorName,
        lines,
      };
      return next;
    });
    setOpenTableId(null);
    flash(`Table ${table.label} saved`);
  };

  const settleOrder = (lines, method, paid, discount, total, cost) => {
    const existing = orders[orderKey];
    setSales((prev) => [...prev, {
      id: uid("b"), venueId: venue.id, tableLabel: table.label, closedAt: Date.now(),
      method, paid, discount, lines, total, cost, profit: round2(total - cost),
      staffId: existing?.staffId || session.actorId, staffName: existing?.staffName || session.actorName,
    }]);
    setOrders((prev) => { const n = { ...prev }; delete n[orderKey]; return n; });
    setOpenTableId(null);
    flash(paid ? `Table ${table.label} paid — ${money(total, venue.currency)}` : `Table ${table.label} closed unpaid — sent to the owner`);
  };

  const settleUnpaid = (billId, method) => {
    setSales((prev) => prev.map((b) => (b.id === billId ? { ...b, paid: true, method, settledAt: Date.now() } : b)));
    flash("Bill marked as paid");
  };

  if (!ready) {
    return (
      <div style={{ minHeight: "100vh", background: C.ink, display: "grid", placeItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: C.sageDim, fontFamily: SANS, fontSize: 14 }}>
          <Loader2 size={16} className="animate-spin" /> Opening the floor…
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <AuthScreen
        platformName={platform.name}
        pairedVenue={pairedVenue}
        onPair={pairDevice}
        onUnpair={() => setDeviceVenueId(null)}
        onPin={resolvePin}
        onPlatform={resolvePlatform}
        error={loginError}
        clearError={() => setLoginError("")}
      />
    );
  }

  const isPlatform = session.role === "platform";
  const isOwner = session.role === "owner";
  const isWaiter = session.role === "waiter";

  const tabs = isPlatform
    ? [["bars", "Bars & billing", Store]]
    : isOwner
    ? [["floor", "Floor", LayoutGrid], ["design", "Floor designer", Copy], ["menu", "Price list", ListOrdered], ["reports", "Money", BarChart3], ["team", "Team", Users]]
    : [["floor", "Floor", LayoutGrid]];
  const currentTab = tabs.some((t) => t[0] === tab) ? tab : tabs[0][0];

  const openHere = venue ? Object.values(orders).filter((o) => o.venueId === venue.id) : [];
  const openValue = round2(openHere.reduce((s, o) => s + o.lines.reduce((x, l) => x + l.price * l.qty, 0), 0));
  const myOpen = isWaiter ? openHere.filter((o) => o.staffId === session.actorId) : openHere;
  const st = venue ? subState(venue, now) : null;

  return (
    <div style={{ minHeight: "100vh", background: C.ink, color: C.cream, fontFamily: SANS }}>
      <style>{`
        *::-webkit-scrollbar{width:8px;height:8px}
        *::-webkit-scrollbar-thumb{background:${C.line2};border-radius:99px}
        *::-webkit-scrollbar-track{background:transparent}
        button:focus-visible,input:focus-visible{outline:2px solid ${C.brass};outline-offset:2px}
        @keyframes spin{to{transform:rotate(360deg)}}
        .animate-spin{animation:spin 1s linear infinite}
        @media (prefers-reduced-motion: reduce){*{transition:none!important;animation:none!important}}
      `}</style>

      {session.support && (
        <div style={{ background: "rgba(230,180,80,0.12)", borderBottom: `1px solid ${C.brassDim}`, padding: "8px 18px", display: "flex", alignItems: "center", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <ShieldCheck size={14} color={C.brass} />
          <span style={{ fontSize: 12.5, color: C.brass }}>Support session — you are inside {venue.name} as the owner.</span>
          <Btn size="sm" icon={ArrowLeft} onClick={() => { setSession({ role: "platform", actorName: "Platform" }); setTab("bars"); }}>Back to your dashboard</Btn>
        </div>
      )}

      {isOwner && st === "past_due" && (
        <div style={{ background: "rgba(212,103,74,0.12)", borderBottom: `1px solid rgba(212,103,74,0.4)`, padding: "9px 18px", display: "flex", alignItems: "center", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <AlertTriangle size={14} color={C.copper} />
          <span style={{ fontSize: 12.5, color: C.copper }}>
            Payment was due {shortDate(venue.subscription.nextDueAt)}. The app stops in {(venue.subscription.graceDays ?? 7) - daysBetween(now, venue.subscription.nextDueAt)} days.
          </span>
        </div>
      )}

      <header style={{ position: "sticky", top: 0, zIndex: 60, background: "rgba(10,20,17,0.92)", backdropFilter: "blur(10px)", borderBottom: `1px solid ${C.line}` }}>
        <div style={{ maxWidth: 1320, margin: "0 auto", padding: "11px 18px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginRight: "auto" }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, border: `1.5px solid ${C.brass}`, display: "grid", placeItems: "center", boxShadow: "0 0 18px -4px rgba(230,180,80,0.5)" }}>
              <Wine size={15} color={C.brass} />
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 14, letterSpacing: "0.18em", color: C.cream }}>{platform.name.toUpperCase()}</div>
              <div style={{ fontSize: 10.5, color: C.sageDim, letterSpacing: "0.1em" }}>
                {isPlatform ? "PLATFORM DASHBOARD" : venue.name.toUpperCase()}
              </div>
            </div>
          </div>

          {!isPlatform && openHere.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 99, border: `1px solid ${C.brassDim}`, background: "rgba(230,180,80,0.07)" }}>
              <Clock size={13} color={C.brass} />
              <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.brass }}>
                {isWaiter ? `${myOpen.length} of ${openHere.length} tables yours` : `${openHere.length} open · ${money(openValue, venue.currency)}`}
              </span>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 6px 5px 11px", borderRadius: 10, background: C.raise, border: `1px solid ${C.line}` }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.cream, lineHeight: 1.2 }}>{session.actorName}</div>
              <div style={{ fontSize: 10, color: C.sageDim, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                {isPlatform ? "You" : isOwner ? "Bar owner" : "Waiter"}
              </div>
            </div>
            <Btn size="sm" variant="bare" icon={LogOut} title="Sign out" onClick={() => { setSession(null); setOpenTableId(null); }} />
          </div>
        </div>

        {tabs.length > 1 && (
          <div style={{ maxWidth: 1320, margin: "0 auto", padding: "0 18px", display: "flex", gap: 4, overflowX: "auto" }}>
            {tabs.map(([k, l, Icon]) => (
              <button key={k} onClick={() => setTab(k)} style={{
                display: "flex", alignItems: "center", gap: 7, padding: "10px 12px", border: "none", background: "transparent",
                borderBottom: `2px solid ${currentTab === k ? C.brass : "transparent"}`,
                color: currentTab === k ? C.cream : C.sageDim, fontFamily: SANS, fontWeight: 600, fontSize: 13,
                cursor: "pointer", whiteSpace: "nowrap",
              }}><Icon size={14} />{l}</button>
            ))}
          </div>
        )}
      </header>

      <main style={{ maxWidth: 1320, margin: "0 auto", padding: "20px 18px 80px" }}>
        {isPlatform && (
          <AdminBars
            venues={venues} setVenues={setVenues} sales={sales} orders={orders} now={now} allCodes={allCodes} flash={flash}
            openAsOwner={(vid) => {
              const v = venues.find((x) => x.id === vid);
              setSession({ role: "owner", venueId: vid, actorId: vid, actorName: v.ownerName, support: true });
              setZoneId(v.zones[0]?.id); setTab("floor");
            }}
          />
        )}

        {!isPlatform && currentTab === "floor" && (
          <div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
              {venue.zones.map((z) => {
                const n = z.tables.filter((t) => orders[`${venue.id}/${t.id}`]).length;
                return (
                  <button key={z.id} onClick={() => setZoneId(z.id)} style={{
                    padding: "8px 14px", borderRadius: 10, border: `1px solid ${z.id === zone.id ? C.brass : C.line}`,
                    background: z.id === zone.id ? "rgba(230,180,80,0.1)" : "transparent",
                    color: z.id === zone.id ? C.brass : C.sage, fontFamily: SANS, fontWeight: 600, fontSize: 13,
                    cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
                  }}>
                    {z.name}
                    {n > 0 && <span style={{ fontFamily: MONO, fontSize: 10.5, background: C.brass, color: "#1A1305", borderRadius: 99, padding: "1px 6px" }}>{n}</span>}
                  </button>
                );
              })}
              <span style={{ marginLeft: "auto", fontFamily: SANS, fontSize: 12, color: C.sageDim }}>Tap a table to take the order</span>
            </div>

            <FloorPlan zone={zone} orders={orders} venueId={venue.id} mode="service" selectedId={null}
              onSelect={setOpenTableId} onMove={() => {}} currency={venue.currency} now={now} />

            {openHere.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <Eyebrow style={{ marginBottom: 10 }}>Open bills</Eyebrow>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(190px,1fr))", gap: 10 }}>
                  {openHere.sort((a, b) => a.openedAt - b.openedAt).map((o) => {
                    const tot = o.lines.reduce((s, l) => s + l.price * l.qty, 0);
                    const stale = now - o.openedAt > 75 * 60000;
                    const mine = o.staffId === session.actorId;
                    return (
                      <button key={o.key} onClick={() => { setZoneId(o.zoneId); setOpenTableId(o.tableId); }} style={{
                        textAlign: "left", background: C.panel, border: `1px solid ${stale ? "rgba(212,103,74,0.4)" : mine && isWaiter ? C.brassDim : C.line}`,
                        borderRadius: 12, padding: 13, cursor: "pointer",
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontFamily: MONO, fontWeight: 700, color: C.brass, fontSize: 14 }}>{o.tableLabel}</span>
                          <span style={{ fontFamily: MONO, fontSize: 11, color: stale ? C.copper : C.sageDim }}>{since(o.openedAt, now)}</span>
                        </div>
                        <div style={{ fontFamily: MONO, fontSize: 19, color: C.cream, marginTop: 7 }}>{money(tot, venue.currency)}</div>
                        <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim, marginTop: 3 }}>
                          {o.lines.reduce((s, l) => s + l.qty, 0)} items · {o.guests} guests · {mine ? "you" : o.staffName}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {isOwner && currentTab === "design" && (
          <Designer venue={venue} zoneId={zone.id} setZoneId={setZoneId} updateVenue={updateVenue} orders={orders} now={now} flash={flash} />
        )}
        {isOwner && currentTab === "menu" && <PriceList articles={articles} setArticles={setArticles} currency={venue.currency} />}
        {isOwner && currentTab === "reports" && <Reports sales={sales} orders={orders} venue={venue} onSettleUnpaid={settleUnpaid} />}
        {isOwner && currentTab === "team" && <Team venue={venue} updateVenue={updateVenue} flash={flash} />}
      </main>

      {table && orderKey && venue && (
        <OrderSheet
          table={table} zone={zone} venue={venue} order={orders[orderKey]} articles={articles} now={now}
          actorName={session.actorName}
          canSeeCost={isOwner}
          canDiscount={isOwner || venue.allowStaffDiscount}
          onClose={() => setOpenTableId(null)}
          onCommit={commitOrder}
          onSettle={settleOrder}
        />
      )}

      {toast && (
        <div style={{
          position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 200,
          background: C.raise, border: `1px solid ${C.brassDim}`, color: C.cream, padding: "11px 18px",
          borderRadius: 11, fontFamily: SANS, fontSize: 13, fontWeight: 600, maxWidth: "90vw", textAlign: "center",
          boxShadow: "0 10px 40px -10px rgba(0,0,0,0.8)",
        }}>{toast}</div>
      )}
    </div>
  );
}
