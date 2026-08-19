import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  LayoutGrid, Store, BarChart3, Plus, Minus, Trash2, X, Check, Circle, Square,
  RectangleHorizontal, Users, Clock, CreditCard, Banknote, Search, ChevronRight,
  Copy, Save, Receipt, RotateCw, Loader2, Wine, ListOrdered, LogOut, Delete,
  ChevronLeft, Palette, ImageIcon, Printer, Martini, LayoutList,
  ShieldCheck, UserPlus, AlertTriangle, ArrowLeft, KeyRound, Pause, Play, Wallet,
} from "lucide-react";

import { configError } from "./lib/supabase";
import {
  SURFACES, ACCENT_SUGGESTIONS, DEFAULT_BRAND, applyTheme, buildTheme,
  parseHex, contrast, rememberBrand, recallBrand,
} from "./lib/theme";
import {
  loadPairing, clearPairing, loadStaffSession, clearStaffSession,
  pairDevice, signInStaff, signInPlatform, restorePlatformSession, signOut,
  clientFor, onExpired,
} from "./lib/auth";
import { useBarData } from "./lib/useBarData";
import * as api from "./lib/api";
import * as fiscal from "./lib/fiscal";
import { WifiOff, RefreshCw, Download } from "lucide-react";

/* ============================================================================
   BACKBAR — bar floor & order tracking, sold as a subscription
   Three seats: platform (you) · bar owner (your client) · waiter (their staff)

   All data lives in Postgres. Nothing here decides who may see what — the
   database does, and this file only decides what to render.
   ========================================================================== */

/* Colours are CSS custom properties so a bar's branding can be swapped at
   runtime without re-rendering anything. src/lib/theme.js sets them.
   copper and mint stay literal: a warning must look like a warning regardless
   of what colour the owner picked. */
const C = {
  ink: "var(--ink)",
  panel: "var(--panel)",
  raise: "var(--raise)",
  line: "var(--line)",
  line2: "var(--line2)",
  lineFade: "var(--line-fade)",
  brass: "var(--accent)",
  brassDim: "var(--accent-dim)",
  onBrass: "var(--on-accent)",
  cream: "var(--cream)",
  creamDim: "var(--cream-dim)",
  sage: "var(--sage)",
  sageDim: "var(--sage-dim)",
  copper: "#D4674A",
  mint: "#67C9A0",
  // pre-mixed accent tints, since var() can't take an alpha suffix
  a05: "var(--accent-05)", a07: "var(--accent-07)", a08: "var(--accent-08)",
  a10: "var(--accent-1)",  a12: "var(--accent-12)", a16: "var(--accent-16)",
  a20: "var(--accent-2)",  a35: "var(--accent-35)", a45: "var(--accent-45)",
  a50: "var(--accent-5)",  a55: "var(--accent-55)",
  glow: "var(--glow)", glowSoft: "var(--glow-soft)",
};

const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const PLAN_W = 1000, PLAN_H = 700;
const DAY = 86400000;

const PLANS = {
  starter: { id: "starter", name: "Starter", price: 29, maxRooms: 1, maxTables: 16, maxStaff: 3 },
  pro: { id: "pro", name: "Pro", price: 59, maxRooms: 5, maxTables: 60, maxStaff: 15 },
  chain: { id: "chain", name: "Chain", price: 119, maxRooms: 20, maxTables: 400, maxStaff: 100 },
};

/* ---------------------------------------------------------------- utilities */

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

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

/* A bar carries three VAT rates at once. The rate belongs to the item, not the
   category: cake eaten in is hospitality, the same cake boxed to go is not.
   Classification is the accountant's call, not the app's. */
const VAT_RATES = [
  { rate: 18, label: "18% · alcohol" },
  { rate: 10, label: "10% · hospitality" },
  { rate: 5,  label: "5% · packaged to go" },
  { rate: 0,  label: "0% · exempt" },
];

const curOf = (cur) =>
  CURRENCIES[String(cur || "EUR").toUpperCase()] ||
  { sign: cur || "€", after: false, decimals: 2 };

/** Just the number, correctly rounded for the currency. Use where a column
    header already carries the sign. */
function amount(n, cur) {
  const { decimals } = curOf(cur);
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** The full thing: 250 ден · €12.50 */
function money(n, cur = "EUR") {
  const c = curOf(cur);
  const v = amount(n, cur);
  return c.after ? `${v} ${c.sign}` : `${c.sign}${v}`;
}

function since(ts, now) {
  const m = Math.max(0, Math.floor((now - ts) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function shortDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
function daysBetween(a, b) {
  return Math.round((a - b) / DAY);
}

/* ---------------------------------------------------- subscription lifecycle
   This mirrors bar_is_live() in the database. It exists only to render banners
   and pills — the database is what actually enforces access, so a tampered
   copy of this function gains nobody anything. */

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
    solid: { background: C.brass, color: C.onBrass, borderColor: C.brass },
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
/* A phone is not a small desktop. Below this the order sheet becomes a
   single pane with a running total bar, rather than two columns that wrap
   the bill off the bottom of a clipped container. */
function useNarrow(query = "(max-width: 760px)") {
  const [hit, setHit] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = (e) => setHit(e.matches);
    m.addEventListener("change", on);
    setHit(m.matches);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return hit;
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

function CodeEntry({ length, onSubmit, error, dotLabel, busy }) {
  const [code, setCode] = useState("");

  useEffect(() => { setCode(""); }, [dotLabel]);

  useEffect(() => {
    if (code.length === length && !busy) {
      const t = setTimeout(() => { onSubmit(code); setCode(""); }, 120);
      return () => clearTimeout(t);
    }
  }, [code, length, onSubmit, busy]);

  useEffect(() => {
    const h = (e) => {
      if (busy) return;
      if (/^[0-9]$/.test(e.key)) setCode((p) => (p.length < length ? p + e.key : p));
      if (e.key === "Backspace") setCode((p) => p.slice(0, -1));
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [length, busy]);

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
      <div style={{ opacity: busy ? 0.45 : 1, pointerEvents: busy ? "none" : "auto" }}>
        <Keypad
          onDigit={(d) => setCode((p) => (p.length < length ? p + d : p))}
          onBack={() => setCode((p) => p.slice(0, -1))}
          onClear={() => setCode("")}
        />
      </div>
    </>
  );
}

/* The device is tied to one bar. After that, a PIN only has to be unique
   inside that bar — two bars can both have a waiter on 1234. */
function AuthScreen({ platformName, pairedVenue, onPair, onUnpair, onPin, onPlatform, error, clearError, busy }) {
  const [mode, setMode] = useState(pairedVenue ? "pin" : "pair");
  const [hint, setHint] = useState(false);
  const [forgot, setForgot] = useState(false);

  useEffect(() => { setMode(pairedVenue ? "pin" : "pair"); }, [pairedVenue]);
  const go = (m) => { clearError(); setMode(m); };

  const heading =
    mode === "platform" ? { title: "Platform sign-in", sub: "The account that runs the whole network" }
    : mode === "pair" ? { title: "Set up this device", sub: "Enter the bar's code — you only do this once" }
    : { title: pairedVenue.name, sub: "Enter your PIN to open the floor" };

  return (
    <div style={{ minHeight: "100vh", background: C.ink, display: "grid", placeItems: "center", padding: 20, fontFamily: SANS }}>
      <div style={{ width: "100%", maxWidth: 330 }}>
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, border: `1.5px solid ${C.brass}`, display: "grid", placeItems: "center", margin: "0 auto 14px", boxShadow: `0 0 30px -6px ${C.a55}` }}>
            {mode === "platform" ? <ShieldCheck size={21} color={C.brass} /> : <Wine size={22} color={C.brass} />}
          </div>
          <div style={{ fontWeight: 800, fontSize: 10, letterSpacing: "0.28em", color: C.sageDim, marginBottom: 8 }}>
            {platformName.toUpperCase()}
          </div>
          <div style={{ fontWeight: 700, fontSize: 18, color: C.cream }}>{heading.title}</div>
          <div style={{ fontSize: 12.5, color: C.sageDim, marginTop: 5 }}>{heading.sub}</div>
        </div>

        {mode === "pair" && <CodeEntry length={4} onSubmit={onPair} error={error} busy={busy} dotLabel="pair" />}
        {mode === "pin" && <CodeEntry length={4} onSubmit={onPin} error={error} busy={busy} dotLabel="pin" />}
        {mode === "platform" && <PlatformForm onSubmit={onPlatform} error={error} busy={busy} />}

        {mode === "pin" && (
          <div style={{ textAlign: "center", marginTop: 4 }}>
            <button onClick={() => setForgot(!forgot)} style={linkBtn}>Forgotten your PIN?</button>
            {forgot && (
              <div style={{ marginTop: 10, background: C.panel, border: `1px dashed ${C.line2}`,
                borderRadius: 11, padding: 14, textAlign: "left", fontFamily: SANS,
                fontSize: 12.5, color: C.sage, lineHeight: 1.6 }}>
                PINs are stored scrambled, so nobody can look yours up — it has to
                be replaced.
                <div style={{ marginTop: 8, color: C.sageDim }}>
                  <strong style={{ color: C.cream }}>Waiter?</strong> Ask the owner.
                  They can issue you a new one from the Team tab in seconds.
                </div>
                <div style={{ marginTop: 6, color: C.sageDim }}>
                  <strong style={{ color: C.cream }}>Owner?</strong> Contact {platformName}.
                  Your bar keeps taking orders meanwhile — waiter PINs are unaffected.
                </div>
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "center", gap: 14, marginTop: 18, flexWrap: "wrap" }}>
          {mode === "pin" && (
            <button onClick={() => { onUnpair(); go("pair"); }} style={linkBtn}>Not this bar?</button>
          )}
          {mode !== "platform" && <button onClick={() => go("platform")} style={linkBtn}>I run {platformName}</button>}
          {mode === "platform" && <button onClick={() => go(pairedVenue ? "pin" : "pair")} style={linkBtn}>Back</button>}
        </div>

        <UpdateChip />
        <button onClick={() => setHint(!hint)} style={{ ...linkBtn, width: "100%", marginTop: 14 }}>
          {hint ? "Hide" : "Where do I get a code?"}
        </button>
        {hint && (
          <div style={{ marginTop: 8, background: C.panel, border: `1px dashed ${C.line2}`, borderRadius: 11, padding: 13, fontFamily: SANS, fontSize: 11.5, color: C.sage, lineHeight: 1.6 }}>
            The bar code is issued by {platformName} and set up once per device.
            Your PIN is set by your bar's owner and only works here.
          </div>
        )}
        <VersionLine />
      </div>
    </div>
  );
}

/* Which build is this device actually running? Without it, "have you got the
   fix?" is unanswerable over the phone. Tapping it asks for a newer one. */
function VersionLine() {
  const [state, setState] = useState("idle");

  const check = async () => {
    setState("checking");
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
      setTimeout(() => setState("checked"), 900);
    } catch {
      setState("checked");
    }
  };

  return (
    <button onClick={check} style={{
      display: "block", width: "100%", marginTop: 22, background: "transparent",
      border: "none", cursor: "pointer", fontFamily: MONO, fontSize: 10.5,
      color: C.sageDim, letterSpacing: "0.06em",
    }}>
      {state === "checking" ? "checking for updates…"
        : state === "checked" ? `v${__BUILD_ID__} · up to date`
        : `v${__BUILD_ID__} · tap to check for updates`}
    </button>
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
  const ring = selected ? C.brass : occupied ? (stale ? C.copper : `${C.a55}`) : C.line2;
  const bg = isBar ? "linear-gradient(180deg,#1D3129,#152520)"
    : occupied ? `linear-gradient(180deg,${C.a16},${C.a05})`
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
          background: `radial-gradient(circle, ${stale ? "rgba(212,103,74,0.20)" : `${C.a20}`} 0%, rgba(0,0,0,0) 68%)` }} />
      )}
      <SeatPips table={table} scale={scale} />
      <div style={{
        position: "absolute", inset: 0, borderRadius: radius, background: bg,
        border: `${selected ? 2 : 1.5}px solid ${ring}`,
        boxShadow: occupied ? `0 6px 26px -6px ${stale ? "rgba(212,103,74,0.5)" : `${C.a45}`}` : "0 2px 10px rgba(0,0,0,0.4)",
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

function FloorPlan({ zone, orders, venueId, mode, selectedId, onSelect, onMove, onMoveEnd, currency, now }) {
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
      ref={ref} onPointerMove={move}
      onPointerUp={() => { if (drag.current && onMoveEnd) onMoveEnd(drag.current.id); drag.current = null; }}
      onPointerCancel={() => { if (drag.current && onMoveEnd) onMoveEnd(drag.current.id); drag.current = null; }}
      onClick={(e) => e.target === e.currentTarget && mode === "design" && onSelect(null)}
      style={{
        position: "relative", width: "100%", aspectRatio: `${PLAN_W} / ${PLAN_H}`,
        background: `radial-gradient(120% 90% at 50% 0%, ${C.a05}, rgba(0,0,0,0) 55%), linear-gradient(180deg, #0C1815, #08110E)`,
        borderRadius: 16, border: `1px solid ${C.line}`, overflow: "hidden", userSelect: "none",
      }}
    >
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        backgroundImage: `linear-gradient(${C.lineFade} 1px, transparent 1px), linear-gradient(90deg, ${C.lineFade} 1px, transparent 1px)`,
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

function OrderSheet({ table, zone, venue, order, articles, onClose, onCommit, onSettle, now, canSeeCost, canDiscount, actorName, busy }) {
  const [lines, setLines] = useState(order ? order.lines.map((l) => ({ ...l })) : []);
  const [guests, setGuests] = useState(order ? order.guests : table.seats || 2);
  const [cat, setCat] = useState("All");
  const [q, setQ] = useState("");
  const [paying, setPaying] = useState(false);
  const [discount, setDiscount] = useState(0);
  const narrow = useNarrow();
  const [showBill, setShowBill] = useState(false);

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
      <div style={{
        width: "100%", maxWidth: narrow ? "100%" : 1080, margin: narrow ? 0 : "auto",
        height: narrow ? "100%" : undefined, maxHeight: "100%",
        display: "flex", flexDirection: "column", background: C.panel,
        border: narrow ? "none" : `1px solid ${C.line}`,
        borderRadius: narrow ? 0 : 18, overflow: "hidden",
      }}>
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

        <div style={{ display: "flex", flex: 1, minHeight: 0, position: "relative", flexWrap: narrow ? "nowrap" : "wrap" }}>
          <div style={{
            flex: "1 1 340px", minWidth: narrow ? 0 : 280,
            display: narrow && showBill ? "none" : "flex",
            flexDirection: "column", minHeight: 0,
          }}>
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
                  background: cat === c ? `${C.a12}` : "transparent", color: cat === c ? C.brass : C.sage,
                  fontFamily: SANS, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer",
                }}>{c}</button>
              ))}
            </div>
            <div style={{
              flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch",
              padding: narrow ? "0 16px 96px" : "0 16px 16px",
              display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(132px,1fr))",
              gap: 8, alignContent: "start",
            }}>
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

          {narrow && !showBill && (
            <div style={{
              position: "absolute", left: 0, right: 0, bottom: 0,
              background: C.cream, borderTop: "1px solid rgba(0,0,0,0.2)",
              padding: "10px 14px calc(10px + env(safe-area-inset-bottom))",
              display: "flex", alignItems: "center", gap: 12,
              boxShadow: "0 -8px 24px rgba(0,0,0,0.35)",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.16em", color: "#8A7F66" }}>
                  {lines.reduce((a, l) => a + l.qty, 0)} ITEMS
                </div>
                <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: "#1A1608", lineHeight: 1.15 }}>
                  {money(total, venue.currency)}
                </div>
              </div>
              <Btn
                variant="solid" size="lg" icon={Receipt}
                onClick={() => setShowBill(true)}
                style={{ flexShrink: 0 }}
              >
                Bill
              </Btn>
            </div>
          )}

          <div style={{
            flex: "1 1 320px", minWidth: narrow ? 0 : 288, background: C.cream,
            display: narrow && !showBill ? "none" : "flex",
            flexDirection: "column", minHeight: 0,
          }}>
            <div style={{ height: 10, background: `repeating-linear-gradient(90deg, ${C.cream} 0 8px, rgba(0,0,0,0.12) 8px 12px)`, flexShrink: 0 }} />
            {narrow && (
              <button
                onClick={() => { setShowBill(false); setPaying(false); }}
                style={{
                  display: "flex", alignItems: "center", gap: 7, margin: "10px 14px 0",
                  background: "transparent", border: "none", cursor: "pointer",
                  color: "#6B6250", fontFamily: SANS, fontSize: 13, fontWeight: 600, padding: 0,
                }}
              >
                <ArrowLeft size={15} /> Back to the menu
              </button>
            )}
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

            <div style={{ padding: "10px 18px calc(16px + env(safe-area-inset-bottom))", borderTop: "1px solid rgba(0,0,0,0.15)", flexShrink: 0 }}>
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
              {!order && lines.length > 0 && (
                <div style={{ fontFamily: SANS, fontSize: 11, color: "#8A5A2E", marginTop: 6 }}>
                  Save the order first, then you can close the bill.
                </div>
              )}

              {!paying ? (
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <Btn variant="quiet" disabled={busy} onClick={() => onCommit(lines, guests)} icon={busy ? Loader2 : Save} style={{ flex: 1, background: "#221E15", color: C.cream, borderColor: "#221E15" }}>Save order</Btn>
                  <Btn variant="solid" disabled={!lines.length || busy || !order} onClick={() => setPaying(true)} icon={Receipt} style={{ flex: 1 }}>Close bill</Btn>
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
                    <Btn variant="quiet" disabled={busy} icon={Banknote} onClick={() => onSettle("cash", true, discount)} style={{ flex: 1, background: "#221E15", color: C.cream, borderColor: "#221E15" }}>Cash</Btn>
                    <Btn variant="solid" disabled={busy} icon={CreditCard} onClick={() => onSettle("card", true, discount)} style={{ flex: 1 }}>Card</Btn>
                  </div>
                  <Btn variant="ghost" disabled={busy} icon={AlertTriangle} onClick={() => onSettle(null, false, discount)}
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

function Designer({ venue, zones, zoneId, setZoneId, orders, now, flash, actions }) {
  const [sel, setSel] = useState(null);
  const [drafts, setDrafts] = useState({}); // positions mid-drag, not yet saved
  const plan = PLANS[venue.subscription.plan];
  const baseZone = zones.find((z) => z.id === zoneId) || zones[0];
  const zone = {
    ...baseZone,
    tables: baseZone.tables.map((t) => (drafts[t.id] ? { ...t, ...drafts[t.id] } : t)),
  };
  const table = zone.tables.find((t) => t.id === sel);
  const tableCount = zones.reduce((s, z) => s + z.tables.length, 0);

  // Dragging fires on every pointer move. Keep it local; write once on release.
  const move = (id, x, y) => setDrafts((d) => ({ ...d, [id]: { x, y } }));
  const commitMove = (id) => {
    const d = drafts[id];
    if (!d) return;
    actions.moveTable(id, d.x, d.y);
    setDrafts(({ [id]: _drop, ...rest }) => rest);
  };
  const patch = (id, p) => {
    const t = baseZone.tables.find((x) => x.id === id);
    actions.saveTable(baseZone.id, { ...t, ...p });
  };

  const addTable = (shape) => {
    if (tableCount >= plan.maxTables) return flash(`${plan.name} covers ${plan.maxTables} tables. Ask your provider to upgrade.`);
    const n = zone.tables.filter((t) => t.shape !== "bar").length + 1;
    const preset = {
      round: { w: 96, h: 96, seats: 4, label: String(n) },
      square: { w: 100, h: 100, seats: 4, label: String(n) },
      rect: { w: 180, h: 96, seats: 6, label: String(n) },
      bar: { w: 360, h: 72, seats: 6, label: "BAR" },
    }[shape];
    actions.saveTable(baseZone.id, { shape, x: 500, y: 350, rot: 0, ...preset });
  };

  const addZone = async () => {
    if (zones.length >= plan.maxRooms) return flash(`${plan.name} covers ${plan.maxRooms} room${plan.maxRooms > 1 ? "s" : ""}. Upgrade to add more.`);
    const z = await actions.saveZone({ name: `Room ${zones.length + 1}`, sort: zones.length });
    if (z) setZoneId(z.id);
    setSel(null);
  };

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 460px", minWidth: 300 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          {zones.map((z) => (
            <button key={z.id} onClick={() => { setZoneId(z.id); setSel(null); }} style={{
              padding: "7px 13px", borderRadius: 9, border: `1px solid ${z.id === zone.id ? C.brass : C.line}`,
              background: z.id === zone.id ? `${C.a10}` : "transparent",
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

        <FloorPlan zone={zone} orders={orders} venueId={venue.id} mode="design" selectedId={sel}
          onSelect={setSel} onMove={move} onMoveEnd={commitMove} currency={venue.currency} now={now} />

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
              <Field label="Room name" value={zone.name} onChange={(v) => actions.saveZone({ id: baseZone.id, name: v, sort: baseZone.sort })} />
            </div>
            <div style={{ marginTop: 14, fontFamily: SANS, fontSize: 13, color: C.sageDim, lineHeight: 1.6 }}>
              Pick a table on the plan to rename it, change its seats, or resize it.
            </div>
            {zones.length > 1 && (
              <Btn variant="danger" icon={Trash2} style={{ marginTop: 16, width: "100%" }} onClick={async () => {
                const rest = zones.filter((z) => z.id !== baseZone.id);
                await actions.deleteZone(baseZone.id);
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
                  const { id: _drop, ...rest } = table;
                  actions.saveTable(baseZone.id, { ...rest, x: clamp(table.x + 60, 0, PLAN_W), y: clamp(table.y + 40, 0, PLAN_H) });
                }}>Duplicate</Btn>
              </div>
              <Btn variant="danger" icon={Trash2} style={{ width: "100%" }} onClick={() => {
                actions.deleteTable(table.id);
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

function PriceList({ articles, currency, actions }) {
  const [q, setQ] = useState("");
  const [hover, setHover] = useState(null);
  // A six-column table needs 440px before the name gets any width at all. On a
  // phone that collapses the name to nothing, which is how it disappeared.
  const narrow = useNarrow("(max-width: 620px)");
  const [cat, setCat] = useState("All");
  const [editing, setEditing] = useState(null);
  const cats = useMemo(() => ["All", ...Array.from(new Set(articles.map((a) => a.category)))], [articles]);
  const shown = articles.filter((a) => (cat === "All" || a.category === cat) && (!q || a.name.toLowerCase().includes(q.toLowerCase())));
  const avgMargin = articles.length ? articles.reduce((s, a) => s + (a.price ? (a.price - a.cost) / a.price : 0), 0) / articles.length : 0;

  const priced = articles.filter((a) => a.cost > 0);
  const realMargin = priced.length
    ? priced.reduce((acc, a) => acc + (a.price ? (a.price - a.cost) / a.price : 0), 0) / priced.length
    : null;

  return (
    <div style={{ maxWidth: 940 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 18 }}>
        <Stat label="Articles" value={articles.length} />
        {/* 100% margin means the buy prices are missing, not that drinks are free. */}
        <Stat
          label="Average margin"
          value={realMargin === null ? "—" : `${(realMargin * 100).toFixed(0)}%`}
          accent={realMargin === null ? C.sageDim : C.brass}
          sub={priced.length < articles.length
            ? `${articles.length - priced.length} have no buy price`
            : "across all articles"}
        />
        <Stat label="Categories" value={cats.length - 1} />
      </div>

      {priced.length < articles.length && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "11px 14px",
          background: "rgba(212,103,74,0.1)", border: "1px solid rgba(212,103,74,0.3)",
          borderRadius: 11, marginBottom: 14 }}>
          <AlertTriangle size={15} color={C.copper} style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ fontFamily: SANS, fontSize: 12.5, color: C.cream, lineHeight: 1.5 }}>
            {articles.length - priced.length} of {articles.length} articles have no buy price, so every
            profit figure in Money is overstated. Tap an item to add what it costs you.
          </span>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 200px" }}>
          <Search size={14} color={C.sageDim} style={{ position: "absolute", left: 11, top: 11 }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an article"
            style={{ width: "100%", background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9, padding: "9px 12px 9px 32px", color: C.cream, fontFamily: SANS, fontSize: 13, outline: "none" }} />
        </div>
        <Btn variant="solid" icon={Plus} onClick={() => setEditing({ id: null, name: "", category: cat === "All" ? "Beer" : cat, cost: 0, price: 0, vatRate: 18, active: true })}>New article</Btn>
      </div>

      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 12 }}>
        {cats.map((c) => (
          <button key={c} onClick={() => setCat(c)} style={{
            padding: "6px 11px", borderRadius: 99, border: `1px solid ${cat === c ? C.brass : C.line}`,
            background: cat === c ? `${C.a10}` : "transparent", color: cat === c ? C.brass : C.sage,
            fontFamily: SANS, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer",
          }}>{c}</button>
        ))}
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, overflow: "hidden" }}>
        <div style={{ display: narrow ? "none" : "grid", gridTemplateColumns: "minmax(0,1fr) 84px 84px 62px 74px 30px",
          gap: 14, padding: "11px 18px", borderBottom: `1px solid ${C.line}`, background: C.raise }}>
          <Eyebrow>Article</Eyebrow>
          <Eyebrow style={{ textAlign: "right" }}>Buy {curOf(currency).sign}</Eyebrow>
          <Eyebrow style={{ textAlign: "right" }}>Sell {curOf(currency).sign}</Eyebrow>
          <Eyebrow style={{ textAlign: "right" }}>VAT</Eyebrow>
          <Eyebrow style={{ textAlign: "right" }}>Margin</Eyebrow>
          <span />
        </div>
        <div style={{ maxHeight: 460, overflowY: "auto" }}>
          {shown.map((a) => {
            const m = a.price ? (a.price - a.cost) / a.price : 0;
            return (
              <div key={a.id}
                onClick={() => setEditing({ ...a })}
                onMouseEnter={() => setHover(a.id)}
                onMouseLeave={() => setHover(null)}
                style={narrow
                  ? { padding: "12px 16px", borderBottom: `1px solid ${C.lineFade}`, cursor: "pointer",
                      background: hover === a.id ? C.raise : "transparent" }
                  : { display: "grid", gridTemplateColumns: "minmax(0,1fr) 84px 84px 62px 74px 30px", gap: 14,
                      padding: "12px 18px", borderBottom: `1px solid ${C.lineFade}`,
                      alignItems: "center", cursor: "pointer",
                      background: hover === a.id ? C.raise : "transparent" }}>

                {narrow ? (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                      <span style={{ fontFamily: SANS, fontSize: 14.5, color: C.cream, minWidth: 0,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {a.name || "(no name)"}
                      </span>
                      <span style={{ fontFamily: MONO, fontSize: 15, color: C.cream, whiteSpace: "nowrap" }}>
                        {amount(a.price, currency)}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 4 }}>
                      <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim }}>
                        {a.category} · VAT {a.vatRate ?? 18}%
                      </span>
                      <span style={{ fontFamily: MONO, fontSize: 11.5,
                        color: a.cost > 0 ? C.sage : C.copper, whiteSpace: "nowrap" }}>
                        {a.cost > 0
                          ? `buy ${amount(a.cost, currency)} · ${(m * 100).toFixed(0)}%`
                          : "no buy price"}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: SANS, fontSize: 14, color: C.cream, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {a.name || "(no name)"}
                      </div>
                      <div style={{ fontFamily: SANS, fontSize: 11, color: C.sageDim, marginTop: 2 }}>{a.category}</div>
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 13, textAlign: "right",
                      color: a.cost > 0 ? C.sage : C.copper }}>
                      {a.cost > 0 ? amount(a.cost, currency) : "—"}
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 13, color: C.cream, textAlign: "right" }}>{amount(a.price, currency)}</div>
                    <div style={{ textAlign: "right", fontFamily: MONO, fontSize: 12, color: C.sage }}>{(a.vatRate ?? 18)}%</div>
                    <div style={{ textAlign: "right", fontFamily: MONO, fontSize: 12,
                      color: a.cost > 0 ? (m > 0.65 ? C.mint : m > 0.4 ? C.brass : C.copper) : C.sageDim }}>
                      {a.cost > 0 ? `${(m * 100).toFixed(0)}%` : "—"}
                    </div>
                    <ChevronRight size={16} color={hover === a.id ? C.brass : C.sageDim} style={{ justifySelf: "end" }} />
                  </>
                )}
              </div>
            );
          })}
          {!shown.length && <div style={{ padding: 20, fontFamily: SANS, fontSize: 13, color: C.sageDim }}>No articles here yet. Add one to start pricing.</div>}
        </div>
      </div>

      {editing && (
        <Modal onClose={() => setEditing(null)} width={380}>
          <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16, marginBottom: 16 }}>
            {editing.id ? "Edit article" : "New article"}
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            <Field label="Name" value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} placeholder="Draft lager 0.5" />
            <Field label="Category" value={editing.category} onChange={(v) => setEditing({ ...editing, category: v })} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Purchase price" type="number" step="0.01" mono suffix={curOf(currency).sign} value={editing.cost} onChange={(v) => setEditing({ ...editing, cost: v })} />
              <Field label="Selling price" type="number" step="0.01" mono suffix={curOf(currency).sign} value={editing.price} onChange={(v) => setEditing({ ...editing, price: v })} />
            </div>
            <div style={{ background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9, padding: "10px 12px", display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim }}>Profit per unit</span>
              <span style={{ fontFamily: MONO, fontSize: 13, color: C.brass }}>{money(Number(editing.price || 0) - Number(editing.cost || 0), currency)}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            {editing.id && (
              <Btn variant="danger" icon={Trash2} onClick={() => { actions.removeArticle(editing.id); setEditing(null); }} />
            )}
            <Btn variant="ghost" style={{ flex: 1 }} onClick={() => setEditing(null)}>Cancel</Btn>
            <Btn variant="solid" icon={Check} style={{ flex: 1 }}
              disabled={!editing.name.trim()}
              onClick={() => {
              actions.saveArticle({
                ...editing,
                name: editing.name.trim(),
                cost: round2(Number(editing.cost) || 0),
                price: round2(Number(editing.price) || 0),
              });
              setEditing(null);
            }}>Save</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ owner reports */

/* ---------------------------------------------------------------- reporting */

const startOfWeek = (d) => {                    // Monday
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
const iso = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

/** The range on screen, and how to step it. Everything is a business day —
    see business_day() in reports.sql for why a bar's Friday runs past midnight. */
function periodRange(mode, anchor) {
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

function periodLabel(mode, anchor) {
  const a = new Date(anchor);
  const today = new Date();
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

function stepAnchor(mode, anchor, dir) {
  const a = new Date(anchor);
  if (mode === "day") a.setDate(a.getDate() + dir);
  else if (mode === "week") a.setDate(a.getDate() + 7 * dir);
  else a.setMonth(a.getMonth() + dir);
  return a;
}

function Delta({ now, before }) {
  if (!before) return null;
  const pct = ((now - before) / before) * 100;
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.5) return null;
  const up = pct > 0;
  return (
    <span style={{ fontFamily: MONO, fontSize: 11, color: up ? C.mint : C.copper, marginLeft: 7 }}>
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

function Bars({ series, cur, height = 150 }) {
  const peak = Math.max(...series.map((s) => Number(s.gross) || 0), 0.01);
  if (!series.length) {
    return <div style={{ fontFamily: SANS, fontSize: 13, color: C.sageDim, padding: "24px 0" }}>
      Nothing sold in this period.
    </div>;
  }
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: series.length > 20 ? 2 : 5, height, marginTop: 16 }}>
      {series.map((s, i) => {
        const g = Number(s.gross) || 0;
        return (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minWidth: 0 }}>
            <div title={`${s.label}: ${money(g, cur)}`} style={{
              width: "100%", height: `${Math.max(2, (g / peak) * (height - 32))}px`,
              borderRadius: "4px 4px 2px 2px",
              background: g === peak ? `linear-gradient(180deg, ${C.brass}, ${C.brassDim})`
                                     : "linear-gradient(180deg, #34564A, #22392F)",
            }} />
            <span style={{ fontFamily: MONO, fontSize: 9, color: C.sageDim, whiteSpace: "nowrap",
              overflow: "hidden", textOverflow: "clip", maxWidth: "100%" }}>
              {series.length > 16 ? s.label.split(" ")[0] : s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SplitList({ rows, cur, nameKey = "name", valueKey = "gross", sub }) {
  const max = Math.max(...rows.map((r) => Number(r[valueKey]) || 0), 0.01);
  if (!rows.length) return <div style={{ fontFamily: SANS, fontSize: 13, color: C.sageDim }}>Nothing yet.</div>;
  return (
    <div style={{ display: "grid", gap: 11, marginTop: 14 }}>
      {rows.map((r, i) => (
        <div key={i}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, gap: 8 }}>
            <span style={{ fontFamily: SANS, fontSize: 12.5, color: C.cream, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r[nameKey]}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: C.sage, whiteSpace: "nowrap" }}>
              {money(Number(r[valueKey]) || 0, cur)}{sub ? ` · ${sub(r)}` : ""}
            </span>
          </div>
          <div style={{ height: 5, background: C.raise, borderRadius: 99, overflow: "hidden" }}>
            <div style={{ width: `${((Number(r[valueKey]) || 0) / max) * 100}%`, height: "100%", background: C.brass, borderRadius: 99 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Reports({ venue, report, products, productsLoading, loading, mode, setMode, anchor, setAnchor, unpaid, onSettleUnpaid, onExport, exporting, actions, onTestPrinter, onRetryFiscal }) {
  const cur = venue.currency;
  const t = report?.totals || {};
  const prev = report?.previous || {};
  const gross = Number(t.gross) || 0;
  const cost = Number(t.cost) || 0;
  const profit = Number(t.profit) || 0;
  const margin = gross ? (profit / gross) * 100 : 0;
  const att = report?.attention || {};
  const vat = report?.vat || [];
  const totalVat = vat.reduce((a, v) => a + Number(v.vat || 0), 0);
  const atToday = iso(new Date(anchor)) >= iso(new Date());

  const seg = (k, label) => (
    <button key={k} onClick={() => { setMode(k); setAnchor(new Date()); }} style={{
      padding: "7px 15px", borderRadius: 8, border: "none", cursor: "pointer",
      background: mode === k ? C.brass : "transparent",
      color: mode === k ? C.onBrass : C.sage,
      fontFamily: SANS, fontWeight: 700, fontSize: 12.5,
    }}>{label}</button>
  );

  return (
    <div>
      {/* period control */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", background: C.raise, border: `1px solid ${C.line}`, borderRadius: 10, padding: 3 }}>
          {seg("day", "Day")}{seg("week", "Week")}{seg("month", "Month")}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Btn size="sm" icon={ChevronLeft} title="Earlier" onClick={() => setAnchor(stepAnchor(mode, anchor, -1))} />
          <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 13.5, color: C.cream, minWidth: 116, textAlign: "center" }}>
            {periodLabel(mode, anchor)}
          </span>
          <Btn size="sm" icon={ChevronRight} title="Later" disabled={atToday}
            onClick={() => setAnchor(stepAnchor(mode, anchor, 1))} />
        </div>
        {loading && <Loader2 size={14} color={C.sageDim} className="animate-spin" />}
        <Btn size="sm" icon={exporting ? Loader2 : Download} onClick={onExport} disabled={exporting}
          style={{ marginLeft: "auto" }}>
          Export CSV
        </Btn>
      </div>

      {/* headline numbers */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: "16px 18px" }}>
          <Eyebrow>Collected</Eyebrow>
          <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 600, color: C.cream, marginTop: 8, letterSpacing: "-0.02em" }}>
            {money(gross, cur)}<Delta now={gross} before={Number(prev.gross) || 0} />
          </div>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim, marginTop: 4 }}>
            {t.bills || 0} bills · avg {money(Number(t.avg) || 0, cur)}
          </div>
        </div>

        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: "16px 18px" }}>
          <Eyebrow>Profit</Eyebrow>
          <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 600, color: C.brass, marginTop: 8, letterSpacing: "-0.02em" }}>
            {money(profit, cur)}<Delta now={profit} before={Number(prev.profit) || 0} />
          </div>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim, marginTop: 4 }}>
            {margin.toFixed(0)}% margin · cost {money(cost, cur)}
          </div>
        </div>

        <Stat label="Cash / card" value={money(Number(t.cash) || 0, cur)}
          sub={`card ${money(Number(t.card) || 0, cur)}`} />

        {totalVat > 0 && (
          <Stat label="VAT in these takings" value={money(round2(totalVat), cur)}
            sub={vat.map((v) => `${Number(v.rate)}%: ${money(Number(v.vat) || 0, cur)}`).join(" · ")} />
        )}
      </div>

      {/* things that need doing */}
      {(att.noFiscal > 0 || att.unpaidBills > 0 || att.zeroCostItems > 0) && (
        <div style={{ marginTop: 16, display: "grid", gap: 8 }}>
          {att.noFiscal > 0 && (
            <Notice tone={C.copper} icon={AlertTriangle}>
              {att.noFiscal} paid bill{att.noFiscal > 1 ? "s" : ""} with no fiscal receipt. A cash sale
              needs one at the time of payment — check the printer.
            </Notice>
          )}
          {att.unpaidBills > 0 && (
            <Notice tone={C.brass} icon={Receipt}>
              {att.unpaidBills} bill{att.unpaidBills > 1 ? "s" : ""} left on the tab,
              {" "}{money(Number(att.unpaidTotal) || 0, cur)} outstanding.
            </Notice>
          )}
          {att.zeroCostItems > 0 && (
            <Notice tone={C.sage} icon={ListOrdered}>
              {att.zeroCostItems} item{att.zeroCostItems > 1 ? "s" : ""} still have no purchase price,
              so profit here is overstated. Fill them in under Price list.
            </Notice>
          )}
        </div>
      )}

      {/* unpaid, with settle buttons */}
      {unpaid.length > 0 && (
        <div style={{ marginTop: 16, background: C.panel, border: `1px solid ${C.a35}`, borderRadius: 14, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.line}` }}>
            <Eyebrow style={{ color: C.brass }}>On the tab</Eyebrow>
          </div>
          {unpaid.map((b) => (
            <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", borderBottom: `1px solid ${C.lineFade}`, flexWrap: "wrap" }}>
              <span style={{ fontFamily: MONO, fontWeight: 700, color: C.brass, width: 40 }}>{b.tableLabel}</span>
              <span style={{ fontFamily: SANS, fontSize: 12.5, color: C.sage, flex: 1, minWidth: 120 }}>
                {b.staffName} · {shortDate(b.closedAt)}
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

      {/* chart */}
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginTop: 16 }}>
        <Eyebrow>{mode === "day" ? "Takings by hour" : "Takings by day"}</Eyebrow>
        <Bars series={report?.series || []} cur={cur} />
      </div>

      <div style={{ display: "flex", gap: 16, marginTop: 16, flexWrap: "wrap" }}>
        {mode !== "day" && (
          <Panel title="Best nights" flex="1 1 260px">
            <SplitList rows={report?.byWeekday || []} cur={cur}
              sub={(r) => `${r.days} day${r.days > 1 ? "s" : ""}`} />
          </Panel>
        )}
        <Panel title="Taken by" flex="1 1 260px">
          <SplitList rows={report?.byStaff || []} cur={cur} sub={(r) => `${r.bills} bills`} />
        </Panel>
        <Panel title="Where the money comes from" flex="1 1 260px">
          <SplitList rows={report?.byCategory || []} cur={cur} nameKey="category" />
        </Panel>
      </div>

      <ProductsSold rows={products} loading={productsLoading} cur={cur} />

      <FiscalPanel venue={venue} actions={actions} onTest={onTestPrinter}
        onRetryAll={onRetryFiscal} stuck={att.noFiscal || 0} />

      <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim, marginTop: 14, lineHeight: 1.5 }}>
        A day runs from {String(report?.cutoffHour ?? 5).padStart(2, "0")}:00 to
        {" "}{String(report?.cutoffHour ?? 5).padStart(2, "0")}:00, so late trade counts
        towards the night it started.
      </div>
    </div>
  );
}

/* What sold, how much of it, and what it earned. Sortable because an owner
   asks different questions on different days — what moves, and what pays. */
function ProductsSold({ rows, loading, cur }) {
  const [sort, setSort] = useState("gross");
  const [dir, setDir] = useState(-1);
  const [q, setQ] = useState("");
  const narrow = useNarrow("(max-width: 620px)");

  const shown = useMemo(() => {
    const f = q
      ? rows.filter((r) => (r.name + " " + r.category).toLowerCase().includes(q.toLowerCase()))
      : rows;
    return [...f].sort((a, b) => {
      const va = sort === "name" ? a.name : Number(a[sort]) || 0;
      const vb = sort === "name" ? b.name : Number(b[sort]) || 0;
      if (typeof va === "string") return dir * va.localeCompare(vb);
      return dir * (va - vb);
    });
  }, [rows, sort, dir, q]);

  const totals = shown.reduce((t, r) => ({
    qty: t.qty + Number(r.qty || 0),
    gross: t.gross + Number(r.gross || 0),
    profit: t.profit + Number(r.profit || 0),
  }), { qty: 0, gross: 0, profit: 0 });

  const GRID = "minmax(0,1fr) 62px 92px 92px 62px";

  /* On a phone the sort options are chips. As bare uppercase labels they read
     as column headings — which is what they are on a wide screen, and exactly
     what they are not here. */
  const chip = (key, label) => (
    <button key={key} onClick={() => { setDir(sort === key ? -dir : -1); setSort(key); }} style={{
      padding: "6px 11px", borderRadius: 99, cursor: "pointer",
      border: `1px solid ${sort === key ? C.brass : C.line}`,
      background: sort === key ? C.a10 : "transparent",
      color: sort === key ? C.brass : C.sage,
      fontFamily: SANS, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
    }}>
      {label}{sort === key ? (dir === -1 ? " ↓" : " ↑") : ""}
    </button>
  );

  const head = (key, label, align = "right") => (
    <button onClick={() => { setDir(sort === key ? -dir : -1); setSort(key); }} style={{
      background: "transparent", border: "none", cursor: "pointer", padding: 0,
      textAlign: align, fontFamily: SANS, fontSize: 10, fontWeight: 700,
      letterSpacing: "0.16em", textTransform: "uppercase",
      color: sort === key ? C.brass : C.sageDim,
    }}>
      {label}{sort === key ? (dir === -1 ? " ↓" : " ↑") : ""}
    </button>
  );

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, marginTop: 16, overflow: "hidden" }}>
      <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.line}`, display: "flex",
        alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Eyebrow>Sold in this period</Eyebrow>
        {loading && <Loader2 size={13} color={C.sageDim} className="animate-spin" />}
        <div style={{ position: "relative", marginLeft: "auto", minWidth: 160 }}>
          <Search size={13} color={C.sageDim} style={{ position: "absolute", left: 10, top: 9 }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a product"
            style={{ width: "100%", background: C.ink, border: `1px solid ${C.line}`, borderRadius: 8,
              padding: "7px 10px 7px 30px", color: C.cream, fontFamily: SANS, fontSize: 12.5, outline: "none" }} />
        </div>
      </div>

      {/* Stacked on a phone: five numeric columns need 400px and a phone has 360. */}
      <div style={{ display: "flex", gap: 14, padding: "10px 18px", flexWrap: "wrap",
        background: C.raise, borderBottom: `1px solid ${C.line}` }}>
        {narrow ? (
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center", width: "100%" }}>
            <span style={{ fontFamily: SANS, fontSize: 11, color: C.sageDim, marginRight: 2 }}>Sort</span>
            {chip("name", "Name")}
            {chip("qty", "Sold")}
            {chip("gross", "Money")}
            {chip("profit", "Profit")}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: GRID, gap: 14, width: "100%" }}>
            {head("name", "Product", "left")}
            {head("qty", "Sold")}
            {head("gross", "Money")}
            {head("profit", "Profit")}
            {head("margin", "Margin")}
          </div>
        )}
      </div>

      <div style={{ maxHeight: 460, overflowY: "auto" }}>
        {shown.map((r, i) => (
          <div key={i} style={narrow
            ? { padding: "11px 18px", borderBottom: `1px solid ${C.lineFade}` }
            : { display: "grid", gridTemplateColumns: GRID, gap: 14,
                padding: "11px 18px", borderBottom: `1px solid ${C.lineFade}`, alignItems: "center" }}>
            {narrow ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                  <span style={{ fontFamily: SANS, fontSize: 14.5, color: C.cream, minWidth: 0,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                  <span style={{ fontFamily: MONO, fontSize: 15, color: C.cream, whiteSpace: "nowrap" }}>
                    {money(Number(r.gross) || 0, cur)}
                  </span>
                </div>
                {/* Every number says what it is. Two bare amounts side by side
                    are unreadable — which one was the profit? */}
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 4 }}>
                  <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim }}>
                    <span style={{ fontFamily: MONO, color: C.sage }}>{r.qty}</span> sold
                    {" · "}{r.category}
                    {" · "}{Number(r.share || 0).toFixed(0)}%
                  </span>
                  <span style={{ fontFamily: SANS, fontSize: 11.5, whiteSpace: "nowrap",
                    color: Number(r.cost) > 0 ? C.brass : C.sageDim }}>
                    {Number(r.cost) > 0
                      ? <>profit <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{money(Number(r.profit) || 0, cur)}</span></>
                      : "no buy price"}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: SANS, fontSize: 13.5, color: C.cream, overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.sageDim, marginTop: 2 }}>
                    {r.category} · {Number(r.share || 0).toFixed(1)}% of takings
                  </div>
                </div>
                <span style={{ fontFamily: MONO, fontSize: 14, color: C.cream, textAlign: "right" }}>{r.qty}</span>
                <span style={{ fontFamily: MONO, fontSize: 13, color: C.creamDim, textAlign: "right" }}>
                  {money(Number(r.gross) || 0, cur)}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 13, textAlign: "right",
                  color: Number(r.cost) > 0 ? C.brass : C.sageDim }}>
                  {Number(r.cost) > 0 ? money(Number(r.profit) || 0, cur) : "—"}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 12, textAlign: "right",
                  color: Number(r.cost) > 0 ? C.sage : C.sageDim }}>
                  {Number(r.cost) > 0 ? `${Number(r.margin || 0).toFixed(0)}%` : "—"}
                </span>
              </>
            )}
          </div>
        ))}
        {!shown.length && !loading && (
          <div style={{ padding: 22, fontFamily: SANS, fontSize: 13, color: C.sageDim }}>
            {q ? "Nothing matches that." : "Nothing sold in this period."}
          </div>
        )}
      </div>

      {shown.length > 0 && (
        narrow ? (
          <div style={{ padding: "12px 18px", background: C.raise, borderTop: `1px solid ${C.line}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
              <span style={{ fontFamily: SANS, fontSize: 13, fontWeight: 700, color: C.cream }}>
                {shown.length} product{shown.length > 1 ? "s" : ""}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 15, color: C.cream }}>{money(totals.gross, cur)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 4 }}>
              <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim }}>
                <span style={{ fontFamily: MONO, color: C.sage }}>{totals.qty}</span> sold
              </span>
              <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.brass }}>
                profit <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{money(totals.profit, cur)}</span>
              </span>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: GRID, gap: 14, padding: "12px 18px",
            background: C.raise, borderTop: `1px solid ${C.line}` }}>
            <span style={{ fontFamily: SANS, fontSize: 12, fontWeight: 700, color: C.sage }}>
              {shown.length} product{shown.length > 1 ? "s" : ""}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 13, color: C.cream, textAlign: "right" }}>{totals.qty}</span>
            <span style={{ fontFamily: MONO, fontSize: 13, color: C.cream, textAlign: "right" }}>{money(totals.gross, cur)}</span>
            <span style={{ fontFamily: MONO, fontSize: 13, color: C.brass, textAlign: "right" }}>{money(totals.profit, cur)}</span>
            <span />
          </div>
        )
      )}
    </div>
  );
}

function FiscalPanel({ venue, actions, onTest, onRetryAll, stuck }) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState({
    enabled: venue.fiscalEnabled || false,
    url: venue.fiscalBridgeUrl || "",
    token: venue.fiscalBridgeToken || "",
    legalName: venue.legalName || "",
    taxId: venue.taxId || "",
  });
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, marginTop: 16 }}>
      <button onClick={() => setOpen(!open)} style={{
        width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "14px 18px",
        background: "transparent", border: "none", cursor: "pointer", textAlign: "left",
      }}>
        <Printer size={15} color={venue.fiscalEnabled ? C.brass : C.sageDim} />
        <span style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: C.cream }}>
          Fiscal printer
        </span>
        <span style={{ fontFamily: SANS, fontSize: 12, color: venue.fiscalEnabled ? C.mint : C.sageDim }}>
          {venue.fiscalEnabled ? (venue.fiscalBridgeUrl ? "connected" : "on, no address set") : "off"}
        </span>
        {stuck > 0 && (
          <span style={{ fontFamily: MONO, fontSize: 11, color: C.copper, border: `1px solid ${C.copper}55`,
            borderRadius: 99, padding: "2px 8px" }}>{stuck} not printed</span>
        )}
        <ChevronRight size={16} color={C.sageDim}
          style={{ marginLeft: "auto", transform: open ? "rotate(90deg)" : "none", transition: "transform 150ms" }} />
      </button>

      {open && (
        <div style={{ padding: "0 18px 18px", display: "grid", gap: 12 }}>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim, lineHeight: 1.5 }}>
            The printer sits on this bar's own wifi, so receipts still print when the
            internet is down. See docs/fiscal-bridge.md.
          </div>

          <Field label="Bridge address" value={cfg.url} mono
            onChange={(v) => setCfg({ ...cfg, url: v })} placeholder="http://192.168.1.50:8377" />
          <Field label="Shared token (optional)" value={cfg.token} mono
            onChange={(v) => setCfg({ ...cfg, token: v })} placeholder="leave blank if unset" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Registered name" value={cfg.legalName}
              onChange={(v) => setCfg({ ...cfg, legalName: v })} placeholder="Fjaka DOOEL" />
            <Field label="Tax number (ЕДБ)" value={cfg.taxId} mono
              onChange={(v) => setCfg({ ...cfg, taxId: v })} />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontFamily: SANS, fontSize: 13, color: C.cream, flex: 1 }}>
              Print a receipt when a bill is paid
            </span>
            <button onClick={() => setCfg({ ...cfg, enabled: !cfg.enabled })} style={{
              width: 50, height: 28, borderRadius: 99, cursor: "pointer", padding: 0, position: "relative",
              border: `1px solid ${cfg.enabled ? C.brass : C.line2}`,
              background: cfg.enabled ? C.a20 : C.raise,
            }}>
              <span style={{ position: "absolute", top: 3, left: cfg.enabled ? 25 : 3, width: 20, height: 20,
                borderRadius: 99, background: cfg.enabled ? C.brass : C.sageDim, transition: "left 150ms" }} />
            </button>
          </div>

          {status && (
            <div style={{ fontFamily: MONO, fontSize: 12, padding: "10px 12px", borderRadius: 9,
              background: C.ink, border: `1px solid ${status.ok ? C.line2 : C.copper}`,
              color: status.ok ? C.mint : C.copper }}>
              {status.ok
                ? `${status.device} · paper ${status.paper} · ${status.printedToday ?? 0} printed`
                : status.message || status.error}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn icon={busy ? Loader2 : Printer} disabled={busy || !cfg.url}
              onClick={async () => { setBusy(true); setStatus(await onTest(cfg)); setBusy(false); }}>
              Test connection
            </Btn>
            {stuck > 0 && <Btn variant="ghost" icon={RotateCw} onClick={onRetryAll}>Print the {stuck} missed</Btn>}
            <Btn variant="solid" icon={Check} style={{ marginLeft: "auto" }}
              onClick={() => actions.saveFiscal(cfg)}>Save</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

function Panel({ title, children, flex }) {
  return (
    <div style={{ flex, minWidth: 240, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18 }}>
      <Eyebrow>{title}</Eyebrow>
      {children}
    </div>
  );
}

function Row2({ a, b }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span>{a}</span><span style={{ color: C.creamDim }}>{b}</span>
    </div>
  );
}

function Notice({ tone, icon: Icon, children }) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 10, padding: "11px 14px",
      background: `${tone}12`, border: `1px solid ${tone}44`, borderRadius: 11,
    }}>
      <Icon size={15} color={tone} style={{ flexShrink: 0, marginTop: 1 }} />
      <span style={{ fontFamily: SANS, fontSize: 12.5, color: C.cream, lineHeight: 1.5 }}>{children}</span>
    </div>
  );
}

function Team({ venue, staff: allStaff, flash, actions }) {
  const [editing, setEditing] = useState(null);
  const [issued, setIssued] = useState(null);
  const [deleting, setDeleting] = useState(null);   // { bar, preview }
  const [confirmText, setConfirmText] = useState("");
  // Never list the owner here — deleting that row would lock them out of
  // their own bar. The database refuses it too, but it shouldn't be offered.
  const staff = (allStaff || []).filter((s) => s.role !== "owner");
  const plan = PLANS[venue.subscription.plan];

  // The database rejects a PIN already used at this bar, so we don't duplicate
  // that check here — it would only ever be a weaker copy.
  const save = async (s) => {
    const pin = String(s.pin || "").replace(/\D/g, "").slice(0, 4);
    if (!s.id && pin.length !== 4) return flash("A PIN must be 4 digits.");
    if (pin && pin.length !== 4) return flash("A PIN must be 4 digits.");
    const ok = await actions.saveStaff({ id: s.id, name: s.name, pin: pin || null });
    if (ok) setEditing(null);
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
          if (staff.length >= plan.maxStaff) return flash(`${plan.name} covers ${plan.maxStaff} waiters.`);
          setEditing({ id: null, name: "", pin: "" });
        }}>Add waiter</Btn>
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, overflow: "hidden", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: `1px solid ${C.line}` }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: `${C.a12}`, border: `1px solid ${C.brassDim}`, display: "grid", placeItems: "center" }}>
            <ShieldCheck size={15} color={C.brass} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: SANS, fontSize: 14, color: C.cream, fontWeight: 600 }}>
              {venue.ownerName} <span style={{ color: C.sageDim, fontWeight: 400 }}>(you)</span>
            </div>
            <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim }}>
              Owner — sees the money, and takes orders like anyone else
            </div>
          </div>
          <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim }}>PIN set at setup</span>
        </div>
        {staff.map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", borderBottom: `1px solid ${C.lineFade}` }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: C.raise, border: `1px solid ${C.line}`, display: "grid", placeItems: "center", fontFamily: MONO, color: C.sage, fontSize: 13 }}>
              {s.name.slice(0, 1).toUpperCase() || "?"}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: SANS, fontSize: 14, color: C.cream, fontWeight: 600 }}>{s.name}</div>
              <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim }}>Waiter — orders and payments only</div>
            </div>
            <Btn size="sm" variant="bare" icon={KeyRound} title="Give them a new PIN"
              onClick={async () => {
                const pin = await actions.resetStaffPin(s.id);
                if (pin) setIssued({ pin, name: s.name });
              }} />
            <Btn size="sm" variant="bare" icon={Trash2} style={{ color: C.sageDim }} onClick={() => actions.removeStaff(s.id)} />
          </div>
        ))}
        {!staff.length && (
          <div style={{ padding: "18px 20px", fontFamily: SANS, fontSize: 13, color: C.sageDim, lineHeight: 1.6 }}>
            No waiters — you're running this bar on your own, which works fine.
            Use <strong style={{ color: C.brass }}>Serve</strong> at the top to hide the admin tabs
            while you're on the floor. Add someone here when you take help on.
          </div>
        )}
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontFamily: SANS, fontSize: 14, color: C.cream, fontWeight: 600 }}>Let waiters give discounts</div>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim, marginTop: 3 }}>Off by default, so nobody discounts a bill without you.</div>
        </div>
        <button onClick={() => actions.setDiscountPolicy(!venue.allowStaffDiscount)} style={{
          width: 50, height: 28, borderRadius: 99, border: `1px solid ${venue.allowStaffDiscount ? C.brass : C.line2}`,
          background: venue.allowStaffDiscount ? `${C.a20}` : C.raise, cursor: "pointer", position: "relative", padding: 0,
        }}>
          <span style={{
            position: "absolute", top: 3, left: venue.allowStaffDiscount ? 25 : 3, width: 20, height: 20,
            borderRadius: 99, background: venue.allowStaffDiscount ? C.brass : C.sageDim, transition: "left 150ms",
          }} />
        </button>
      </div>

      {issued && (
        <Modal onClose={() => setIssued(null)} width={340}>
          <div style={{ textAlign: "center" }}>
            <KeyRound size={20} color={C.brass} />
            <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16, marginTop: 12 }}>
              New PIN for {issued.name}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 36, letterSpacing: "0.24em", color: C.brass, margin: "16px 0 6px" }}>
              {issued.pin}
            </div>
            <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, lineHeight: 1.5 }}>
              Tell them now — PINs are stored scrambled and can't be shown again.
            </div>
            <Btn variant="solid" style={{ width: "100%", marginTop: 16 }} onClick={() => setIssued(null)}>Done</Btn>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal onClose={() => setEditing(null)} width={340}>
          <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16, marginBottom: 16 }}>
            {editing.id ? "Edit waiter" : "Add waiter"}
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            <Field label="Name" value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} placeholder="Ana" />
            <Field label={editing.id ? "New PIN (leave blank to keep)" : "4-digit PIN"} value={editing.pin} onChange={(v) => setEditing({ ...editing, pin: v.replace(/\D/g, "").slice(0, 4) })} mono maxLength={4} placeholder="1234" />
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

/* --------------------------------------------------------------- branding */

function Branding({ venue, flash, actions }) {
  const [accent, setAccent] = useState(venue.brandAccent || DEFAULT_BRAND.accent);
  const [surface, setSurface] = useState(venue.brandSurface || DEFAULT_BRAND.surface);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  // Preview live, so a choice can be judged rather than imagined.
  useEffect(() => { applyTheme({ accent, surface }); }, [accent, surface]);

  const valid = !!parseHex(accent);
  const ratio = valid ? contrast(buildTheme({ accent, surface }).accent, SURFACES[surface].ink) : 0;

  const save = async () => {
    if (!valid) return flash("That isn't a colour — use a hex like #E6B450");
    setBusy(true);
    const ok = await actions.saveBranding({ accent, surface });
    setBusy(false);
    if (ok) { rememberBrand({ accent, surface }); flash("Branding saved"); }
  };

  const pickLogo = async (file) => {
    if (!file) return;
    if (file.size > 512 * 1024) return flash("Logo must be under 512 KB");
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) return flash("Use a PNG, JPG, WebP or SVG");
    setBusy(true);
    const url = await actions.uploadLogo(file);
    setBusy(false);
    if (url) flash("Logo updated");
  };

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 620 }}>
      <div>
        <Eyebrow>Make it theirs</Eyebrow>
        <div style={{ fontFamily: SANS, fontSize: 13, color: C.sageDim, marginTop: 4, lineHeight: 1.5 }}>
          Staff see this on the sign-in screen and in the header. Changes preview
          as you pick them.
        </div>
      </div>

      {/* logo */}
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16,
        display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <Mark logoUrl={venue.logoUrl} size={56} radius={13} />
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontFamily: SANS, fontSize: 14, fontWeight: 600, color: C.cream }}>Logo</div>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim, marginTop: 3, lineHeight: 1.45 }}>
            Square works best. PNG with a transparent background looks cleanest on dark.
            Under 512 KB.
          </div>
        </div>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml"
          style={{ display: "none" }} onChange={(e) => pickLogo(e.target.files?.[0])} />
        <Btn icon={ImageIcon} disabled={busy} onClick={() => fileRef.current?.click()}>
          {venue.logoUrl ? "Replace" : "Upload"}
        </Btn>
        {venue.logoUrl && (
          <Btn variant="bare" icon={Trash2} disabled={busy} style={{ color: C.sageDim }}
            onClick={() => actions.removeLogo()} />
        )}
      </div>

      {/* surface */}
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16 }}>
        <Eyebrow style={{ marginBottom: 10 }}>Room tone</Eyebrow>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 8 }}>
          {Object.entries(SURFACES).map(([key, sf]) => (
            <button key={key} onClick={() => setSurface(key)} style={{
              padding: 10, borderRadius: 11, cursor: "pointer", textAlign: "left",
              border: `1px solid ${surface === key ? C.brass : C.line}`,
              background: sf.ink,
            }}>
              <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                {[sf.panel, sf.raise, sf.line2].map((c, i) => (
                  <span key={i} style={{ width: 14, height: 14, borderRadius: 4, background: c,
                    border: `1px solid ${sf.line}` }} />
                ))}
                <span style={{ width: 14, height: 14, borderRadius: 4, background: accent }} />
              </div>
              <div style={{ fontFamily: SANS, fontSize: 12, fontWeight: 600,
                color: surface === key ? C.brass : sf.cream }}>{sf.name}</div>
            </button>
          ))}
        </div>
        <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim, marginTop: 10, lineHeight: 1.45 }}>
          All dark on purpose. A bright screen in a dim room blinds whoever is
          holding it and washes out the floor plan.
        </div>
      </div>

      {/* accent */}
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16 }}>
        <Eyebrow style={{ marginBottom: 10 }}>Accent</Eyebrow>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {ACCENT_SUGGESTIONS.map((hex) => (
            <button key={hex} onClick={() => setAccent(hex)} title={hex} style={{
              width: 34, height: 34, borderRadius: 9, background: hex, cursor: "pointer",
              border: accent.toLowerCase() === hex.toLowerCase()
                ? `2px solid ${C.cream}` : `1px solid ${C.line2}`,
            }} />
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 150px" }}>
            <Field label="Hex" value={accent} onChange={setAccent} mono placeholder="#E6B450" />
          </div>
          <input type="color" value={parseHex(accent) ? accent : "#E6B450"}
            onChange={(e) => setAccent(e.target.value)}
            style={{ width: 46, height: 42, background: "transparent", border: `1px solid ${C.line}`,
              borderRadius: 9, cursor: "pointer", padding: 3 }} />
        </div>
        {valid && ratio < 4.5 && (
          <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.copper, marginTop: 10, lineHeight: 1.45 }}>
            That colour is dim against this surface, so it gets lightened
            automatically to stay readable. Pick something brighter for an exact match.
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" onClick={() => {
          setAccent(venue.brandAccent || DEFAULT_BRAND.accent);
          setSurface(venue.brandSurface || DEFAULT_BRAND.surface);
        }}>Revert</Btn>
        <Btn variant="solid" icon={busy ? Loader2 : Check} disabled={busy} onClick={save}
          style={{ flex: 1 }}>Save branding</Btn>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ platform side */

function AdminBars({ venues, todayByBar, now, openAsOwner, flash, actions, loading }) {
  const [detail, setDetail] = useState(null);
  const [adding, setAdding] = useState(null);
  const [issued, setIssued] = useState(null);
  const [deleting, setDeleting] = useState(null);   // { bar, preview }
  const [confirmText, setConfirmText] = useState("");

  const states = venues.map((v) => subState(v, now));
  const mrr = venues.reduce((s, v, i) => s + (canOperate(states[i]) ? v.subscription.price : 0), 0);
  const overdue = venues.filter((_, i) => states[i] === "past_due" || states[i] === "locked");
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const collected = venues.reduce((s, v) => s + v.subscription.payments.filter((p) => p.paidAt >= monthStart).reduce((x, p) => x + p.amount, 0), 0);

  const recordPayment = (v) => actions.recordPayment(v);
  const toggleSuspend = (v) => actions.toggleSuspend(v);
  const changePlan = (v, planId) => actions.changePlan(v, planId);

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 18 }}>
        <Stat label="Monthly recurring" value={money(mrr)} accent={C.brass} sub={`${venues.length} bars on the books`} />
        <Stat label="Collected this month" value={money(collected)} sub="payments you logged" />
        <Stat label="Chasing" value={money(overdue.reduce((s, v) => s + v.subscription.price, 0))} accent={overdue.length ? C.copper : C.cream} sub={`${overdue.length} bars behind`} />
        <Stat label="Paying now" value={venues.filter((_, i) => states[i] === "active").length} sub={`${venues.filter((_, i) => states[i] === "trial").length} on trial`} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Eyebrow>Your bars</Eyebrow>
          {loading && <Loader2 size={13} color={C.sageDim} className="animate-spin" />}
        </div>
        <Btn variant="solid" icon={Plus} onClick={() => setAdding({
          name: "", address: "", currency: "MKD", ownerName: "", ownerPin: "",
          plan: "starter", trialDays: 14,
        })}>Add a bar</Btn>
      </div>

      {!venues.length && !loading && (
        <div style={{ background: C.panel, border: `1px dashed ${C.line2}`, borderRadius: 14, padding: 36, textAlign: "center" }}>
          <Store size={22} color={C.sageDim} style={{ marginBottom: 12 }} />
          <div style={{ fontFamily: SANS, fontSize: 14, color: C.cream }}>No bars yet</div>
          <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, marginTop: 6 }}>
            Add your first client and they get a bar code to set up their tablets.
          </div>
        </div>
      )}

      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, overflow: "hidden", display: venues.length ? "block" : "none" }}>
        {venues.map((v, i) => {
          const st = states[i], meta = STATE_META[st];
          const todayTotal = todayByBar[v.id] || 0;
          return (
            <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderBottom: `1px solid ${C.lineFade}`, flexWrap: "wrap" }}>
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
                  {money(round2(todayTotal), v.currency)}
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
                  background: v.subscription.plan === p.id ? `${C.a10}` : "transparent",
                }}>
                  <div style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 700, color: v.subscription.plan === p.id ? C.brass : C.cream }}>{p.name}</div>
                  <div style={{ fontFamily: MONO, fontSize: 12, color: C.sage, marginTop: 3 }}>{money(p.price, "EUR")}/mo</div>
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

            <Btn icon={LayoutGrid} style={{ width: "100%", marginBottom: 10 }} onClick={() => { setDetail(null); openAsOwner(v.id); }}>
              Open this bar as the owner
            </Btn>

            <Btn icon={KeyRound} style={{ width: "100%", marginBottom: 16 }}
              onClick={async () => {
                const pin = await actions.resetOwnerPin(v);
                if (pin) { setDetail(null); setIssued({ pin, bar: v.name, owner: v.ownerName }); }
              }}>
              Owner forgot their PIN
            </Btn>

            <Eyebrow style={{ marginBottom: 8 }}>Bar code — put this into their tablets once</Eyebrow>
            <div style={{ background: C.ink, border: `1px dashed ${C.line2}`, borderRadius: 10, padding: "12px 14px", marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontFamily: MONO, fontSize: 26, color: C.brass, letterSpacing: "0.28em" }}>{v.code}</span>
              <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim, flex: 1, lineHeight: 1.45 }}>
                Unique across every bar you sell to. Regenerating it signs out their devices.
              </span>
              <Btn size="sm" icon={RotateCw} title="Issue a new code" onClick={() => actions.regenerateCode(v)} />
            </div>

            <Eyebrow style={{ marginBottom: 8 }}>People at this bar</Eyebrow>
            <div style={{ background: C.ink, border: `1px dashed ${C.line2}`, borderRadius: 10, padding: 12, marginBottom: 16, fontFamily: SANS, fontSize: 12.5, color: C.sage, lineHeight: 1.8 }}>
              <div>{v.ownerName} — owner</div>
              {v.staff.map((s) => <div key={s.id}>{s.name} — waiter</div>)}
              <div style={{ fontSize: 11, color: C.sageDim, marginTop: 6 }}>
                PINs are hashed and can't be read back — not by you either. The owner
                can reset one from their Team tab.
              </div>
            </div>

            <Eyebrow style={{ marginBottom: 8 }}>Payment history</Eyebrow>
            <div style={{ maxHeight: 160, overflowY: "auto" }}>
              {[...v.subscription.payments].reverse().map((p) => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.lineFade}`, fontFamily: MONO, fontSize: 12.5 }}>
                  <span style={{ color: C.sage }}>{shortDate(p.paidAt)}</span>
                  <span style={{ color: C.sageDim, fontFamily: SANS, fontSize: 11.5 }}>{p.note}</span>
                  <span style={{ color: C.cream }}>{money(p.amount)}</span>
                </div>
              ))}
              {!v.subscription.payments.length && <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim }}>No payments recorded yet.</div>}
            </div>

            <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 18, paddingTop: 14 }}>
              <Eyebrow style={{ color: C.copper, marginBottom: 8 }}>Danger</Eyebrow>
              <Btn variant="danger" icon={Trash2} style={{ width: "100%" }}
                onClick={async () => {
                  const preview = await actions.deletePreview(v);
                  if (preview) { setDetail(null); setConfirmText(""); setDeleting({ bar: v, preview }); }
                }}>
                Delete this bar permanently
              </Btn>
            </div>

            <Btn variant="ghost" style={{ width: "100%", marginTop: 16 }} onClick={() => setDetail(null)}>Close</Btn>
          </Modal>
        );
      })()}

      {issued && (
        <Modal onClose={() => setIssued(null)} width={360}>
          <div style={{ textAlign: "center" }}>
            <KeyRound size={22} color={C.brass} />
            <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 17, marginTop: 12 }}>
              New PIN for {issued.bar}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 40, letterSpacing: "0.24em", color: C.brass, margin: "18px 0 6px" }}>
              {issued.pin}
            </div>
            <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, lineHeight: 1.55 }}>
              Read this to {issued.owner} now — it is stored as a hash and can
              never be shown again. Their old PIN no longer works.
            </div>
            <Btn variant="solid" style={{ width: "100%", marginTop: 18 }} onClick={() => setIssued(null)}>
              Done
            </Btn>
          </div>
        </Modal>
      )}

      {deleting && (
        <Modal onClose={() => setDeleting(null)} width={430}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <AlertTriangle size={20} color={C.copper} />
            <span style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 17 }}>
              Delete {deleting.bar.name}?
            </span>
          </div>
          <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, marginBottom: 14, lineHeight: 1.5 }}>
            This cannot be undone. Suspending instead keeps everything and simply
            stops them signing in.
          </div>

          <div style={{ background: C.ink, border: "1px solid rgba(212,103,74,0.3)", borderRadius: 11,
            padding: 14, marginBottom: 14 }}>
            <Eyebrow style={{ marginBottom: 8 }}>What gets destroyed</Eyebrow>
            <div style={{ display: "grid", gap: 5, fontFamily: MONO, fontSize: 12.5, color: C.sage }}>
              <Row2 a={`${deleting.preview.bills} bills`}
                    b={money(Number(deleting.preview.takings) || 0, deleting.preview.currency)} />
              <Row2 a={`${deleting.preview.articles} articles`} b={`${deleting.preview.tables} tables`} />
              <Row2 a={`${deleting.preview.staff} people`} b={`${deleting.preview.openOrders} tables open now`} />
              {deleting.preview.fiscalReceipts > 0 && (
                <div style={{ color: C.copper, fontFamily: SANS, fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
                  {deleting.preview.fiscalReceipts} of these bills carry a fiscal receipt number.
                  Fiscal records have a retention period — export them before deleting.
                </div>
              )}
            </div>
          </div>

          <Field label={`Type ${deleting.bar.name} to confirm`} value={confirmText} onChange={setConfirmText} />

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <Btn variant="ghost" style={{ flex: 1 }} onClick={() => setDeleting(null)}>Keep it</Btn>
            <Btn variant="danger" icon={Trash2} style={{ flex: 1 }}
              disabled={confirmText !== deleting.bar.name}
              onClick={async () => {
                const done = await actions.deleteBar(deleting.bar, confirmText);
                if (done) setDeleting(null);
              }}>
              Delete for good
            </Btn>
          </div>
        </Modal>
      )}

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
              <div>
                <Eyebrow style={{ marginBottom: 6 }}>Currency</Eyebrow>
                <select
                  value={adding.currency}
                  onChange={(e) => setAdding({ ...adding, currency: e.target.value })}
                  style={{
                    width: "100%", background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9,
                    padding: "10px 12px", color: C.cream, fontFamily: SANS, fontSize: 14, outline: "none",
                    appearance: "none",
                  }}
                >
                  {Object.entries(CURRENCIES).map(([code, c]) => (
                    <option key={code} value={code}>
                      {code} — {money(1234.5, code)}
                    </option>
                  ))}
                </select>
              </div>
              <Field label="Trial days" type="number" value={adding.trialDays} onChange={(v) => setAdding({ ...adding, trialDays: v })} mono />
            </div>
            <div>
              <Eyebrow style={{ marginBottom: 6 }}>Plan</Eyebrow>
              <div style={{ display: "flex", gap: 8 }}>
                {Object.values(PLANS).map((p) => (
                  <button key={p.id} onClick={() => setAdding({ ...adding, plan: p.id })} style={{
                    flex: 1, padding: "9px 6px", borderRadius: 10, cursor: "pointer",
                    border: `1px solid ${adding.plan === p.id ? C.brass : C.line}`,
                    background: adding.plan === p.id ? `${C.a10}` : "transparent",
                    color: adding.plan === p.id ? C.brass : C.sage, fontFamily: SANS, fontSize: 12, fontWeight: 700,
                  }}>{p.name}<div style={{ fontFamily: MONO, fontSize: 11, opacity: 0.8, marginTop: 2 }}>{money(p.price, "EUR")}</div></button>
                ))}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            <Btn variant="ghost" style={{ flex: 1 }} onClick={() => setAdding(null)}>Cancel</Btn>
            <Btn variant="solid" icon={Check} style={{ flex: 1 }} onClick={async () => {
              if (!/^[0-9]{4}$/.test(adding.ownerPin)) return flash("The owner needs a 4-digit PIN.");
              const created = await actions.createBar(adding);
              if (created) {
                setAdding(null);
                flash(`${created.name} added — bar code ${created.code}`);
              }
            }}>Create bar</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- app */
/* ---------------------------------------------- platform sign-in (email/pw) */

function PlatformForm({ onSubmit, error, busy }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const go = () => email && pw && onSubmit(email, pw);
  return (
    <div>
      <div style={{ display: "grid", gap: 10 }}>
        <Field label="Email" value={email} onChange={setEmail} type="email" placeholder="you@example.com" />
        <Field label="Password" value={pw} onChange={setPw} type="password" placeholder="••••••••" />
      </div>
      <div style={{ minHeight: 30, textAlign: "center", fontSize: 12.5, color: C.copper, marginTop: 10, lineHeight: 1.4 }}>
        {error || ""}
      </div>
      <Btn variant="solid" size="lg" disabled={busy || !email || !pw} onClick={go}
        icon={busy ? Loader2 : undefined} style={{ width: "100%" }}>
        {busy ? "Signing in…" : "Sign in"}
      </Btn>
    </div>
  );
}

/* ------------------------------------------------------------- small screens */

/* Android hands us a real install prompt. iOS never does, so it gets told
   where the button is instead. Either way this only shows in a browser tab —
   once installed, display-mode is standalone and it disappears. */
function useInstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
    if (standalone || sessionStorage.getItem("backbar.install.dismissed")) return;

    const onPrompt = (e) => { e.preventDefault(); setDeferred(e); setShow(true); };
    window.addEventListener("beforeinstallprompt", onPrompt);

    const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (iOS) setShow(true);

    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const install = async () => {
    if (!deferred) return false;
    deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
    setShow(false);
    return true;
  };
  const dismiss = () => {
    sessionStorage.setItem("backbar.install.dismissed", "1");
    setShow(false);
  };
  return { show, canPrompt: !!deferred, install, dismiss };
}

function InstallBar({ prompt }) {
  if (!prompt.show) return null;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, padding: "10px 16px",
      background: `${C.a08}`, borderBottom: `1px solid ${C.brassDim}`, flexWrap: "wrap",
    }}>
      <Download size={15} color={C.brass} />
      <span style={{ fontSize: 12.5, color: C.brass, flex: 1, minWidth: 180 }}>
        {prompt.canPrompt
          ? "Install Backbar for full screen and offline service."
          : "Add to Home Screen from the Share menu for full screen and offline service."}
      </span>
      {prompt.canPrompt && <Btn size="sm" variant="solid" onClick={prompt.install}>Install</Btn>}
      <Btn size="sm" variant="bare" icon={X} onClick={prompt.dismiss} />
    </div>
  );
}

/* A bar's own mark where ours used to be. Falls back to the glass, and falls
   back again if the image 404s — a broken logo must not leave a blank header. */
function Mark({ logoUrl, size = 30, radius = 8 }) {
  const [failed, setFailed] = useState(false);
  if (logoUrl && !failed) {
    return (
      <img
        src={logoUrl} alt="" width={size} height={size} onError={() => setFailed(true)}
        style={{ width: size, height: size, borderRadius: radius, objectFit: "cover",
          border: `1px solid ${C.line2}`, background: C.raise, flexShrink: 0 }}
      />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: radius, border: `1.5px solid ${C.brass}`,
      display: "grid", placeItems: "center", boxShadow: `0 0 18px -4px ${C.glow}`, flexShrink: 0,
    }}>
      <Wine size={size * 0.5} color={C.brass} />
    </div>
  );
}

/* A new build is live. Offer it rather than forcing it: reloading while a
   waiter is mid-order would lose the round they are taking. */
function UpdateChip() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const on = () => setReady(true);
    window.addEventListener("backbar:update-ready", on);
    return () => window.removeEventListener("backbar:update-ready", on);
  }, []);
  if (!ready) return null;
  return (
    <button onClick={() => location.reload()} style={{
      position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 210,
      display: "flex", alignItems: "center", gap: 9, padding: "11px 18px", borderRadius: 99,
      background: C.brass, color: C.onBrass, border: "none", cursor: "pointer",
      fontFamily: SANS, fontSize: 13, fontWeight: 700,
      boxShadow: "0 10px 40px -10px rgba(0,0,0,0.8)",
    }}>
      <RotateCw size={15} /> New version ready — tap to update
    </button>
  );
}

function Splash({ text = "Opening the floor…" }) {
  return (
    <div style={{ minHeight: "100vh", background: C.ink, display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, color: C.sageDim, fontFamily: SANS, fontSize: 14 }}>
        <Loader2 size={16} className="animate-spin" /> {text}
      </div>
    </div>
  );
}

function Blocked({ message, onBack }) {
  return (
    <div style={{ minHeight: "100vh", background: C.ink, display: "grid", placeItems: "center", padding: 24 }}>
      <div style={{ maxWidth: 340, textAlign: "center" }}>
        <AlertTriangle size={26} color={C.copper} style={{ marginBottom: 14 }} />
        <div style={{ fontFamily: SANS, fontSize: 15, color: C.cream, lineHeight: 1.55 }}>{message}</div>
        <Btn style={{ marginTop: 18 }} icon={ArrowLeft} onClick={onBack}>Back to sign in</Btn>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- app */

export default function App() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState(null);
  const [paired, setPaired] = useState(() => loadPairing());
  const [authBusy, setAuthBusy] = useState(false);
  const [loginError, setLoginError] = useState("");

  const [tab, setTab] = useState("floor");
  const [zoneId, setZoneId] = useState(null);
  const [openTableId, setOpenTableId] = useState(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const now = useNow(20000);
  const installPrompt = useInstallPrompt();
  const [logoStamp, setLogoStamp] = useState(1);

  /* In a small bar the owner works the floor. They can already take orders —
     nothing ever stopped them — but six admin tabs mid-service is the wrong
     shape. Serving mode collapses the app to the floor and back.

     Remembered per device: the owner's phone can stay in serving mode while
     the tablet behind the bar stays in owner mode. */
  const [serving, setServing] = useState(() => {
    try { return localStorage.getItem("backbar.serving") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("backbar.serving", serving ? "1" : "0"); } catch { /* private mode */ }
  }, [serving]);

  // Last known branding, so the app opens in the bar's colours rather than
  // flashing ours first.
  useEffect(() => { applyTheme(recallBrand()); }, []);

  const flash = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  }, []);

  /* ---- restore whatever session survived a refresh ---- */
  useEffect(() => {
    let dead = false;
    (async () => {
      const staff = loadStaffSession();
      if (staff) {
        if (!dead) { setSession(staff); setBooting(false); }
        return;
      }
      const platform = await restorePlatformSession().catch(() => null);
      if (!dead) {
        if (platform) { setSession(platform); setTab("bars"); }
        setBooting(false);
      }
    })();
    return () => { dead = true; };
  }, []);

  /* ---- a shift token expires mid-service; drop to the PIN pad, don't error ---- */
  useEffect(() => onExpired(session, () => {
    setSession(null);
    setOpenTableId(null);
    setLoginError("Your shift session ended. Enter your PIN again.");
  }), [session]);

  /* ---- the bar's live data ---- */
  const {
    data, loading, error: dataError, refresh, write, sync, clearError,
    online, syncing, pendingCount,
  } = useBarData(session && session.role !== "platform" ? session : null);
  const client = useMemo(() => (session ? clientFor(session) : null), [session]);

  const venueRaw = data?.venue || null;
  const venue = useMemo(() => {
    if (!venueRaw) return null;
    return { ...venueRaw, logoUrl: client ? api.logoUrl(client, venueRaw.logoPath, logoStamp) : null };
  }, [venueRaw, client, logoStamp]);
  const zones = data?.zones || [];
  const articles = data?.articles || [];
  const orders = data?.orders || {};

  useEffect(() => {
    if (zones.length && (!zoneId || !zones.some((z) => z.id === zoneId))) setZoneId(zones[0].id);
  }, [zones, zoneId]);

  useEffect(() => {
    if (!venue) return;
    const brand = { accent: venue.brandAccent, surface: venue.brandSurface };
    applyTheme(brand);
    rememberBrand(brand);
  }, [venue?.brandAccent, venue?.brandSurface, venue]);

  const zone = zones.find((z) => z.id === zoneId) || zones[0] || null;
  const table = zone?.tables.find((t) => t.id === openTableId) || null;

  // Orders are keyed by id; the floor needs them keyed by table.
  const ordersByTable = useMemo(() => {
    const m = {};
    Object.values(orders).forEach((o) => { m[`${o.venueId}/${o.tableId}`] = o; });
    return m;
  }, [orders]);
  const openOrder = table ? ordersByTable[`${venue?.id}/${table.id}`] : null;

  /* ---- auth handlers ---- */
  const doPair = async (code) => {
    setAuthBusy(true); setLoginError("");
    try {
      const bar = await pairDevice(code);
      setPaired(bar);
      const brand = { accent: bar.accent, surface: bar.surface };
      applyTheme(brand);
      rememberBrand(brand);
    } catch (e) { setLoginError(e.message); }
    finally { setAuthBusy(false); }
  };

  const doPin = async (pin) => {
    setAuthBusy(true); setLoginError("");
    try {
      const s = await signInStaff(pin);
      setSession(s); setTab("floor");
    } catch (e) { setLoginError(e.message); }
    finally { setAuthBusy(false); }
  };

  const doPlatform = async (email, pw) => {
    setAuthBusy(true); setLoginError("");
    try {
      setSession(await signInPlatform(email, pw)); setTab("bars");
    } catch (e) { setLoginError(e.message); }
    finally { setAuthBusy(false); }
  };

  const doSignOut = async () => {
    await signOut();
    setSession(null); setOpenTableId(null); setLoginError("");
    applyTheme(recallBrand());
  };

  /* ---- actions the screens call ---- */
  const guard = useCallback(async (fn, okMsg) => {
    try {
      const out = await fn(client);
      refresh();
      if (okMsg) flash(okMsg);
      return out ?? true;
    } catch (e) {
      flash(e.message);
      return null;
    }
  }, [client, refresh, flash]);

  const barActions = useMemo(() => ({
    saveTable: (zid, t) => guard((c) => api.upsertTable(c, venue.id, zid, t)),
    moveTable: (id, x, y) => api.moveTable(client, id, x, y).catch((e) => flash(e.message)),
    deleteTable: (id) => guard((c) => api.deleteTable(c, id)),
    saveZone: (z) => guard((c) => api.upsertZone(c, venue.id, z)),
    deleteZone: (id) => guard((c) => api.deleteZone(c, id)),
    saveArticle: (a) => guard((c) => api.upsertArticle(c, venue.id, a), "Price list updated"),
    removeArticle: (id) => guard((c) => api.deleteArticle(c, id), "Article removed"),
    saveStaff: (s2) => guard((c) => api.upsertStaff(c, venue.id, s2), "Team updated"),
    resetStaffPin: (id) => guard((c) => api.resetStaffPin(c, id)),
    removeStaff: (id) => guard((c) => api.deactivateStaff(c, id)),
    setDiscountPolicy: (v) => guard((c) => api.setDiscountPolicy(c, venue.id, v)),
    saveBranding: (b) => guard((c) => api.setBranding(c, venue.id, b)),
    saveFiscal: (cfg) => guard((c) => api.setFiscalConfig(c, venue.id, cfg), "Printer settings saved"),
    uploadLogo: async (file) => {
      const ok = await guard((c) => api.uploadLogo(c, venue.id, file));
      if (ok) setLogoStamp(Date.now());
      return ok;
    },
    removeLogo: () => guard(async (c) => {
      await api.removeLogo(c, venue.id, venue.logoPath);
      setLogoStamp(Date.now());
    }),
  }), [guard, client, venue, flash]);

  /* ---- orders: these are the writes that must survive a dead connection ---- */

  const commitOrder = async (lines, guests) => {
    setSheetBusy(true);
    const orderId = openOrder?.id || crypto.randomUUID();
    const payload = {
      orderId, barId: venue.id, tableId: table.id, tableLabel: table.label,
      guests, lines, staffId: openOrder?.staffId || session.actorId,
      staffName: openOrder?.staffName || session.actorName,
      openedAt: openOrder?.openedAt || Date.now(),
    };
    try {
      const res = await write("order.save", payload, (c) =>
        api.saveOrder(c, {
          orderId, barId: venue.id, table, guests, lines,
          staff: { id: payload.staffId, name: payload.staffName },
          openedAt: payload.openedAt,
        })
      );
      setOpenTableId(null);
      flash(res === "queued"
        ? `Table ${table.label} saved on this device — will sync`
        : `Table ${table.label} saved`);
    } catch (e) { flash(e.message); }
    finally { setSheetBusy(false); }
  };

  const settleOrder = async (method, paid, discount) => {
    if (!openOrder) return flash("Save the order before closing it.");
    setSheetBusy(true);
    const billId = crypto.randomUUID();
    const total = round2(openOrder.lines.reduce((a, l) => a + l.price * l.qty, 0) * (1 - (discount || 0) / 100));
    try {
      const res = await write(
        "order.close",
        { orderId: openOrder.id, billId, method, paid, discount },
        (c) => api.closeBill(c, { orderId: openOrder.id, billId, method, paid, discount })
      );
      setOpenTableId(null);
      const tail = res === "queued" ? " (will sync)" : "";
      flash(paid
        ? `Table ${table.label} paid — ${money(total, venue.currency)}${tail}`
        : `Table ${table.label} closed unpaid${tail}`);

      // A cash sale needs its fiscal receipt now, not later. Fire it once the
      // bill exists server-side; a queued bill gets its receipt when it syncs.
      if (paid && res !== "queued" && venue.fiscalEnabled && venue.fiscalBridgeUrl) {
        printFiscal(billId);
      }
    } catch (e) { flash(e.message); }
    finally { setSheetBusy(false); }
  };

  /* ---- the fiscal printer ---- */

  /* The bill id is generated on the client when the bill closes, so it is
     already the idempotency key the printer needs — no lookup required. */
  const printFiscal = useCallback(async (billId) => {
    if (!client || !venue?.fiscalBridgeUrl || !billId) return;
    try {
      const payload = await api.fiscalPayload(client, billId);
      const r = await fiscal.printReceipt(venue.fiscalBridgeUrl, payload, venue.fiscalBridgeToken);
      await api.markFiscalised(client, billId, r.receiptNo, r.device, r);
      flash(r.duplicate ? `Receipt ${r.receiptNo} (already printed)` : `Receipt ${r.receiptNo} printed`);
      return true;
    } catch (e) {
      flash(`Printer: ${e.message}`);
      // Recorded so the owner sees an unfiscalised bill rather than nothing.
      try { await api.markFiscalFailed(client, billId, e.message); } catch { /* already flashed */ }
      return false;
    }
  }, [client, venue, flash]);

  const testPrinter = useCallback(async (cfg) => {
    try {
      const st = await fiscal.printerStatus(cfg.url, cfg.token);
      return st;
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }, []);

  /* Anything paid but unprinted — a jam, or the bar was offline. */
  const retryFiscal = useCallback(async () => {
    if (!client || !venue) return;
    try {
      const stuck = await api.loadFiscalProblems(client, venue.id);
      let done = 0;
      for (const b of stuck) {
        // Sequential on purpose: one printer, one queue.
        if (await printFiscal(b.id)) done++; else break;
      }
      flash(done ? `${done} receipt${done > 1 ? "s" : ""} printed` : "Printer still unreachable");
      loadReports();
    } catch (e) { flash(e.message); }
  }, [client, venue, printFiscal, flash]);

  /* ---- owner reports ---- */
  const [mode, setMode] = useState("day");
  const [anchor, setAnchor] = useState(() => new Date());
  const [report, setReport] = useState(null);
  const [unpaid, setUnpaid] = useState([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const range = useMemo(() => periodRange(mode, anchor), [mode, anchor]);

  const loadReports = useCallback(async () => {
    if (!client || !venue || session?.role !== "owner") return;
    setReportLoading(true); setProductsLoading(true);
    try {
      const [rep, un, prod] = await Promise.all([
        api.loadReport(client, venue.id, range.from, range.to, mode === "day" ? "hour" : "day"),
        api.loadUnpaidBills(client, venue.id),
        api.loadProductsSold(client, venue.id, range.from, range.to),
      ]);
      setReport(rep);
      setUnpaid(un);
      setProducts(prod || []);
    } catch (e) { flash(e.message); }
    finally { setReportLoading(false); setProductsLoading(false); }
  }, [client, venue, session, range.from, range.to, mode, flash]);

  useEffect(() => {
    if (tab === "reports") loadReports();
  }, [tab, loadReports]);

  const settleUnpaid = async (billId, method) => {
    try {
      await api.settleBill(client, billId, method);
      await loadReports();
      flash("Bill marked as paid");
    } catch (e) { flash(e.message); }
  };

  /* CSV for the accountant. Built from line-level rows, not the summary — an
     accountant needs to see the VAT rate on each line, not a total. */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const rows = await api.loadReportRows(client, venue.id, range.from, range.to);
      if (!rows.length) { flash("Nothing to export in this period"); return; }

      const cols = ["day", "closed_at", "table_label", "staff", "method",
                    "item", "category", "qty", "unit_price", "vat_rate",
                    "line_total", "receipt_no"];
      const esc = (v) => {
        const t = v == null ? "" : String(v);
        return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      // Semicolons: Excel in this region splits on ; not , by default.
      const csv = [cols.join(";"), ...rows.map((r) => cols.map((c) => esc(r[c])).join(";"))].join("\r\n");

      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${venue.name.replace(/\s+/g, "-")}-${range.from}-to-${range.to}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      flash(`${rows.length} lines exported`);
    } catch (e) { flash(e.message); }
    finally { setExporting(false); }
  };

  /* ---- platform dashboard ---- */
  const [bars, setBars] = useState([]);
  const [todayByBar, setTodayByBar] = useState({});
  const [barsLoading, setBarsLoading] = useState(false);

  const loadPlatform = useCallback(async () => {
    if (session?.role !== "platform") return;
    setBarsLoading(true);
    try {
      const since = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
      const [list, totals] = await Promise.all([api.listBars(), api.platformDaySummary(since)]);
      setBars(list); setTodayByBar(totals);
    } catch (e) { flash(e.message); }
    finally { setBarsLoading(false); }
  }, [session, flash]);

  useEffect(() => { loadPlatform(); }, [loadPlatform]);

  const platformActions = useMemo(() => {
    const run = async (fn, msg) => {
      try { const r = await fn(); await loadPlatform(); if (msg) flash(msg); return r; }
      catch (e) { flash(e.message); return null; }
    };
    return {
      createBar: (d) => run(() => api.createBar({
        name: d.name, address: d.address, currency: d.currency,
        ownerName: d.ownerName, ownerPin: d.ownerPin,
        plan: d.plan, trialDays: Number(d.trialDays) || 0,
      })),
      recordPayment: (v) => run(() => api.recordPayment(v.id), `${v.name} marked paid`),
      resetOwnerPin: (v) => run(() => api.resetOwnerPin(v.id)),
      deletePreview: (v) => api.barDeletePreview(v.id).catch((e) => { flash(e.message); return null; }),
      deleteBar: (v, confirm) => run(() => api.deleteBar(v.id, confirm, v.logoPath), `${v.name} deleted`),
      toggleSuspend: (v) => run(
        () => api.setSuspended(v.id, !v.subscription.suspended),
        v.subscription.suspended ? `${v.name} reactivated` : `${v.name} suspended — nobody there can sign in`
      ),
      changePlan: (v, plan) => run(() => api.setPlan(v.id, plan)),
      regenerateCode: (v) => run(async () => {
        const code = await api.regenerateBarCode(v.id);
        flash(`${v.name} now uses bar code ${code}`);
      }),
    };
  }, [loadPlatform, flash]);

  /* ---- render ---- */

  if (configError) {
    return (
      <div style={{ minHeight: "100vh", background: C.ink, display: "grid", placeItems: "center", padding: 26, fontFamily: SANS }}>
        <div style={{ maxWidth: 400, textAlign: "center" }}>
          <AlertTriangle size={26} color={C.copper} style={{ marginBottom: 14 }} />
          <div style={{ fontSize: 16, fontWeight: 700, color: C.cream }}>Not configured yet</div>
          <div style={{ fontSize: 13, color: C.sage, marginTop: 8, lineHeight: 1.6 }}>{configError}</div>
          <div style={{ fontSize: 12.5, color: C.sageDim, marginTop: 14, lineHeight: 1.65, textAlign: "left", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 11, padding: 14 }}>
            These are <strong style={{ color: C.cream }}>build</strong> variables, not Worker secrets.
            In Cloudflare open the Worker → Settings → Build → Variables and secrets,
            add <code style={{ color: C.brass }}>VITE_SUPABASE_URL</code> and{" "}
            <code style={{ color: C.brass }}>VITE_SUPABASE_ANON_KEY</code>, then run the build again.
          </div>
        </div>
      </div>
    );
  }

  if (booting) return <Splash text="Starting up…" />;

  if (!session) {
    return (
      <AuthScreen
        platformName="Backbar"
        pairedVenue={paired ? { ...paired, logoUrl: paired.logoPath
          ? `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/logos/${paired.logoPath}` : null } : null}
        busy={authBusy}
        onPair={doPair}
        onUnpair={() => { clearPairing(); setPaired(null); }}
        onPin={doPin}
        onPlatform={doPlatform}
        error={loginError}
        clearError={() => setLoginError("")}
      />
    );
  }

  const isPlatform = session.role === "platform";
  const isOwner = session.role === "owner";
  const isWaiter = session.role === "waiter";

  if (!isPlatform && loading && !data) return <Splash />;

  if (!isPlatform && dataError && !data && online) {
    return (
      <Blocked
        message={dataError}
        onBack={() => { clearStaffSession(); setSession(null); clearError(); }}
      />
    );
  }

  if (!isPlatform && (!venue || !zone)) return <Splash />;

  const tabs = isPlatform
    ? [["bars", "Bars & billing", Store]]
    : isOwner && !serving
    ? [["floor", "Floor", LayoutGrid], ["design", "Floor designer", Copy], ["menu", "Price list", ListOrdered], ["reports", "Money", BarChart3], ["team", "Team", Users], ["brand", "Branding", Palette]]
    : [["floor", "Floor", LayoutGrid]];
  const currentTab = tabs.some((t) => t[0] === tab) ? tab : tabs[0][0];

  const openHere = Object.values(orders);
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

      <InstallBar prompt={installPrompt} />

      {session.support && (
        <div style={{ background: `${C.a12}`, borderBottom: `1px solid ${C.brassDim}`, padding: "8px 18px", display: "flex", alignItems: "center", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <ShieldCheck size={14} color={C.brass} />
          <span style={{ fontSize: 12.5, color: C.brass }}>Support session — inside {venue.name} as the owner.</span>
          <Btn size="sm" icon={ArrowLeft} onClick={doSignOut}>Back to your dashboard</Btn>
        </div>
      )}

      {isOwner && st === "past_due" && (
        <div style={{ background: "rgba(212,103,74,0.12)", borderBottom: "1px solid rgba(212,103,74,0.4)", padding: "9px 18px", display: "flex", alignItems: "center", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <AlertTriangle size={14} color={C.copper} />
          <span style={{ fontSize: 12.5, color: C.copper }}>
            Payment was due {shortDate(venue.subscription.nextDueAt)}. The app stops in {(venue.subscription.graceDays ?? 7) - daysBetween(now, venue.subscription.nextDueAt)} days.
          </span>
        </div>
      )}

      <header style={{ position: "sticky", top: 0, zIndex: 60, background: "rgba(10,20,17,0.92)", backdropFilter: "blur(10px)", borderBottom: `1px solid ${C.line}` }}>
        <div style={{ maxWidth: 1320, margin: "0 auto", padding: "11px 18px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginRight: "auto" }}>
            <Mark logoUrl={venue?.logoUrl} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 14, letterSpacing: "0.14em", color: C.cream,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>
                {isPlatform ? "BACKBAR" : (venue?.name || "").toUpperCase()}
              </div>
              <div style={{ fontSize: 10.5, color: C.sageDim, letterSpacing: "0.1em" }}>
                {isPlatform ? "PLATFORM DASHBOARD" : "POWERED BY BACKBAR"}
              </div>
            </div>
          </div>

          {!isPlatform && openHere.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 99, border: `1px solid ${C.brassDim}`, background: C.a07 }}>
              <Clock size={13} color={C.brass} />
              <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.brass }}>
                {isWaiter ? `${myOpen.length} of ${openHere.length} tables yours` : `${openHere.length} open · ${money(openValue, venue.currency)}`}
              </span>
            </div>
          )}

          {!isPlatform && !online && (
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 12px", borderRadius: 99, border: "1px solid rgba(212,103,74,0.45)", background: "rgba(212,103,74,0.1)" }}>
              <WifiOff size={13} color={C.copper} />
              <span style={{ fontSize: 12, color: C.copper, fontWeight: 600 }}>Offline</span>
            </div>
          )}
          {!isPlatform && pendingCount > 0 && (
            <button onClick={sync} title="Send now" style={{
              display: "flex", alignItems: "center", gap: 7, padding: "6px 12px", borderRadius: 99,
              border: `1px solid ${C.brassDim}`, background: `${C.a07}`, cursor: "pointer",
            }}>
              <RefreshCw size={13} color={C.brass} className={syncing ? "animate-spin" : ""} />
              <span style={{ fontFamily: MONO, fontSize: 12, color: C.brass }}>
                {pendingCount} to sync
              </span>
            </button>
          )}
          {!isPlatform && loading && <Loader2 size={14} color={C.sageDim} className="animate-spin" />}

          {isOwner && (
            <button
              onClick={() => { setServing(!serving); setTab("floor"); }}
              title={serving ? "Back to running the bar" : "Work the floor without the admin tabs"}
              style={{
                display: "flex", alignItems: "center", gap: 7, padding: "7px 13px", borderRadius: 99,
                cursor: "pointer", whiteSpace: "nowrap",
                border: `1px solid ${serving ? C.brass : C.line}`,
                background: serving ? C.a12 : "transparent",
                color: serving ? C.brass : C.sage,
                fontFamily: SANS, fontSize: 12.5, fontWeight: 600,
              }}
            >
              {serving ? <LayoutList size={14} /> : <Martini size={14} />}
              {serving ? "Manage" : "Serve"}
            </button>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 6px 5px 11px", borderRadius: 10, background: C.raise, border: `1px solid ${C.line}` }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.cream, lineHeight: 1.2 }}>{session.actorName}</div>
              <div style={{ fontSize: 10, color: serving ? C.brass : C.sageDim, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                {isPlatform ? "You" : isOwner ? (serving ? "Serving" : "Bar owner") : "Waiter"}
              </div>
            </div>
            <Btn size="sm" variant="bare" icon={LogOut} title="Sign out" onClick={doSignOut} />
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
            venues={bars} todayByBar={todayByBar} now={now} loading={barsLoading}
            flash={flash} actions={platformActions}
            openAsOwner={() => flash("Sign in with the bar's own code and PIN to view their floor.")}
          />
        )}

        {!isPlatform && currentTab === "floor" && (
          <div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
              {zones.map((z) => {
                const n = z.tables.filter((t) => ordersByTable[`${venue.id}/${t.id}`]).length;
                return (
                  <button key={z.id} onClick={() => setZoneId(z.id)} style={{
                    padding: "8px 14px", borderRadius: 10, border: `1px solid ${z.id === zone.id ? C.brass : C.line}`,
                    background: z.id === zone.id ? `${C.a10}` : "transparent",
                    color: z.id === zone.id ? C.brass : C.sage, fontFamily: SANS, fontWeight: 600, fontSize: 13,
                    cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
                  }}>
                    {z.name}
                    {n > 0 && <span style={{ fontFamily: MONO, fontSize: 10.5, background: C.brass, color: C.onBrass, borderRadius: 99, padding: "1px 6px" }}>{n}</span>}
                  </button>
                );
              })}
              <span style={{ marginLeft: "auto", fontFamily: SANS, fontSize: 12, color: C.sageDim }}>Tap a table to take the order</span>
            </div>

            {zone.tables.length === 0 ? (
              <div style={{ background: C.panel, border: `1px dashed ${C.line2}`, borderRadius: 16, padding: 40, textAlign: "center" }}>
                <div style={{ fontFamily: SANS, fontSize: 14, color: C.cream }}>This room has no tables yet.</div>
                <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, marginTop: 6 }}>
                  {isOwner ? "Open the Floor designer to lay it out." : "Ask the owner to lay out the floor."}
                </div>
                {isOwner && <Btn variant="solid" style={{ marginTop: 16 }} icon={Copy} onClick={() => setTab("design")}>Floor designer</Btn>}
              </div>
            ) : (
              <FloorPlan zone={zone} orders={ordersByTable} venueId={venue.id} mode="service" selectedId={null}
                onSelect={setOpenTableId} onMove={() => {}} currency={venue.currency} now={now} />
            )}

            {openHere.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <Eyebrow style={{ marginBottom: 10 }}>Open bills</Eyebrow>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(190px,1fr))", gap: 10 }}>
                  {openHere.slice().sort((a, b) => a.openedAt - b.openedAt).map((o) => {
                    const tot = o.lines.reduce((s, l) => s + l.price * l.qty, 0);
                    const stale = now - o.openedAt > 75 * 60000;
                    const mine = o.staffId === session.actorId;
                    const z = zones.find((zz) => zz.tables.some((t) => t.id === o.tableId));
                    return (
                      <button key={o.id} onClick={() => { if (z) setZoneId(z.id); setOpenTableId(o.tableId); }} style={{
                        textAlign: "left", background: C.panel,
                        border: `1px solid ${stale ? "rgba(212,103,74,0.4)" : mine && isWaiter ? C.brassDim : C.line}`,
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
                        {o.pending && (
                          <div style={{ fontFamily: SANS, fontSize: 10.5, color: C.brass, marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
                            <RefreshCw size={10} /> saved on this device
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {isOwner && currentTab === "design" && (
          <Designer venue={venue} zones={zones} zoneId={zone.id} setZoneId={setZoneId}
            orders={ordersByTable} now={now} flash={flash} actions={barActions} />
        )}
        {isOwner && currentTab === "menu" && (
          <PriceList articles={articles} currency={venue.currency} actions={barActions} />
        )}
        {isOwner && currentTab === "reports" && (
          <Reports
            venue={venue} report={report} loading={reportLoading}
            products={products} productsLoading={productsLoading}
            mode={mode} setMode={setMode} anchor={anchor} setAnchor={setAnchor}
            unpaid={unpaid} onSettleUnpaid={settleUnpaid}
            onExport={exportCsv} exporting={exporting}
            actions={barActions} onTestPrinter={testPrinter} onRetryFiscal={retryFiscal}
          />
        )}
        {isOwner && currentTab === "team" && (
          <Team venue={venue} staff={data.staff || []} flash={flash} actions={barActions} />
        )}
        {isOwner && currentTab === "brand" && (
          <Branding venue={venue} flash={flash} actions={barActions} />
        )}
      </main>

      {table && venue && (
        <OrderSheet
          table={table} zone={zone} venue={venue} order={openOrder} articles={articles} now={now}
          actorName={session.actorName}
          canSeeCost={isOwner}
          canDiscount={isOwner || venue.allowStaffDiscount}
          busy={sheetBusy}
          onClose={() => setOpenTableId(null)}
          onCommit={commitOrder}
          onSettle={settleOrder}
        />
      )}

      <UpdateChip />

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
