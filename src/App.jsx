import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  LayoutGrid, Store, BarChart3, Plus, Minus, Trash2, X, Check, Circle, Square,
  RectangleHorizontal, Users, Clock, CreditCard, Banknote, Search, ChevronRight,
  Copy, Save, Receipt, RotateCw, Loader2, Wine, ListOrdered, LogOut, Delete,
  ChevronLeft, Palette, ImageIcon, Printer, Martini, LayoutList, CalendarClock,
  Package, TruckIcon, ClipboardCheck, MoveRight, ShoppingBag, Share2,
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
import { useBackLayer, useExitGuard } from "./lib/useBackButton";
import { t, setLang, recallLang, LANGUAGES } from "./lib/i18n";
import {
  DAY, round2, clamp, CURRENCIES, curOf, amount, money, failedValue, since, shortDate,
  daysBetween, subState, canOperate, startOfWeek, iso, periodRange, periodLabel,
  stepAnchor,
} from "./lib/format";
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

const PLANS = {
  starter: { id: "starter", name: "Starter", price: 29, maxRooms: 1, maxTables: 16, maxStaff: 3 },
  pro: { id: "pro", name: "Pro", price: 59, maxRooms: 5, maxTables: 60, maxStaff: 15 },
  chain: { id: "chain", name: "Chain", price: 119, maxRooms: 20, maxTables: 400, maxStaff: 100 },
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

const STATE_META = {
  active: { label: "Paid", color: C.mint },
  trial: { label: "Trial", color: C.mint },
  past_due: { label: "Payment due", color: C.brass },
  locked: { label: "Locked — unpaid", color: C.copper },
  suspended: { label: "Suspended", color: C.copper },
};
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
  // Rendered only while open, so mounting is opening. Back closes it.
  useBackLayer(true, onClose);
  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, zIndex: 130, background: "rgba(4,10,8,0.74)",
        backdropFilter: "blur(6px)", display: "grid", placeItems: "center", overflowY: "auto",
        /* A fixed element positions against the viewport, so it escapes the
           safe-area padding on #root. With viewport-fit=cover that viewport
           runs under the notch and the home indicator. */
        padding: "calc(16px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right))" +
                 " calc(16px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left))" }}
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
      <button onClick={onClear} style={{ ...cell, color: C.sageDim, fontSize: 12, fontFamily: SANS, fontWeight: 700 }}>{t("CLEAR")}</button>
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
    mode === "platform" ? { title: t("Platform sign-in"), sub: t("The account that runs the whole network") }
    : mode === "pair" ? { title: t("Set up this device"), sub: t("Enter the bar's code — you only do this once") }
    : { title: pairedVenue.name, sub: t("Enter your PIN to open the floor") };

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
            <button onClick={() => { onUnpair(); go("pair"); }} style={linkBtn}>{t("Not this bar?")}</button>
          )}
          {mode !== "platform" && <button onClick={() => go("platform")} style={linkBtn}>I run {platformName}</button>}
          {mode === "platform" && <button onClick={() => go(pairedVenue ? "pin" : "pair")} style={linkBtn}>Back</button>}
        </div>

        <UpdateChip />
        <button onClick={() => setHint(!hint)} style={{ ...linkBtn, width: "100%", marginTop: 14 }}>
          {hint ? "Hide" : t("Where do I get a code?")}
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

function TableNode({ table, scale, order, selected, onPointerDown, onClick, mode, currency, now, showMoney, nodeRef }) {
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
      ref={nodeRef}
      onPointerDown={onPointerDown} onClick={onClick}
      style={{
        position: "absolute", left: `${(table.x / PLAN_W) * 100}%`, top: `${(table.y / PLAN_H) * 100}%`,
        // Dragging writes straight to this element's style; keeping it on its
        // own layer stops the browser repainting the whole floor each frame.
        willChange: mode === "design" ? "left, top" : "auto",
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

function FloorPlan({ zone, orders, venueId, mode, selectedId, onSelect, onMove, currency, now }) {
  const ref = useRef(null);
  const w = useWidth(ref);
  const scale = w ? w / PLAN_W : 0;
  const drag = useRef(null);

  const toPlan = useCallback((cx, cy) => {
    const r = ref.current.getBoundingClientRect();
    return { x: ((cx - r.left) / r.width) * PLAN_W, y: ((cy - r.top) / r.height) * PLAN_H };
  }, []);

  /* Dragging used to call setState on every pointermove, so the whole floor —
     every table, its glow, its label — re-rendered sixty times a second. On a
     phone that lags; on a tablet the events queue up and the table appears not
     to move at all.

     Now the drag writes position straight onto the element's style and React
     is told once, on release. The plan's rectangle is measured on pointerdown
     rather than every frame, because getBoundingClientRect forces a reflow. */
  const nodes = useRef({});
  const planRect = useRef(null);

  const fromRect = (r, cx, cy) => ({
    x: ((cx - r.left) / r.width) * PLAN_W,
    y: ((cy - r.top) / r.height) * PLAN_H,
  });

  const down = (e, t) => {
    if (mode !== "design") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    planRect.current = ref.current.getBoundingClientRect();
    const p = fromRect(planRect.current, e.clientX, e.clientY);
    drag.current = { id: t.id, dx: p.x - t.x, dy: p.y - t.y, x: t.x, y: t.y, w: t.w, h: t.h, moved: false };
    onSelect(t.id);
  };

  const move = (e) => {
    const d = drag.current;
    if (!d || !planRect.current) return;
    const p = fromRect(planRect.current, e.clientX, e.clientY);
    const x = clamp(Math.round((p.x - d.dx) / 5) * 5, d.w / 2, PLAN_W - d.w / 2);
    const y = clamp(Math.round((p.y - d.dy) / 5) * 5, d.h / 2, PLAN_H - d.h / 2);
    if (x === d.x && y === d.y) return;      // nothing changed; don't touch the DOM
    d.x = x; d.y = y; d.moved = true;

    const node = nodes.current[d.id];
    if (node) {
      node.style.left = `${(x / PLAN_W) * 100}%`;
      node.style.top = `${(y / PLAN_H) * 100}%`;
    }
  };

  const up = () => {
    const d = drag.current;
    drag.current = null;
    planRect.current = null;
    if (!d) return;
    // One state update, at the end, with the final position.
    if (d.moved) onMove(d.id, d.x, d.y);
  };

  return (
    <div
      ref={ref} onPointerMove={move}
      onPointerUp={up} onPointerCancel={up}
      onClick={(e) => e.target === e.currentTarget && mode === "design" && onSelect(null)}
      style={{
        position: "relative", width: "100%", aspectRatio: `${PLAN_W} / ${PLAN_H}`,
        background: `radial-gradient(120% 90% at 50% 0%, ${C.a05}, rgba(0,0,0,0) 55%), linear-gradient(180deg, #0C1815, #08110E)`,
        borderRadius: 16, border: `1px solid ${C.line}`, overflow: "hidden", userSelect: "none",
        touchAction: mode === "design" ? "none" : "auto",
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
          nodeRef={(el) => { nodes.current[t.id] = el; }}
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

function OrderSheet({ table, zone, venue, order, articles, onClose, onCommit, onSettle, onPayPart, onVoid, onMove, now, canSeeCost, canDiscount, actorName, busy, startOn = "menu", syncToken = 0 }) {
  const [lines, setLines] = useState(order ? order.lines.map((l) => ({ ...l })) : []);
  const [guests, setGuests] = useState(order ? order.guests : table.seats || 2);
  const [cat, setCat] = useState("All");
  const [q, setQ] = useState("");
  const [paying, setPaying] = useState(false);
  const [discount, setDiscount] = useState(0);
  // Part cash, part card is ordinary in a bar. Null means a single tender.
  const [split, setSplit] = useState(null);      // { cash, card }
  const [partial, setPartial] = useState(false); // one guest settling early
  const [voiding, setVoiding] = useState(null);  // { line, qty } awaiting a reason

  const [customer, setCustomer] = useState(null); // { taxId, name }
  const narrow = useNarrow();
  /* Where the sheet lands depends on why it was opened. Tapping a table means
     "I'm taking an order" — show the menu. Tapping an open bill means "they
     want to pay" — show the bill. Same sheet, different intent. */
  const [showBill, setShowBill] = useState(startOn === "bill");

  /* Back steps out of the sheet one layer at a time: the item picker, then the
     payment step, then the bill, then the sheet itself.

     These sit below every value they read — the first argument of a hook call
     is evaluated during render, so `narrow` and `showBill` must already exist. */
  useBackLayer(true, onClose);
  useBackLayer(narrow && showBill, () => setShowBill(false));
  useBackLayer(paying, () => setPaying(false));
  useBackLayer(partial, () => setPartial(false));

  /* Re-read the table after part of it has been paid. Deliberately driven by an
     explicit signal rather than by watching `order`: a realtime update from
     another device would otherwise wipe drinks this waiter has typed but not
     yet saved. */
  useEffect(() => {
    if (!syncToken) return;
    setLines((order?.lines || []).map((l) => ({ ...l })));
    setPartial(false);
    setPaying(false);
  }, [syncToken]);   // eslint-disable-line react-hooks/exhaustive-deps

  const cats = useMemo(() => ["All", ...Array.from(new Set(articles.map((a) => a.category)))], [articles]);
  const shown = useMemo(() => articles.filter((a) =>
    a.active !== false && (cat === "All" || a.category === cat) && (!q || a.name.toLowerCase().includes(q.toLowerCase()))
  ), [articles, cat, q]);

  /* Anything typed since the last save isn't on the table yet, which matters
     for splitting — the server acts on saved rows. */
  const dirty = useMemo(() => {
    const a = (order?.lines || []).map((l) => `${l.articleId}:${l.qty}`).sort().join("|");
    const b = lines.map((l) => `${l.articleId}:${l.qty}`).sort().join("|");
    return a !== b;
  }, [order, lines]);

  const gross = round2(lines.reduce((s, l) => s + l.price * l.qty, 0));
  const disc = round2((gross * discount) / 100);
  const total = round2(gross - disc);
  const cost = round2(lines.reduce((s, l) => s + l.cost * l.qty, 0));

  const add = (a) => setLines((prev) => {
    const i = prev.findIndex((l) => l.articleId === a.id);
    if (i >= 0) { const n = [...prev]; n[i] = { ...n[i], qty: n[i].qty + 1 }; return n; }
    return [...prev, { articleId: a.id, name: a.name, category: a.category, price: a.price, cost: a.cost, qty: 1 }];
  });
  /* Is this line already saved to the table? If so it is accountable: taking it
     off needs a reason. Anything typed since the last save is just typing. */
  const savedQty = (articleId) =>
    (order?.lines || []).find((l) => l.articleId === articleId)?.qty || 0;

  const bump = (id, d) => {
    const line = lines.find((l) => l.articleId === id);
    if (!line) return;
    // Going below what the table already has is a removal, not an edit.
    if (d < 0 && savedQty(id) > 0 && line.qty <= savedQty(id)) {
      setVoiding({ line, qty: 1 });
      return;
    }
    setLines((prev) => prev.map((l) => (l.articleId === id ? { ...l, qty: l.qty + d } : l)).filter((l) => l.qty > 0));
  };

  const remove = (id) => {
    const line = lines.find((l) => l.articleId === id);
    if (!line) return;
    const saved = savedQty(id);
    if (saved > 0) { setVoiding({ line, qty: Math.min(line.qty, saved) }); return; }
    setLines((prev) => prev.filter((l) => l.articleId !== id));
  };

  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(4,10,8,0.72)",
        backdropFilter: "blur(6px)", display: "flex",
        padding: narrow ? 0 : "calc(24px + env(safe-area-inset-top)) 24px calc(24px + env(safe-area-inset-bottom))" }}
    >
      {voiding && (
        <VoidReason
          line={voiding.line} qty={voiding.qty} cur={venue.currency} busy={busy}
          onCancel={() => setVoiding(null)}
          onConfirm={async (reason, kind, consumed) => {
            const ok = await onVoid(voiding.line, voiding.qty, reason, kind, consumed);
            if (ok) setVoiding(null);
          }}
        />
      )}

      <div style={{
        width: "100%", maxWidth: narrow ? "100%" : 1080, margin: narrow ? 0 : "auto",
        /* A definite height, always. With `undefined` the sheet was sized by the
           catalog, so a long menu pushed the receipt's pay buttons off-screen. */
        height: narrow ? "100%" : "min(760px, calc(100vh - 48px))",
        maxHeight: "100%",
        display: "flex", flexDirection: "column", background: C.panel,
        border: narrow ? "none" : `1px solid ${C.line}`,
        borderRadius: narrow ? 0 : 18, overflow: "hidden",
      }}>
        {/* The sheet is flush to the top on a phone, so this header sits under
            the status bar unless it carries the inset itself. */}
        <div style={{ display: "flex", alignItems: "center", gap: narrow ? 8 : 14,
          padding: narrow
            ? "calc(12px + env(safe-area-inset-top)) 12px 12px"
            : "14px 16px",
          borderBottom: `1px solid ${C.line}`, flexShrink: 0 }}>
          <div style={{ width: 44, height: 44, borderRadius: 11, border: `1.5px solid ${C.brass}`, display: "grid", placeItems: "center", fontFamily: MONO, fontWeight: 700, color: C.brass, fontSize: 16, flexShrink: 0 }}>
            {table.label}
          </div>
          {/* Both lines clip rather than wrap. With five controls to its right
              this column gets narrow, and a wrapping title pushed the header to
              five lines on a phone. */}
          {/* The badge already says which table it is, so on a phone the words
              "Table 2" only steal room from the context that isn't shown
              anywhere else. Both lines clip rather than wrap — five controls sit
              to the right and a wrapping title made the header five rows tall. */}
          <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
            {!narrow && (
              <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 15,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {t("Table")} {table.label}
              </div>
            )}
            <div style={{ fontFamily: SANS, fontSize: narrow ? 13 : 12,
              fontWeight: narrow ? 600 : 400, color: narrow ? C.cream : C.sageDim,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {zone.name}
            </div>
            <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {order ? `${since(order.openedAt, now)} · ${order.staffName}` : `${t("new bill")} · ${actorName}`}
            </div>
          </div>
          {/* The icon is decoration next to a number that is obviously a headcount,
              and on a phone it costs the room label its last twenty pixels. */}
          <div style={{ display: "flex", alignItems: "center", gap: narrow ? 2 : 6, flexShrink: 0 }}>
            {!narrow && <Users size={14} color={C.sageDim} />}
            <Btn size="sm" variant="bare" onClick={() => setGuests(Math.max(1, guests - 1))} icon={Minus} />
            <span style={{ fontFamily: MONO, color: C.cream, width: 18, textAlign: "center" }}>{guests}</span>
            <Btn size="sm" variant="bare" onClick={() => setGuests(guests + 1)} icon={Plus} />
          </div>
          {/* Shown whenever the table has anything on it. If it hasn't been
              saved yet there is no server order to move, so save first — the
              waiter shouldn't have to know that distinction exists. */}
          {(order || lines.length > 0) && (
            <Btn variant="bare" icon={MoveRight} title="Move or merge this table"
              onClick={async () => {
                if (dirty) { const ok = await onCommit(lines, guests, false); if (!ok) return; }
                onMove();
              }} />
          )}
          <Btn variant="bare" icon={X} onClick={onClose} />
        </div>

        {/* nowrap, always. With flex-wrap:wrap the line is free to grow taller
            than this container, so the receipt's footer — TOTAL, Save order,
            Close bill — gets pushed below the sheet and clipped. Measured: the
            footer landed 100px past the viewport on a full menu. The two panes
            already have min-widths and the sheet switches to a single pane
            below 620px, so wrapping was never doing any work. */}
        <div style={{ display: "flex", flex: 1, minHeight: 0, position: "relative", flexWrap: "nowrap" }}>
          <div style={{
            flex: "1 1 340px", minWidth: narrow ? 0 : 280,
            display: narrow && showBill ? "none" : "flex",
            flexDirection: "column", minHeight: 0,
          }}>
            <div style={{ padding: "12px 16px 8px" }}>
              <div style={{ position: "relative" }}>
                <Search size={14} color={C.sageDim} style={{ position: "absolute", left: 11, top: 11 }} />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Find a drink")}
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
              padding: narrow ? "0 16px 96px" : (lines.length ? "0 16px 62px" : "0 16px 16px"),
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
              {!shown.length && <div style={{ color: C.sageDim, fontFamily: SANS, fontSize: 13, gridColumn: "1/-1", padding: 12 }}>{t("Nothing matches. Try another category.")}</div>}
            </div>
          </div>

          {!narrow && lines.length > 0 && (
            <div style={{
              position: "absolute", left: 0, bottom: 0, width: "50%",
              padding: "10px 16px", display: "flex", alignItems: "center", gap: 12,
              background: "rgba(16,29,24,0.94)", backdropFilter: "blur(8px)",
              borderTop: `1px solid ${C.line}`,
            }}>
              <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim }}>
                {lines.reduce((a, l) => a + l.qty, 0)} on this bill
              </span>
              <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 17, color: C.cream }}>
                {money(total, venue.currency)}
              </span>
            </div>
          )}

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
              >{t("Bill")}</Btn>
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
                <ArrowLeft size={15} /> {t("Back to the menu")}
              </button>
            )}
            <div style={{ padding: "14px 18px 6px", flexShrink: 0 }}>
              <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: "0.2em", color: "#8A7F66" }}>{venue.name.toUpperCase()}</div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: "#8A7F66", marginTop: 2 }}>TABLE {table.label} · {guests} GUESTS · {actorName.toUpperCase()}</div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 18px",
              display: partial ? "none" : "block" }}>
              {!lines.length && <div style={{ fontFamily: MONO, fontSize: 12, color: "#9C927A", padding: "20px 0" }}>{t("Nothing ordered yet. Tap a drink to start the bill.")}</div>}
              {lines.map((l) => (
                <div key={l.articleId} style={{ display: "flex", alignItems: "center", gap: 10,
                  padding: "9px 0", borderBottom: "1px dashed rgba(0,0,0,0.13)" }}>
                  {/* Bigger targets: this gets used at speed, with one hand,
                      often by someone holding a tray. */}
                  <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                    <button onClick={() => bump(l.articleId, -1)} aria-label="one less"
                      style={{ border: "1px solid rgba(0,0,0,0.15)", background: "transparent",
                        cursor: "pointer", color: "#4A4335", width: 30, height: 30, borderRadius: 8,
                        display: "grid", placeItems: "center" }}>
                      <Minus size={14} />
                    </button>
                    <span style={{ fontFamily: MONO, fontSize: 14, width: 26, textAlign: "center",
                      color: "#221E15", fontWeight: 600 }}>{l.qty}</span>
                    <button onClick={() => bump(l.articleId, 1)} aria-label="one more"
                      style={{ border: "1px solid rgba(0,0,0,0.15)", background: "transparent",
                        cursor: "pointer", color: "#4A4335", width: 30, height: 30, borderRadius: 8,
                        display: "grid", placeItems: "center" }}>
                      <Plus size={14} />
                    </button>
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: MONO, fontSize: 13, color: "#221E15", overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</div>
                    {l.qty > 1 && (
                      <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#8A7F66", marginTop: 1 }}>
                        {money(l.price, venue.currency)} each
                      </div>
                    )}
                  </div>

                  <div style={{ fontFamily: MONO, fontSize: 13.5, color: "#221E15",
                    fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                    {money(l.price * l.qty, venue.currency)}
                  </div>

                  {/* An explicit remove. Tapping minus until the line vanishes is
                      guesswork, and on a bill of six that is six taps. */}
                  <button onClick={() => remove(l.articleId)} aria-label={`remove ${l.name}`}
                    style={{ border: "none", background: "transparent", cursor: "pointer",
                      color: "#A9998A", width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                      display: "grid", placeItems: "center" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "#B4442A")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "#A9998A")}>
                    <Trash2 size={14} />
                  </button>
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
                <span style={{ fontFamily: MONO, fontSize: 12, letterSpacing: "0.18em", color: "#6B6250" }}>{t("TOTAL")}</span>
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

              {partial ? (
                <SplitByItems
                  /* Server truth, not the sheet's local edits. Splitting acts
                     on rows that exist on the table; anything typed but not
                     saved isn't there yet. */
                  lines={order?.lines || []} cur={venue.currency} busy={busy}
                  onCancel={() => setPartial(false)}
                  onConfirm={(chosen, method) => onPayPart(chosen, method)}
                />
              ) : !paying ? (
                <>
                  <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                    <Btn variant="quiet" disabled={busy} onClick={() => onCommit(lines, guests)} icon={busy ? Loader2 : Save} style={{ flex: 1, background: "#221E15", color: C.cream, borderColor: "#221E15" }}>{t("Save order")}</Btn>
                    <Btn variant="solid" disabled={!lines.length || busy} onClick={() => setPaying(true)} icon={Receipt} style={{ flex: 1 }}>{t("Close bill")}</Btn>
                  </div>
                  {/* Only offered on a saved order: the split happens
                      server-side against lines that exist there. */}
                  {order && lines.length > 0 && (
                    <Btn variant="bare" onClick={async () => {
                      // Unsaved changes aren't on the table yet, and the split
                      // works against the table. Save first, stay open.
                      if (dirty) { const ok = await onCommit(lines, guests, false); if (!ok) return; }
                      setPartial(true);
                    }}
                      style={{ width: "100%", marginTop: 6, color: "#6B6250" }}>
                      {t("Someone\u2019s leaving — pay part")}
                    </Btn>
                  )}
                </>
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
                  <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.16em", color: "#8A7F66", marginBottom: 7 }}>{t("DID THEY PAY?")}</div>

                  {split === null ? (
                    <>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Btn variant="quiet" disabled={busy} icon={Banknote}
                          onClick={() => onSettle("cash", true, discount, null, customer, { lines, guests })}
                          style={{ flex: 1, background: "#221E15", color: C.cream, borderColor: "#221E15" }}>{t("Cash")}</Btn>
                        <Btn variant="solid" disabled={busy} icon={CreditCard}
                          onClick={() => onSettle("card", true, discount, null, customer, { lines, guests })}
                          style={{ flex: 1 }}>{t("Card")}</Btn>
                      </div>
                      <Btn variant="bare" onClick={() => setSplit({ cash: round2(total / 2), card: round2(total - round2(total / 2)) })}
                        style={{ width: "100%", marginTop: 6, color: "#6B6250" }}>
                        {t("Split between cash and card")}
                      </Btn>
                    </>
                  ) : (
                    <SplitTender
                      total={total} cur={venue.currency} split={split} setSplit={setSplit}
                      busy={busy}
                      onCancel={() => setSplit(null)}
                      onConfirm={() => onSettle(null, true, discount,
                        [{ method: "cash", amount: split.cash }, { method: "card", amount: split.card }],
                        customer, { lines, guests })}
                    />
                  )}

                  {/* A business customer needs their tax number on the receipt,
                      or their accountant cannot claim it. */}
                  {customer === null ? (
                    <Btn variant="bare" onClick={() => setCustomer({ taxId: "", name: "" })}
                      style={{ width: "100%", marginTop: 4, color: "#6B6250" }}>
                      Company receipt (ЕДБ)
                    </Btn>
                  ) : (
                    <div style={{ marginTop: 10, padding: 10, borderRadius: 9, background: "rgba(0,0,0,0.05)", border: "1px dashed rgba(0,0,0,0.2)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.16em", color: "#8A7F66" }}>BUYER</span>
                        <button onClick={() => setCustomer(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#6B6250", padding: 0 }}>
                          <X size={14} />
                        </button>
                      </div>
                      <input value={customer.taxId} placeholder="ЕДБ (13 digits)" inputMode="numeric"
                        onChange={(e) => setCustomer({ ...customer, taxId: e.target.value.replace(/\D/g, "").slice(0, 13) })}
                        style={{ width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid rgba(0,0,0,0.2)",
                          background: C.cream, color: "#221E15", fontFamily: MONO, fontSize: 13, outline: "none", marginBottom: 6 }} />
                      <input value={customer.name} placeholder="Company name"
                        onChange={(e) => setCustomer({ ...customer, name: e.target.value })}
                        style={{ width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid rgba(0,0,0,0.2)",
                          background: C.cream, color: "#221E15", fontFamily: SANS, fontSize: 13, outline: "none" }} />
                    </div>
                  )}
                  <Btn variant="ghost" disabled={busy} icon={AlertTriangle} onClick={() => onSettle(null, false, discount, null, null, { lines, guests })}
                    style={{ width: "100%", marginTop: 8, color: "#8A5A2E", borderColor: "rgba(0,0,0,0.2)" }}>
                    {t("Not paid — leave on the tab")}
                  </Btn>
                  <Btn variant="bare" onClick={() => setPaying(false)} style={{ width: "100%", marginTop: 4, color: "#6B6250" }}>{t("Back")}</Btn>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Why something came off the table.

   Kept to one tap for the cases that are almost all of them. Friction here is
   the point — but friction that takes six taps gets worked around, and a
   control staff resent is a control that stops being used honestly. */
/* `consumed` decides whether stock moved. A drink that was poured and then
   spilled came off the shelf; one rung up in error never left the bottle.
   Without this distinction the variance report blames the wrong thing. */
const VOID_REASONS = [
  { reason: "Wrong order",        kind: "void", consumed: false },
  { reason: "Changed their mind", kind: "void", consumed: false },
  { reason: "Spilled or remade",  kind: "void", consumed: true  },
  { reason: "On the house",       kind: "comp", consumed: true  },
  { reason: "Staff drink",        kind: "comp", consumed: true  },
];

function VoidReason({ line, qty, cur, onCancel, onConfirm, busy }) {
  const [other, setOther] = useState("");
  const [otherKind, setOtherKind] = useState("void");

  return (
    <Modal onClose={onCancel} width={360}>
      <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16 }}>
        Taking off {qty > 1 ? `${qty} × ` : ""}{line.name}
      </div>
      <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, marginTop: 4, marginBottom: 14 }}>
        {money(line.price * qty, cur)} · already on the table, so it needs a reason
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {VOID_REASONS.map((r) => (
          <button key={r.reason} disabled={busy}
            onClick={() => onConfirm(r.reason, r.kind, r.consumed)}
            style={{
              display: "flex", alignItems: "center", gap: 10, padding: "12px 14px",
              borderRadius: 11, cursor: busy ? "not-allowed" : "pointer", textAlign: "left",
              border: `1px solid ${r.kind === "comp" ? C.brassDim : C.line}`,
              background: r.kind === "comp" ? C.a08 : C.raise,
              color: C.cream, fontFamily: SANS, fontSize: 13.5, fontWeight: 600,
            }}>
            {r.reason}
            {r.kind === "comp" && (
              <span style={{ marginLeft: "auto", fontFamily: SANS, fontSize: 10.5,
                letterSpacing: "0.12em", color: C.brass }}>GIVEN AWAY</span>
            )}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        <Field label="Or say why" value={other} onChange={setOther} placeholder="…" />
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          {[["void", "Not served"], ["comp", "Given away"]].map(([k, label]) => (
            <button key={k} onClick={() => setOtherKind(k)} style={{
              padding: "6px 11px", borderRadius: 99, cursor: "pointer",
              border: `1px solid ${otherKind === k ? C.brass : C.line}`,
              background: otherKind === k ? C.a10 : "transparent",
              color: otherKind === k ? C.brass : C.sage,
              fontFamily: SANS, fontSize: 12, fontWeight: 600,
            }}>{label}</button>
          ))}
          <Btn variant="solid" size="sm" disabled={busy || !other.trim()}
            style={{ marginLeft: "auto" }}
            onClick={() => onConfirm(other.trim(), otherKind, otherKind === "comp")}>Confirm</Btn>
        </div>
      </div>

      <Btn variant="ghost" style={{ width: "100%", marginTop: 14 }} onClick={onCancel}>
        Keep it on the bill
      </Btn>
    </Modal>
  );
}

/* One guest leaving early. Pick what they had; the rest stays on the table.
   Quantities matter — four people sharing a bottle of wine means one of them
   pays for one of the three glasses, not the whole line. */
function SplitByItems({ lines, cur, onCancel, onConfirm, busy }) {
  const [take, setTake] = useState({});   // articleId -> qty being paid now

  const bump = (id, max, d) =>
    setTake((t) => {
      const next = clamp((t[id] || 0) + d, 0, max);
      const out = { ...t };
      if (next === 0) delete out[id]; else out[id] = next;
      return out;
    });

  const chosen = lines
    .filter((l) => take[l.articleId])
    .map((l) => ({ ...l, qty: take[l.articleId] }));
  const total = round2(chosen.reduce((a, l) => a + l.price * l.qty, 0));
  const rest = round2(lines.reduce((a, l) => a + l.price * l.qty, 0) - total);

  const chip = (on) => ({
    width: 28, height: 28, borderRadius: 8, cursor: "pointer",
    border: `1px solid ${on ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.15)"}`,
    background: "transparent", color: "#4A4335", display: "grid", placeItems: "center",
  });

  return (
    <div>
      <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.16em", color: "#8A7F66", marginBottom: 8 }}>
        {t("WHAT ARE THEY PAYING FOR?")}
      </div>

      <div style={{ maxHeight: 200, overflowY: "auto", marginBottom: 10 }}>
        {lines.map((l) => {
          const n = take[l.articleId] || 0;
          return (
            <div key={l.articleId} style={{ display: "flex", alignItems: "center", gap: 8,
              padding: "7px 0", borderBottom: "1px dashed rgba(0,0,0,0.12)",
              opacity: n ? 1 : 0.55 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <button style={chip(n > 0)} onClick={() => bump(l.articleId, l.qty, -1)}>
                  <Minus size={13} />
                </button>
                <span style={{ fontFamily: MONO, fontSize: 13, width: 34, textAlign: "center",
                  color: n ? "#221E15" : "#9C927A", fontWeight: n ? 600 : 400 }}>
                  {n}/{l.qty}
                </span>
                <button style={chip(n < l.qty)} onClick={() => bump(l.articleId, l.qty, 1)}>
                  <Plus size={13} />
                </button>
              </div>
              <span style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 12.5, color: "#221E15",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</span>
              <span style={{ fontFamily: MONO, fontSize: 12.5, color: n ? "#221E15" : "#9C927A" }}>
                {money(l.price * (n || l.qty), cur)}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
        padding: "8px 0", borderTop: "1px solid rgba(0,0,0,0.15)" }}>
        <span style={{ fontFamily: MONO, fontSize: 11, letterSpacing: "0.14em", color: "#6B6250" }}>
          {t("THIS GUEST")}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: "#1A1608" }}>
          {money(total, cur)}
        </span>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 11.5, color: "#8A7F66" }}>
        {money(rest, cur)} stays on the table
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <Btn variant="bare" onClick={onCancel} style={{ flex: 1, color: "#6B6250" }}>{t("Back")}</Btn>
        <Btn variant="quiet" disabled={busy || !chosen.length} icon={Banknote}
          onClick={() => onConfirm(chosen, "cash")}
          style={{ flex: 1, background: "#221E15", color: C.cream, borderColor: "#221E15" }}>{t("Cash")}</Btn>
        <Btn variant="solid" disabled={busy || !chosen.length} icon={CreditCard}
          onClick={() => onConfirm(chosen, "card")} style={{ flex: 1 }}>{t("Card")}</Btn>
      </div>
    </div>
  );
}

/* Two amounts that must add to the bill. Editing one moves the other, because
   a split that does not reconcile is a drawer that will not reconcile either —
   and the database refuses it anyway. */
function SplitTender({ total, cur, split, setSplit, onCancel, onConfirm, busy }) {
  const setCash = (v) => {
    const cash = clamp(round2(Number(v) || 0), 0, total);
    setSplit({ cash, card: round2(total - cash) });
  };
  const ok = Math.abs(split.cash + split.card - total) < 0.01;

  const box = {
    width: "100%", padding: "9px 10px", borderRadius: 8, textAlign: "right",
    border: "1px solid rgba(0,0,0,0.2)", background: C.cream, color: "#221E15",
    fontFamily: MONO, fontSize: 15, outline: "none",
  };

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.14em", color: "#8A7F66", marginBottom: 4 }}>CASH</div>
          <input type="number" inputMode="decimal" value={split.cash} style={box}
            onChange={(e) => setCash(e.target.value)} />
        </div>
        <div>
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.14em", color: "#8A7F66", marginBottom: 4 }}>CARD</div>
          <input type="number" inputMode="decimal" value={split.card} style={box}
            onChange={(e) => setCash(total - (Number(e.target.value) || 0))} />
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8,
        fontFamily: MONO, fontSize: 11.5, color: ok ? "#6B6250" : C.copper }}>
        <span>of {money(total, cur)}</span>
        <span>{ok ? "adds up" : `off by ${money(Math.abs(split.cash + split.card - total), cur)}`}</span>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <Btn variant="bare" onClick={onCancel} style={{ flex: 1, color: "#6B6250" }}>{t("Back")}</Btn>
        <Btn variant="solid" disabled={busy || !ok} onClick={onConfirm} icon={Receipt} style={{ flex: 2 }}>
          Take {money(split.cash, cur)} cash
        </Btn>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- designer */

function Designer({ venue, zones, zoneId, setZoneId, orders, now, flash, actions }) {
  const [sel, setSel] = useState(null);
  const plan = PLANS[venue.subscription.plan];
  const baseZone = zones.find((z) => z.id === zoneId) || zones[0];
  const zone = baseZone;
  const table = zone.tables.find((t) => t.id === sel);
  const tableCount = zones.reduce((s, z) => s + z.tables.length, 0);

  /* The plan moves the element itself during a drag and reports the final
     position once. There is no in-between state to hold any more, so the
     mid-drag draft map is gone — along with a full re-render per frame. */
  const move = (id, x, y) => {
    actions.moveTable(id, x, y);
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
          onSelect={setSel} onMove={move} currency={venue.currency} now={now} />

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

function PriceList({ articles, currency, actions, ingredients = [] }) {
  const [q, setQ] = useState("");
  const [hover, setHover] = useState(null);
  // A six-column table needs 440px before the name gets any width at all. On a
  // phone that collapses the name to nothing, which is how it disappeared.
  const narrow = useNarrow("(max-width: 620px)");
  const [cat, setCat] = useState("All");
  const [editing, setEditing] = useState(null);
  const [recipe, setRecipe] = useState(null);
  const [recipeBusy, setRecipeBusy] = useState(false);

  /* Fetch the recipe when an existing article is opened. A new one has none
     until it's been saved and has an id to hang ingredients off. */
  useEffect(() => {
    let alive = true;
    if (!editing?.id) { setRecipe(null); return; }
    setRecipeBusy(true);
    actions.loadRecipe(editing.id).then((r) => { if (alive) setRecipe(r); })
      .finally(() => alive && setRecipeBusy(false));
    return () => { alive = false; };
  }, [editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
          {editing.id && (
            <RecipeEditor
              article={editing} ingredients={ingredients} recipe={recipe}
              cur={currency} busy={recipeBusy}
              onChange={async (items) => {
                setRecipeBusy(true);
                const r = await actions.saveRecipe(editing.id, items);
                if (r) { setRecipe(r); setEditing({ ...editing, cost: Number(r.cost) || 0 }); }
                setRecipeBusy(false);
              }}
              onLink={async (pack) => {
                setRecipeBusy(true);
                // The buy price on this form is what one unit costs.
                await actions.linkArticleStock(editing.id, pack, editing.cost);
                const r = await actions.loadRecipe(editing.id);
                if (r) { setRecipe(r); setEditing({ ...editing, cost: Number(r.cost) || editing.cost }); }
                setRecipeBusy(false);
              }}
              onUnlink={async () => {
                setRecipeBusy(true);
                await actions.unlinkArticleStock(editing.id);
                setRecipe(await actions.loadRecipe(editing.id));
                setRecipeBusy(false);
              }}
            />
          )}

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

function Reports({ venue, report, products, productsLoading, loading, mode, setMode, anchor, setAnchor, unpaid, onSettleUnpaid, onExport, exporting, actions, onTestPrinter, onRetryFiscal, onReset, voids,
  drawer, onCash, onDrawer, onX, onZ }) {
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

        <CashCardStat cash={Number(t.cash) || 0} card={Number(t.card) || 0} cur={cur} />

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
                <Btn size="sm" icon={Banknote} onClick={() => onSettleUnpaid(b.id, "cash")}>{t("Cash")}</Btn>
                <Btn size="sm" variant="solid" icon={CreditCard} onClick={() => onSettleUnpaid(b.id, "card")}>{t("Card")}</Btn>
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

      <VoidsCard voids={voids} cur={cur} />

      <DrawerCard drawer={report?.drawer} cur={cur} onCash={onCash} />

      <FiscalPanel venue={venue} actions={actions} onTest={onTestPrinter}
        onRetryAll={onRetryFiscal} stuck={att.noFiscal || 0}
        drawer={drawer} onDrawer={onDrawer} onX={onX} onZ={onZ} />

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, padding: "14px 18px",
        background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: C.cream }}>
            Finished testing?
          </div>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim, marginTop: 3, lineHeight: 1.45 }}>
            Clear practice bills and open with real numbers. Your price list, floor
            plan and team stay exactly as they are.
          </div>
        </div>
        <Btn icon={RotateCw} onClick={onReset}>Start clean</Btn>
      </div>

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

function FiscalPanel({ venue, actions, onTest, onRetryAll, stuck, drawer, onDrawer, onX, onZ }) {
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
        <span style={{ fontFamily: SANS, fontSize: 12,
          color: status?.ok ? C.mint : status ? C.copper : C.sageDim }}>
          {!venue.fiscalEnabled ? "off"
            : !venue.fiscalBridgeUrl ? "on, no address set"
            : status?.ok ? "reachable"
            : status ? "not answering"
            : "on — not tested"}
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
            onChange={(v) => setCfg({ ...cfg, url: v.trim().replace(/\/+$/, "").replace(/\/fiscal.*$/, "") })}
            placeholder="http://192.168.1.50:8377" />
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
            <div style={{ padding: "11px 13px", borderRadius: 9, background: C.ink,
              border: `1px solid ${status.ok ? C.line2 : C.copper}` }}>
              <div style={{ fontFamily: MONO, fontSize: 12, color: status.ok ? C.mint : C.copper }}>
                {status.ok
                  ? `${status.device} · paper ${status.paper} · ${status.printedToday ?? 0} printed`
                  : status.message || status.error}
              </div>
              {!status.ok && (
                <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim, marginTop: 8, lineHeight: 1.55 }}>
                  Open <span style={{ fontFamily: MONO, color: C.sage }}>{cfg.url}/fiscal/status</span> in
                  a browser on this device. JSON means it is reachable and something else is wrong;
                  a sign-in page means the address is not public; nothing at all means the address
                  is wrong or the bridge is not running.
                </div>
              )}
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

          {venue.fiscalEnabled && venue.fiscalBridgeUrl && (
            <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 14, marginTop: 4 }}>
              <Eyebrow style={{ marginBottom: 4 }}>The till</Eyebrow>
              <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim, marginBottom: 10, lineHeight: 1.5 }}>
                X reads the day so far and leaves it open. Z ends the day — only
                run it when you have finished trading.
              </div>

              {drawer && (
                <div style={{ background: C.ink, border: `1px solid ${C.line}`, borderRadius: 10,
                  padding: "10px 12px", marginBottom: 10, fontFamily: MONO, fontSize: 12.5, color: C.sage }}>
                  <Row2 a="cash taken" b={money(Number(drawer.cashSales) || 0, venue.currency)} />
                  <Row2 a="paid in" b={money(Number(drawer.paidIn) || 0, venue.currency)} />
                  <Row2 a="paid out" b={money(Number(drawer.paidOut) || 0, venue.currency)} />
                  <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 6, paddingTop: 6 }}>
                    <Row2 a="should be in the drawer" b={money(Number(drawer.expected) || 0, venue.currency)} />
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Btn icon={Banknote} onClick={onDrawer}>Open drawer</Btn>
                <Btn variant="ghost" icon={BarChart3} onClick={onX}>X report</Btn>
                <Btn variant="danger" icon={CalendarClock} onClick={onZ} style={{ marginLeft: "auto" }}>
                  Close the day (Z)
                </Btn>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* Two amounts of equal standing. The old version put cash in the big slot and
   card in the small print, which reads as a headline and a footnote — badly
   wrong on a night when card takes more than cash, as it usually does. */
function CashCardStat({ cash, card, cur }) {
  const total = cash + card;
  const cashPct = total > 0 ? (cash / total) * 100 : 0;

  /* Label above, amount below, each on its own full-width line.
     Side by side, the label reserved space the amount needed — and with
     nowrap the amount escaped the card instead of shrinking. Nothing here
     forbids wrapping now, so the worst case is two lines inside the box
     rather than text running off the edge. */
  const col = (label, value, dot) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, background: dot, flexShrink: 0 }} />
        <span style={{ fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: "0.14em",
          textTransform: "uppercase", color: C.sageDim }}>{label}</span>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 600, color: C.cream,
        marginTop: 3, letterSpacing: "-0.01em", overflowWrap: "anywhere" }}>
        {money(value, cur)}
      </div>
    </div>
  );

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14,
      padding: "16px 18px", minWidth: 0 }}>
      <Eyebrow>How they paid</Eyebrow>
      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
        {col("Cash", cash, C.brass)}
        {col("Card", card, C.line2)}
      </div>
      {total > 0 && (
        <>
          <div style={{ display: "flex", height: 5, borderRadius: 99, overflow: "hidden",
            marginTop: 12, background: C.raise }}>
            <div style={{ width: `${cashPct}%`, background: C.brass }} />
            <div style={{ flex: 1, background: C.line2 }} />
          </div>
          <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim, marginTop: 6 }}>
            {cashPct.toFixed(0)}% of takings came in cash
          </div>
        </>
      )}
    </div>
  );
}

/* What should physically be in the till right now. Cash taken, plus anything
   paid in, minus anything paid out — the number to count against at close.

   Deliberately not inside the printer panel: a bar with no fiscal printer
   still has a drawer, and this is the figure an owner reconciles against. */
/* What came off tables, and who took it off.

   The per-waiter column is the one an owner studies. A waiter voiding far more
   than the others proves nothing on its own — people get given the difficult
   tables — but it is where to look, and before this existed there was nowhere
   to look at all. */
function VoidsCard({ voids, cur }) {
  const [open, setOpen] = useState(false);
  const v = voids || {};
  const voidValue = Number(v.voidValue) || 0;
  const compValue = Number(v.compValue) || 0;
  const anything = (Number(v.voidCount) || 0) + (Number(v.compCount) || 0) > 0;

  if (!anything) return null;

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, marginTop: 16 }}>
      <button onClick={() => setOpen(!open)} style={{
        width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "14px 18px",
        background: "transparent", border: "none", cursor: "pointer", textAlign: "left", flexWrap: "wrap",
      }}>
        <AlertTriangle size={15} color={C.sageDim} />
        <span style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: C.cream }}>
          Taken off tables
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 14, alignItems: "baseline" }}>
          <span style={{ fontFamily: MONO, fontSize: 14, color: C.cream }}>
            {money(voidValue, cur)}
            <span style={{ fontFamily: SANS, fontSize: 11, color: C.sageDim }}> not served</span>
          </span>
          <span style={{ fontFamily: MONO, fontSize: 14, color: C.brass }}>
            {money(compValue, cur)}
            <span style={{ fontFamily: SANS, fontSize: 11, color: C.sageDim }}> given away</span>
          </span>
        </span>
        <ChevronRight size={16} color={C.sageDim}
          style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 150ms" }} />
      </button>

      {open && (
        <div style={{ padding: "0 18px 18px", display: "grid", gap: 16 }}>
          <div>
            <Eyebrow style={{ marginBottom: 8 }}>By waiter</Eyebrow>
            <SplitList rows={v.byStaff || []} cur={cur} sub={(r) => `${r.qty} items`} />
          </div>
          <div>
            <Eyebrow style={{ marginBottom: 8 }}>Why</Eyebrow>
            <SplitList rows={(v.byReason || []).map((r) => ({ ...r, name: r.reason }))}
              cur={cur} valueKey="value" sub={(r) => `${r.qty}`} />
          </div>
          {(v.recent || []).length > 0 && (
            <div>
              <Eyebrow style={{ marginBottom: 8 }}>Most recent</Eyebrow>
              <div style={{ display: "grid", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                {v.recent.map((r, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline",
                    fontFamily: SANS, fontSize: 12.5, color: C.sage, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.sageDim, width: 42 }}>
                      {new Date(r.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span style={{ color: C.cream }}>{r.qty > 1 ? `${r.qty} × ` : ""}{r.name}</span>
                    <span style={{ color: C.sageDim }}>
                      table {r.table} · {r.staff} · {r.reason}
                    </span>
                    <span style={{ marginLeft: "auto", fontFamily: MONO,
                      color: r.kind === "comp" ? C.brass : C.sage }}>
                      {money(Number(r.value) || 0, cur)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DrawerCard({ drawer, cur, onCash }) {
  const d = drawer || {};
  const expected = Number(d.expected) || 0;
  const moves = (Number(d.paidIn) || 0) > 0 || (Number(d.paidOut) || 0) > 0;

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14,
      padding: "16px 18px", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Eyebrow>Should be in the drawer</Eyebrow>
          <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 600, color: C.cream,
            marginTop: 8, letterSpacing: "-0.02em" }}>
            {money(expected, cur)}
          </div>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim, marginTop: 4, lineHeight: 1.5 }}>
            {money(Number(d.cashSales) || 0, cur)} taken in cash
            {moves && <> · {money(Number(d.paidIn) || 0, cur)} in · {money(Number(d.paidOut) || 0, cur)} out</>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn size="sm" icon={Wallet} onClick={() => onCash("in")}>Cash in</Btn>
          <Btn size="sm" icon={Wallet} onClick={() => onCash("out")}>Cash out</Btn>
        </div>
      </div>
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

/* Clearing a bar's practice runs before it opens for real. The list of what
   survives matters as much as what goes — an owner will not press this unless
   they can see their price list is safe. */
function ResetDialog({ preview, cur, onCancel, onConfirm, busy, canForce }) {
  const [typed, setTyped] = useState("");
  const blocked = (preview.fiscalReceipts || 0) > 0;

  return (
    <Modal onClose={onCancel} width={420}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <RotateCw size={19} color={C.brass} />
        <span style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 17 }}>
          Start {preview.name} clean
        </span>
      </div>
      <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, marginBottom: 14, lineHeight: 1.5 }}>
        For a bar that has finished testing and is about to open properly.
      </div>

      <div style={{ display: "grid", gap: 10, marginBottom: 14 }}>
        <div style={{ background: C.ink, border: "1px solid rgba(212,103,74,0.3)", borderRadius: 11, padding: 13 }}>
          <Eyebrow style={{ color: C.copper, marginBottom: 8 }}>Erased</Eyebrow>
          <div style={{ fontFamily: MONO, fontSize: 12.5, color: C.sage, display: "grid", gap: 4 }}>
            <Row2 a={`${preview.bills} bills`} b={money(Number(preview.takings) || 0, cur)} />
            <Row2 a={`${preview.openOrders} tables still open`} b="" />
            {preview.firstBill && (
              <Row2 a="covering" b={`${shortDate(Date.parse(preview.firstBill))} – ${shortDate(Date.parse(preview.lastBill))}`} />
            )}
          </div>
        </div>

        <div style={{ background: C.ink, border: `1px solid ${C.line2}`, borderRadius: 11, padding: 13 }}>
          <Eyebrow style={{ color: C.mint, marginBottom: 8 }}>Kept</Eyebrow>
          <div style={{ fontFamily: MONO, fontSize: 12.5, color: C.sage, display: "grid", gap: 4 }}>
            <Row2 a={`${preview.articles} articles`} b="prices and VAT" />
            <Row2 a={`${preview.tables} tables`} b="the floor plan" />
            <Row2 a={`${preview.staff} people`} b="PINs unchanged" />
            <Row2 a="branding" b="logo and colours" />
          </div>
        </div>
      </div>

      {(preview.simulatedReceipts || 0) > 0 && !blocked && (
        <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim, marginBottom: 10, lineHeight: 1.5 }}>
          {preview.simulatedReceipts} of these went to the simulator while testing. Those were
          never fiscal records, so they don't stand in the way.
        </div>
      )}

      {blocked ? (
        <div style={{ display: "flex", gap: 10, padding: "12px 14px", borderRadius: 11,
          background: "rgba(212,103,74,0.1)", border: "1px solid rgba(212,103,74,0.35)" }}>
          <AlertTriangle size={15} color={C.copper} style={{ flexShrink: 0, marginTop: 1 }} />
          <span style={{ fontFamily: SANS, fontSize: 12.5, color: C.cream, lineHeight: 1.5 }}>
            {preview.fiscalReceipts} bill{preview.fiscalReceipts > 1 ? "s were" : " was"} printed on a
            real fiscal device. Those are issued records with a retention period, so this bar is past
            testing and can't be cleared.
            {canForce && " Only you can override this, and it should be a deliberate decision."}
          </span>
        </div>
      ) : (
        <Field label={`Type ${preview.name} to confirm`} value={typed} onChange={setTyped} />
      )}

      {blocked && canForce && (
        <div style={{ marginTop: 12 }}>
          <Field label={`Type ${preview.name} to override`} value={typed} onChange={setTyped} />
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <Btn variant="ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</Btn>
        {!blocked && (
          <Btn variant="solid" icon={busy ? Loader2 : RotateCw} style={{ flex: 1 }}
            disabled={busy || typed !== preview.name}
            onClick={() => onConfirm(typed, false)}>
            Clear and start
          </Btn>
        )}
        {blocked && canForce && (
          <Btn variant="danger" icon={busy ? Loader2 : AlertTriangle} style={{ flex: 1 }}
            disabled={busy || typed !== preview.name}
            onClick={() => onConfirm(typed, true)}>
            Clear anyway
          </Btn>
        )}
      </div>
    </Modal>
  );
}

/* Changing your own PIN. Requires the current one, so a borrowed unlocked
   tablet can't be used to lock the real owner out. */
function ChangePinDialog({ onCancel, onSave, busy }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");

  const digits = (v) => v.replace(/\D/g, "").slice(0, 4);
  const ready = cur.length === 4 && next.length === 4 && next === again && next !== cur;

  return (
    <Modal onClose={onCancel} width={360}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <KeyRound size={19} color={C.brass} />
        <span style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 17 }}>
          Change your PIN
        </span>
      </div>
      <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, marginBottom: 16, lineHeight: 1.5 }}>
        Pick something nobody else knows. PINs are stored scrambled, so once you
        change it nobody can read it back — not your provider either.
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <Field label="Current PIN" value={cur} onChange={(v) => setCur(digits(v))} mono maxLength={4} />
        <Field label="New PIN" value={next} onChange={(v) => setNext(digits(v))} mono maxLength={4} />
        <Field label="New PIN again" value={again} onChange={(v) => setAgain(digits(v))} mono maxLength={4} />
      </div>

      {again.length === 4 && next !== again && (
        <div style={{ fontFamily: SANS, fontSize: 12, color: C.copper, marginTop: 8 }}>
          The two new PINs don't match.
        </div>
      )}

      <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim, marginTop: 14, lineHeight: 1.55,
        background: C.ink, border: `1px solid ${C.line}`, borderRadius: 10, padding: 12 }}>
        Worth knowing what this does and doesn't do. It stops anyone signing in
        as you — including whoever set up your bar. It is not encryption: your
        provider still hosts the database and can reach what is in it, the same
        as any other software company running a service for you.
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <Btn variant="ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</Btn>
        <Btn variant="solid" icon={busy ? Loader2 : Check} style={{ flex: 1 }}
          disabled={busy || !ready} onClick={() => onSave(cur, next)}>
          Change it
        </Btn>
      </div>
    </Modal>
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

function Team({ venue, staff: allStaff, events, flash, actions }) {
  const [editing, setEditing] = useState(null);
  const [issued, setIssued] = useState(null);
  const [deleting, setDeleting] = useState(null);   // { bar, preview }
  const [resetting, setResetting] = useState(null); // { bar, preview }
  const [resetBusy, setResetBusy] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  // Never list the owner here — deleting that row would lock them out of
  // their own bar. The database refuses it too, but it shouldn't be offered.
  const staff = (allStaff || []).filter((s) => s.role !== "owner");
  const [changing, setChanging] = useState(false);
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
          <Btn size="sm" icon={KeyRound} onClick={() => setChanging(true)}>Change my PIN</Btn>
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

      {(events || []).length > 0 && (
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, marginBottom: 16 }}>
          <Eyebrow style={{ marginBottom: 4 }}>Recent sign-in changes</Eyebrow>
          <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim, marginBottom: 10, lineHeight: 1.45 }}>
            Every PIN reset is recorded, including any made by your provider.
          </div>
          <div style={{ display: "grid", gap: 7 }}>
            {events.slice(0, 5).map((e, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12,
                fontFamily: SANS, fontSize: 12.5, color: C.sage }}>
                <span>
                  {{
                    owner_pin_reset: "Owner PIN reset",
                    staff_pin_reset: "Waiter PIN reset",
                    own_pin_changed: "PIN changed",
                    bar_data_reset: "Trading data cleared",
                  }[e.event] || e.event}
                  {e.subject ? ` · ${e.subject}` : ""}
                  <span style={{ color: C.sageDim }}> — by {e.actor}</span>
                </span>
                <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.sageDim, whiteSpace: "nowrap" }}>
                  {shortDate(Date.parse(e.at))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

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

      {changing && (
        <ChangePinDialog busy={false} onCancel={() => setChanging(false)}
          onSave={async (cur, next) => {
            const ok = await actions.changeOwnPin(cur, next);
            if (ok) setChanging(false);
          }} />
      )}

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

function Branding({ venue, flash, actions, onLanguage }) {
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

      {/* language */}
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16 }}>
        <Eyebrow style={{ marginBottom: 10 }}>Language</Eyebrow>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {Object.entries(LANGUAGES).map(([code, l]) => (
            <button key={code} onClick={() => onLanguage(code)} style={{
              padding: "9px 14px", borderRadius: 10, cursor: "pointer",
              border: `1px solid ${venue.language === code ? C.brass : C.line}`,
              background: venue.language === code ? C.a10 : "transparent",
              color: venue.language === code ? C.brass : C.sage,
              fontFamily: SANS, fontSize: 13, fontWeight: 600,
            }}>{l.name}</button>
          ))}
        </div>
        <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim, marginTop: 10, lineHeight: 1.45 }}>
          What your staff see on the floor. Changes as soon as you pick it.
        </div>
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

/* Moving a table. A free table is a move; an occupied one is a merge, and the
   difference matters enough to say out loud before it happens. */
function MoveTable({ from, zones, orders, cur, onCancel, onMove, onMerge, busy }) {
  const [confirm, setConfirm] = useState(null);   // an occupied target

  /* Resolved here, from live props, and passed to the action as an argument.
     The action used to look this up itself through a closure over component
     state — which is how it kept reporting an empty table that plainly had
     drinks on it. A function given its inputs cannot be stale. */
  const own = Object.values(orders).find((x) => x.tableId === from.tableId);

  if (confirm) {
    const total = (confirm.order.lines || []).reduce((a, l) => a + l.price * l.qty, 0);
    const mine = (own?.lines || []).reduce((a, l) => a + l.price * l.qty, 0);
    return (
      <Modal onClose={() => setConfirm(null)} width={340}>
        <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16 }}>
          Put table {from.label} onto table {confirm.label}?
        </div>
        <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, marginTop: 6, marginBottom: 14, lineHeight: 1.5 }}>
          Both have open bills, so they become one. Table {from.label} closes.
        </div>
        <div style={{ background: C.ink, border: `1px solid ${C.line}`, borderRadius: 10,
          padding: 12, display: "grid", gap: 5, fontFamily: MONO, fontSize: 12.5, color: C.sage }}>
          <Row2 a={`table ${from.label}`} b={money(mine, cur)} />
          <Row2 a={`table ${confirm.label}`} b={money(total, cur)} />
          <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 5, paddingTop: 5 }}>
            <Row2 a="one bill of" b={money(mine + total, cur)} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <Btn variant="ghost" style={{ flex: 1 }} onClick={() => setConfirm(null)}>Back</Btn>
          <Btn variant="solid" icon={busy ? Loader2 : Check} style={{ flex: 1 }} disabled={busy}
            onClick={() => onMerge(own.id, confirm.order.id)}>Merge them</Btn>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onCancel} width={380}>
      <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16 }}>
        Move table {from.label}
      </div>
      <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, marginTop: 4, marginBottom: 12 }}>
        Pick where it's going. A table with its own bill will merge.
      </div>

      <div style={{ maxHeight: 340, overflowY: "auto", display: "grid", gap: 14 }}>
        {zones.map((z) => (
          <div key={z.id}>
            <Eyebrow style={{ marginBottom: 6 }}>{z.name}</Eyebrow>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(84px,1fr))", gap: 6 }}>
              {z.tables.filter((t) => t.id !== from.tableId).map((t) => {
                const o = Object.values(orders).find((x) => x.tableId === t.id);
                return (
                  <button key={t.id} disabled={busy}
                    onClick={() => (o ? setConfirm({ ...t, order: o }) : onMove(own.id, t.id))}
                    style={{
                      padding: "10px 8px", borderRadius: 10, cursor: "pointer",
                      border: `1px solid ${o ? C.brassDim : C.line}`,
                      background: o ? C.a08 : C.raise,
                      color: C.cream, fontFamily: SANS, fontSize: 13, fontWeight: 600,
                    }}>
                    {t.label}
                    <div style={{ fontFamily: SANS, fontSize: 10.5, fontWeight: 400,
                      color: o ? C.brass : C.sageDim, marginTop: 2 }}>
                      {o ? "has a bill" : "free"}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <Btn variant="ghost" style={{ width: "100%", marginTop: 14 }} onClick={onCancel}>Cancel</Btn>
    </Modal>
  );
}

/* ---------------------------------------------------------------- prompting

   Two dialogs that replace window.prompt and window.confirm.

   A browser prompt announces the domain, ignores every style in the app, gives
   no control over the keyboard, and can't validate or show a currency. On a
   tablet mounted in a bar it looks like the app has been hijacked by a web
   page — which, to the person holding it, it has. */

function AmountPrompt({ title, hint, label, cur, note, confirmLabel = "Confirm",
                        onCancel, onConfirm, busy }) {
  const [amount, setAmount] = useState("");
  const [why, setWhy] = useState("");
  const n = Number(String(amount).replace(",", "."));
  const ready = amount !== "" && !Number.isNaN(n) && n >= 0;

  return (
    <Modal onClose={onCancel} width={330}>
      <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16 }}>{title}</div>
      {hint && (
        <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, marginTop: 4, lineHeight: 1.5 }}>
          {hint}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <Eyebrow style={{ marginBottom: 6 }}>{label}</Eyebrow>
        <div style={{ display: "flex", alignItems: "center", gap: 8,
          background: C.ink, border: `1px solid ${C.line}`, borderRadius: 11, padding: "4px 14px" }}>
          <input
            autoFocus type="number" inputMode="decimal" step="any" min="0"
            value={amount} onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            onKeyDown={(e) => { if (e.key === "Enter" && ready) onConfirm(n, why || null); }}
            style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none",
              color: C.cream, fontFamily: MONO, fontSize: 26, fontWeight: 600, padding: "10px 0" }} />
          <span style={{ fontFamily: MONO, fontSize: 15, color: C.sageDim }}>{curOf(cur).sign}</span>
        </div>
      </div>

      {note && (
        <div style={{ marginTop: 12 }}>
          <Field label={note} value={why} onChange={setWhy} placeholder="optional" />
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
        <Btn variant="ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</Btn>
        <Btn variant="solid" icon={busy ? Loader2 : Check} style={{ flex: 1 }}
          disabled={busy || !ready} onClick={() => onConfirm(n, why || null)}>
          {confirmLabel}
        </Btn>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------- dead letters

   Writes the outbox could not send and will not retry. Each one is a thing a
   waiter did that the books never heard about, so the only honest thing to do
   is show it, say what it was, and let the owner square it by hand. Dismissing
   is deliberate and one at a time: this list should never clear itself. */

const FAILED_LABEL = {
  "order.save": "Table saved",
  "order.close": "Bill closed",
  "order.payPart": "Part payment",
  "order.void": "Item taken off",
  "order.cancel": "Table cancelled",
};

function FailedWrites({ items, cur, onDismiss, onClose }) {
  return (
    <Modal onClose={onClose} width={560}>
      <Eyebrow>Not saved</Eyebrow>
      <div style={{ fontSize: 17, fontWeight: 700, color: C.cream, margin: "8px 0 6px" }}>
        {items.length === 1 ? "One change never reached the server" : `${items.length} changes never reached the server`}
      </div>
      <div style={{ fontSize: 12.5, color: C.sage, lineHeight: 1.55, marginBottom: 14 }}>
        These were tried and rejected, so the queue stopped carrying them — they are
        not in tonight's takings. Put each one right in the till or the price list,
        then clear it from this list.
      </div>

      <div style={{ display: "grid", gap: 8, maxHeight: 340, overflowY: "auto" }}>
        {items.map((it) => {
          const p = it.payload || {};
          const value = failedValue(it);
          return (
            <div key={it.seq} style={{
              border: "1px solid rgba(212,103,74,0.35)", background: "rgba(212,103,74,0.07)",
              borderRadius: 10, padding: "10px 12px",
            }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: C.cream }}>
                  {FAILED_LABEL[it.op] || it.op}
                </span>
                {p.tableLabel && (
                  <span style={{ fontSize: 12.5, color: C.sage }}>{p.tableLabel}</span>
                )}
                <span style={{ flex: 1 }} />
                {value != null && (
                  <span style={{ fontFamily: MONO, fontSize: 13, color: C.brass }}>
                    {money(value, cur)}
                  </span>
                )}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.copper, marginTop: 5, lineHeight: 1.45 }}>
                {it.lastError || "no reason recorded"}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                <span style={{ fontSize: 11, color: C.sageDim }}>
                  {new Date(it.failedAt).toLocaleString()}
                  {p.staffName ? ` · ${p.staffName}` : ""}
                </span>
                <span style={{ flex: 1 }} />
                <Btn size="sm" onClick={() => onDismiss(it.seq)}>Sorted</Btn>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
        <Btn onClick={onClose}>Close</Btn>
      </div>
    </Modal>
  );
}

function Confirm({ title, body, confirmLabel = "Yes", danger, onCancel, onConfirm, busy }) {
  return (
    <Modal onClose={onCancel} width={340}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        {danger && <AlertTriangle size={19} color={C.copper} />}
        <span style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16 }}>{title}</span>
      </div>
      <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, lineHeight: 1.55 }}>{body}</div>
      <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
        <Btn variant="ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</Btn>
        <Btn variant={danger ? "danger" : "solid"} icon={busy ? Loader2 : Check} style={{ flex: 1 }}
          disabled={busy} onClick={onConfirm}>{confirmLabel}</Btn>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ shifts */

/* A slim bar above the floor. Waiters live on this screen, so the shift lives
   here too rather than buried in a menu they'd never open mid-service. */
function ShiftBar({ shift, cur, onStart, onEnd, busy }) {
  if (!shift) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14,
        padding: "10px 14px", borderRadius: 12, background: C.panel,
        border: `1px solid ${C.line}`, flexWrap: "wrap" }}>
        <Clock size={14} color={C.sageDim} />
        <span style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, flex: 1, minWidth: 140 }}>
          No shift open. Start one and the cash you take is counted against your name.
        </span>
        <Btn size="sm" icon={Clock} disabled={busy} onClick={onStart}>Start shift</Btn>
      </div>
    );
  }

  const since = new Date(shift.openedAt);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14,
      padding: "10px 14px", borderRadius: 12, background: C.panel,
      border: `1px solid ${C.brassDim}`, flexWrap: "wrap" }}>
      <Clock size={14} color={C.brass} />
      <span style={{ fontFamily: SANS, fontSize: 12.5, color: C.cream }}>
        Shift since {since.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
      </span>
      <span style={{ fontFamily: MONO, fontSize: 13.5, color: C.brass }}>
        {money(Number(shift.expected) || 0, cur)}
      </span>
      <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim }}>
        should be in hand · {shift.bills} bill{shift.bills === 1 ? "" : "s"}
      </span>
      <Btn size="sm" variant="ghost" disabled={busy} style={{ marginLeft: "auto" }} onClick={onEnd}>
        End shift
      </Btn>
    </div>
  );
}

/* Handing over. The declared figure is typed BEFORE the expected one is shown —
   otherwise it isn't a count, it's a copy. */
function CashUp({ shift, cur, onCancel, onConfirm, busy }) {
  const [declared, setDeclared] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState(null);

  if (result) {
    const off = Number(result.variance) || 0;
    const good = Math.abs(off) < 0.01;
    return (
      <Modal onClose={onCancel} width={340}>
        <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16, marginBottom: 12 }}>
          Shift closed
        </div>
        <div style={{ display: "grid", gap: 6, fontFamily: MONO, fontSize: 13, color: C.sage }}>
          <Row2 a="expected" b={money(Number(result.expected_cash) || 0, cur)} />
          <Row2 a="handed over" b={money(Number(result.declared_cash) || 0, cur)} />
          <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 6, paddingTop: 6,
            display: "flex", justifyContent: "space-between",
            color: good ? C.mint : Math.abs(off) > 200 ? C.copper : C.brass }}>
            <span>{good ? "exact" : off > 0 ? "over" : "short"}</span>
            <span>{money(Math.abs(off), cur)}</span>
          </div>
        </div>
        <Btn variant="solid" style={{ width: "100%", marginTop: 16 }} onClick={onCancel}>Done</Btn>
      </Modal>
    );
  }

  return (
    <Modal onClose={onCancel} width={340}>
      <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16 }}>
        Ending your shift
      </div>
      <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, marginTop: 4, marginBottom: 14, lineHeight: 1.5 }}>
        Count the cash you're handing over and type it in. What it should be is
        shown after — a count you can see the answer to isn't a count.
      </div>

      <Field label="Cash you're handing over" value={declared} onChange={setDeclared}
        type="number" mono suffix={curOf(cur).sign} />
      <div style={{ marginTop: 10 }}>
        <Field label="Anything to note" value={note} onChange={setNote} placeholder="optional" />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <Btn variant="ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</Btn>
        <Btn variant="solid" icon={busy ? Loader2 : Check} style={{ flex: 1 }}
          disabled={busy || declared === ""}
          onClick={async () => {
            const r = await onConfirm(declared, note);
            if (r) setResult(r);
          }}>Hand over</Btn>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------- stock */

const UNIT_LABEL = { ml: "ml", g: "g", piece: "each" };

/* A bar buys in packs and pours in millilitres. Showing both — "4.2 bottles"
   next to "2,940 ml" — is the difference between a number an owner can act on
   and one they have to do arithmetic on. */
/* How much is actually there, in the unit the bar counts in.

   Showing only packs was misleading: 1,370ml of gin displayed as "2.0 × 700ml",
   which reads as two full bottles when it is one and a bit. Packs are rounded
   DOWN for the same reason — a bar has the bottles it has, not the ones
   arithmetic rounds it up to. */
/* A quantity in the unit a bar would say out loud: millilitres up to a litre,
   litres above it, and never rounded up — 24.5L is not 25L when you are
   deciding whether to open another keg. */
function amountIn(n, unit) {
  const v = Math.max(0, Number(n) || 0);
  if (unit === "piece") return `${Math.round(v)}`;
  const big = unit === "ml" ? "L" : "kg";
  if (v >= 1000) {
    const x = Math.floor((v / 1000) * 10) / 10;
    return `${x} ${big}`;
  }
  return `${Math.round(v)} ${unit}`;
}

const stockAmount = (item) => amountIn(item.in_stock, item.unit);

function packsLabel(item) {
  const n = Number(item.in_stock) || 0;
  const size = Number(item.pack_size) || 0;
  if (!size) return "";
  // Rounded down: a bar has the bottles it has, not the ones arithmetic
  // rounds it up to.
  const packs = Math.floor((n / size) * 10) / 10;
  if (item.unit === "piece") return size > 1 ? `${packs} × ${size}` : "";
  return `${packs} × ${amountIn(size, item.unit)}`;
}

/* What a drink is made of. Lives in the article editor because that is where
   an owner already goes to think about a drink — and because the cost it
   computes replaces the number they would otherwise have to invent. */
function RecipeEditor({ article, ingredients, recipe, cur, onChange, onLink, onUnlink, busy }) {
  const [adding, setAdding] = useState(false);
  const items = recipe?.items || [];
  const self = recipe?.self || null;          // set when sold as it comes
  const [pack, setPack] = useState(self?.unitsPerPack || 24);
  const cost = items.reduce((a, i) => a + (Number(i.lineCost) || 0), 0);
  const margin = article.price > 0 ? ((article.price - cost) / article.price) * 100 : 0;

  const set = (ingredientId, qty) =>
    onChange(items
      .map((i) => (i.ingredientId === ingredientId ? { ...i, qty } : i))
      .filter((i) => Number(i.qty) > 0));

  const add = (ing) => {
    if (items.some((i) => i.ingredientId === ing.id)) return setAdding(false);
    onChange([...items, { ingredientId: ing.id, name: ing.name, unit: ing.unit, qty: 30 }]);
    setAdding(false);
  };

  return (
    <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 14, paddingTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <Package size={14} color={C.sageDim} />
        <Eyebrow>What goes in it</Eyebrow>
        {busy && <Loader2 size={12} color={C.sageDim} className="animate-spin" />}
      </div>

      {/* Two genuinely different things. A cocktail is made from stock; a bottle
          of beer IS stock. Asking for a recipe of one-of-itself was busywork. */}
      <div style={{ display: "flex", gap: 8, marginTop: 8, marginBottom: 12 }}>
        {[[false, "Made from ingredients"], [true, "Sold as it comes"]].map(([isSelf, label]) => (
          <button key={label} disabled={busy}
            onClick={() => (isSelf ? onLink(pack) : onUnlink())}
            style={{
              flex: 1, padding: "9px 8px", borderRadius: 10, cursor: "pointer",
              border: `1px solid ${!!self === isSelf ? C.brass : C.line}`,
              background: !!self === isSelf ? C.a10 : "transparent",
              color: !!self === isSelf ? C.brass : C.sage,
              fontFamily: SANS, fontSize: 12, fontWeight: 600, lineHeight: 1.3,
            }}>{label}</button>
        ))}
      </div>

      {self ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim, lineHeight: 1.5 }}>
            Selling one takes one off the shelf. Deliveries are counted in cases,
            which is how they arrive.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: SANS, fontSize: 13, color: C.cream, flex: 1 }}>
              How many in a case
            </span>
            <input type="number" inputMode="numeric" min="1" value={pack}
              onChange={(e) => setPack(e.target.value)}
              onBlur={() => onLink(pack)}
              style={{ width: 74, background: C.ink, border: `1px solid ${C.line}`, borderRadius: 8,
                padding: "8px 10px", color: C.cream, fontFamily: MONO, fontSize: 13,
                textAlign: "right", outline: "none" }} />
          </div>
          <div style={{ background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9, padding: "10px 12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim }}>On the shelf</span>
              <span style={{ fontFamily: MONO, fontSize: 13.5, color: C.cream }}>
                {Math.round(Number(self.inStock) || 0)}
              </span>
            </div>
            <div style={{ fontFamily: SANS, fontSize: 11, color: C.sageDim, marginTop: 6, lineHeight: 1.45 }}>
              Counted and reordered under Stock, like everything else. The buy
              price above is what one costs you.
            </div>
          </div>
        </div>
      ) : !ingredients.length ? (
        <div style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim, lineHeight: 1.5, marginTop: 6 }}>
          Add what you buy under Stock first — bottles, kegs, cases — then a
          recipe here works out what this drink costs.
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            {items.map((i) => (
              <div key={i.ingredientId} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontFamily: SANS, fontSize: 13, color: C.cream,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.name}</span>
                <input type="number" inputMode="decimal" value={i.qty}
                  onChange={(e) => set(i.ingredientId, e.target.value)}
                  style={{ width: 68, background: C.ink, border: `1px solid ${C.line}`, borderRadius: 8,
                    padding: "7px 9px", color: C.cream, fontFamily: MONO, fontSize: 13,
                    textAlign: "right", outline: "none" }} />
                <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.sageDim, width: 30 }}>
                  {UNIT_LABEL[i.unit] || ""}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 12, color: C.sage, width: 62, textAlign: "right" }}>
                  {money(Number(i.lineCost) || 0, cur)}
                </span>
                <button onClick={() => set(i.ingredientId, 0)}
                  style={{ background: "none", border: "none", cursor: "pointer", color: C.sageDim, padding: 2 }}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>

          {adding ? (
            <div style={{ marginTop: 10, maxHeight: 160, overflowY: "auto", display: "grid", gap: 4 }}>
              {ingredients.filter((g) => !items.some((i) => i.ingredientId === g.id)).map((g) => (
                <button key={g.id} onClick={() => add(g)} style={{
                  textAlign: "left", padding: "8px 10px", borderRadius: 8, cursor: "pointer",
                  background: C.raise, border: `1px solid ${C.line}`, color: C.cream,
                  fontFamily: SANS, fontSize: 12.5,
                }}>{g.name}</button>
              ))}
            </div>
          ) : (
            <Btn size="sm" icon={Plus} style={{ marginTop: 10 }} onClick={() => setAdding(true)}>
              Add an ingredient
            </Btn>
          )}

          {items.length > 0 && (
            <div style={{ background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9,
              padding: "10px 12px", marginTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim }}>Costs to make</span>
                <span style={{ fontFamily: MONO, fontSize: 13.5, color: C.cream }}>{money(cost, cur)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                <span style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim }}>
                  Sells at {money(article.price, cur)} — margin
                </span>
                <span style={{ fontFamily: MONO, fontSize: 13.5,
                  color: margin > 65 ? C.mint : margin > 40 ? C.brass : C.copper }}>
                  {margin.toFixed(0)}%
                </span>
              </div>
              <div style={{ fontFamily: SANS, fontSize: 11, color: C.sageDim, marginTop: 6, lineHeight: 1.45 }}>
                This replaces the buy price — it is worked out from the recipe, so
                it follows your supplier prices on its own.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* The order, in the form it actually gets used: grouped by supplier, whole
   packs, and sendable. A list you have to retype into WhatsApp is a list that
   gets retyped wrong. */
function ReorderSheet({ data, cur, barName, onCancel, flash }) {
  const [qty, setQty] = useState({});          // id -> overridden pack count
  const suppliers = data?.suppliers || [];

  const packsFor = (it) => {
    const v = qty[it.id];
    return v === undefined || v === "" ? it.packs : Math.max(0, Number(v) || 0);
  };

  const total = suppliers.reduce((a, s) =>
    a + s.items.reduce((b, it) => b + packsFor(it) * Number(it.packCost || 0), 0), 0);

  const asText = () => {
    const when = new Date().toLocaleDateString();
    const out = [`${barName} — ${t("Order")} ${when}`, ""];
    for (const s of suppliers) {
      const lines = s.items.filter((it) => packsFor(it) > 0);
      if (!lines.length) continue;
      out.push(s.supplier);
      for (const it of lines) {
        const unit = it.unit === "piece" ? "" : ` × ${Number(it.packSize)}${UNIT_LABEL[it.unit]}`;
        out.push(`  ${it.name} — ${packsFor(it)}${unit}`);
      }
      out.push("");
    }
    return out.join("\n").trim();
  };

  const send = async () => {
    const text = asText();
    try {
      // A phone can hand this straight to WhatsApp; a desktop gets the clipboard.
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); flash(t("Order copied")); }
    } catch { /* the person cancelled the share sheet */ }
  };

  if (!suppliers.length) {
    return (
      <Modal onClose={onCancel} width={360}>
        <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16 }}>
          Nothing to order
        </div>
        <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, marginTop: 6, lineHeight: 1.55 }}>
          Everything is above its par level. If that seems wrong, check the
          reorder points — an ingredient with none set is never counted as low.
        </div>
        <Btn variant="ghost" style={{ width: "100%", marginTop: 16 }} onClick={onCancel}>Close</Btn>
      </Modal>
    );
  }

  return (
    <Modal onClose={onCancel} width={420}>
      <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16 }}>
        What to order
      </div>
      <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, marginTop: 4, marginBottom: 12, lineHeight: 1.5 }}>
        Enough whole packs to get each one back to its par level. Change any
        number before you send it.
      </div>

      <div style={{ maxHeight: 340, overflowY: "auto", display: "grid", gap: 16 }}>
        {suppliers.map((s) => (
          <div key={s.supplier}>
            <Eyebrow style={{ marginBottom: 8 }}>{s.supplier}</Eyebrow>
            <div style={{ display: "grid", gap: 8 }}>
              {s.items.map((it) => (
                <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: SANS, fontSize: 13.5, color: C.cream, overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</div>
                    <div style={{ fontFamily: MONO, fontSize: 11, color: C.sageDim, marginTop: 2 }}>
                      {Math.round(Number(it.inStock))}{UNIT_LABEL[it.unit]} left · par {Math.round(Number(it.par))}{UNIT_LABEL[it.unit]}
                    </div>
                  </div>
                  <input type="number" inputMode="numeric" min="0"
                    value={qty[it.id] ?? it.packs}
                    onChange={(e) => setQty({ ...qty, [it.id]: e.target.value })}
                    style={{ width: 60, background: C.ink, border: `1px solid ${C.line}`, borderRadius: 8,
                      padding: "8px 10px", color: C.cream, fontFamily: MONO, fontSize: 14,
                      textAlign: "right", outline: "none" }} />
                  <span style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim, width: 52 }}>
                    {it.unit === "piece" ? "each" : `× ${Number(it.packSize)}${UNIT_LABEL[it.unit]}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
        borderTop: `1px solid ${C.line}`, marginTop: 14, paddingTop: 12 }}>
        <span style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim }}>
          Roughly what it costs
        </span>
        <span style={{ fontFamily: MONO, fontSize: 17, color: C.cream }}>{money(total, cur)}</span>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <Btn variant="ghost" style={{ flex: 1 }} onClick={onCancel}>Close</Btn>
        <Btn variant="solid" icon={Share2} style={{ flex: 2 }} onClick={send}>Send the order</Btn>
      </div>
    </Modal>
  );
}

function IngredientEditor({ ing, cur, onCancel, onSave, onRemove }) {
  const [v, setV] = useState(ing);
  const unitCost = Number(v.packSize) > 0 ? Number(v.packCost) / Number(v.packSize) : 0;

  return (
    <Modal onClose={onCancel} width={380}>
      <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16, marginBottom: 14 }}>
        {v.id ? "Edit ingredient" : "New ingredient"}
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <Field label="Name" value={v.name} onChange={(x) => setV({ ...v, name: x })}
          placeholder="Campari" />

        <div>
          <Eyebrow style={{ marginBottom: 6 }}>Measured in</Eyebrow>
          <div style={{ display: "flex", gap: 8 }}>
            {[["ml", "Millilitres"], ["g", "Grams"], ["piece", "Pieces"]].map(([u, label]) => (
              <button key={u} onClick={() => setV({ ...v, unit: u })} style={{
                flex: 1, padding: "9px 6px", borderRadius: 10, cursor: "pointer",
                border: `1px solid ${v.unit === u ? C.brass : C.line}`,
                background: v.unit === u ? C.a10 : "transparent",
                color: v.unit === u ? C.brass : C.sage,
                fontFamily: SANS, fontSize: 12, fontWeight: 600,
              }}>{label}</button>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label={v.unit === "piece" ? "Units per case" : `${UNIT_LABEL[v.unit]} per pack`}
            type="number" mono value={v.packSize} onChange={(x) => setV({ ...v, packSize: x })} />
          <Field label="What a pack costs" type="number" step="0.01" mono suffix={curOf(cur).sign}
            value={v.packCost} onChange={(x) => setV({ ...v, packCost: x })} />
        </div>

        {/* The number that makes a recipe cost anything. Shown per pour rather
            than per millilitre, because nobody thinks in millilitre-prices. */}
        <div style={{ background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9,
          padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontFamily: SANS, fontSize: 12, color: C.sageDim }}>
            {v.unit === "piece" ? "Each costs" : "A 3cl pour costs"}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 14, color: C.brass }}>
            {money(v.unit === "piece" ? unitCost : unitCost * 30, cur)}
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label={`Reorder at (${UNIT_LABEL[v.unit]})`} type="number" mono
            value={v.parLevel} onChange={(x) => setV({ ...v, parLevel: x })} />
          <Field label="Supplier" value={v.supplier} onChange={(x) => setV({ ...v, supplier: x })} />
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
        {v.id && <Btn variant="danger" icon={Trash2} onClick={onRemove} />}
        <Btn variant="ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</Btn>
        <Btn variant="solid" icon={Check} style={{ flex: 1 }}
          disabled={!v.name.trim() || !(Number(v.packSize) > 0)}
          onClick={() => onSave({ ...v, name: v.name.trim() })}>Save</Btn>
      </div>
    </Modal>
  );
}

/* Deliveries and stocktakes are the same shape: a number against each
   ingredient. Sharing one sheet keeps them consistent and halves the code. */
function StockSheet({ mode, items, onCancel, onSubmit }) {
  const [vals, setVals] = useState({});
  const [note, setNote] = useState("");
  const [q, setQ] = useState("");
  const delivery = mode === "delivery";

  const shown = items.filter((i) => !q || i.name.toLowerCase().includes(q.toLowerCase()));
  const filled = Object.entries(vals).filter(([, v]) => v !== "" && v != null);

  const rows = filled.map(([id, v]) =>
    delivery ? { ingredientId: id, packs: v } : { ingredientId: id, counted: v });

  return (
    <Modal onClose={onCancel} width={440}>
      <div style={{ fontFamily: SANS, fontWeight: 700, color: C.cream, fontSize: 16 }}>
        {delivery ? "Stock arriving" : "Counting the shelf"}
      </div>
      <div style={{ fontFamily: SANS, fontSize: 12.5, color: C.sageDim, marginTop: 4, marginBottom: 12, lineHeight: 1.5 }}>
        {delivery
          ? "How many packs came in. Leave the rest blank."
          : "What is actually there, in the unit shown. The difference against what the books expect is recorded — that difference is the point of counting."}
      </div>

      <div style={{ position: "relative", marginBottom: 10 }}>
        <Search size={14} color={C.sageDim} style={{ position: "absolute", left: 11, top: 11 }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an ingredient"
          style={{ width: "100%", background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9,
            padding: "9px 12px 9px 32px", color: C.cream, fontFamily: SANS, fontSize: 13, outline: "none" }} />
      </div>

      <div style={{ maxHeight: 300, overflowY: "auto", display: "grid", gap: 6 }}>
        {shown.map((i) => (
          <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: SANS, fontSize: 13, color: C.cream, overflow: "hidden",
                textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.name}</div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.sageDim }}>
                {delivery
                  ? `${Number(i.pack_size)}${UNIT_LABEL[i.unit]} per pack`
                  : `books say ${Math.round(Number(i.in_stock))}${UNIT_LABEL[i.unit]}`}
              </div>
            </div>
            <input type="number" inputMode="decimal"
              value={vals[i.id] ?? ""} placeholder={delivery ? "packs" : UNIT_LABEL[i.unit]}
              onChange={(e) => setVals({ ...vals, [i.id]: e.target.value })}
              style={{ width: 92, background: C.ink, border: `1px solid ${C.line}`, borderRadius: 8,
                padding: "8px 10px", color: C.cream, fontFamily: MONO, fontSize: 13,
                textAlign: "right", outline: "none" }} />
          </div>
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        <Field label="Note" value={note} onChange={setNote}
          placeholder={delivery ? "invoice number" : "Monday count"} />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <Btn variant="ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</Btn>
        <Btn variant="solid" icon={Check} style={{ flex: 2 }} disabled={!rows.length}
          onClick={() => onSubmit(rows, note)}>
          {delivery ? `Receive ${rows.length}` : `Save count of ${rows.length}`}
        </Btn>
      </div>
    </Modal>
  );
}

function Stock({ venue, stock, loading, actions, onReorder }) {
  const cur = venue.currency;
  const [editing, setEditing] = useState(null);
  const [mode, setMode] = useState(null);     // 'delivery' | 'count'
  const [q, setQ] = useState("");

  const items = (stock?.items || []).filter(
    (i) => !q || i.name.toLowerCase().includes(q.toLowerCase()));
  const low = (stock?.items || []).filter((i) => i.low);

  return (
    <div style={{ maxWidth: 940 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: 16 }}>
        <Stat label="Stock on hand" value={money(Number(stock?.totalValue) || 0, cur)}
          sub={`${(stock?.items || []).length} ingredients`} />
        <button onClick={() => (stock?.lowCount ? onReorder() : null)}
          disabled={!stock?.lowCount}
          style={{ textAlign: "left", padding: 0, border: "none", background: "none",
            cursor: stock?.lowCount ? "pointer" : "default" }}>
          <Stat label="Running low" value={stock?.lowCount ?? 0}
            accent={(stock?.lowCount || 0) > 0 ? C.copper : C.cream}
            sub={low.length ? `tap to see what to order` : "nothing to reorder"} />
        </button>
        <Stat label="Drinks with no recipe" value={stock?.noRecipe ?? 0}
          accent={(stock?.noRecipe || 0) > 0 ? C.brass : C.mint}
          sub={(stock?.noRecipe || 0) > 0 ? "their cost is guesswork" : "every drink is costed"} />
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 180px" }}>
          <Search size={14} color={C.sageDim} style={{ position: "absolute", left: 11, top: 11 }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an ingredient"
            style={{ width: "100%", background: C.ink, border: `1px solid ${C.line}`, borderRadius: 9,
              padding: "9px 12px 9px 32px", color: C.cream, fontFamily: SANS, fontSize: 13, outline: "none" }} />
        </div>
        <Btn icon={ShoppingBag} onClick={onReorder}>Order</Btn>
        <Btn icon={TruckIcon} onClick={() => setMode("delivery")}>Delivery</Btn>
        <Btn icon={ClipboardCheck} onClick={() => setMode("count")}>Count</Btn>
        <Btn variant="solid" icon={Plus}
          onClick={() => setEditing({ id: null, name: "", unit: "ml", packSize: 700, packCost: 0, parLevel: 0, supplier: "" })}>
          Ingredient
        </Btn>
        {loading && <Loader2 size={14} color={C.sageDim} className="animate-spin" />}
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, overflow: "hidden" }}>
        {items.map((i) => (
          <div key={i.id} onClick={() => setEditing({
            id: i.id, name: i.name, unit: i.unit, packSize: i.pack_size,
            packCost: i.pack_cost, parLevel: i.par_level, supplier: i.supplier || "",
          })}
            style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
              borderBottom: `1px solid ${C.lineFade}`, cursor: "pointer", flexWrap: "wrap" }}>
            <div style={{ minWidth: 0, flex: "1 1 140px" }}>
              <div style={{ fontFamily: SANS, fontSize: 14, color: C.cream }}>{i.name}</div>
              <div style={{ fontFamily: SANS, fontSize: 11.5, color: C.sageDim, marginTop: 2 }}>
                {money(Number(i.pack_cost), cur)} per {Number(i.pack_size)}{UNIT_LABEL[i.unit]}
                {i.used_in > 0 ? ` · in ${i.used_in} drink${i.used_in > 1 ? "s" : ""}` : " · not used yet"}
              </div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              {/* The amount first, because that is the question being asked:
                  how much is left. Packs and value are the follow-up. */}
              <div style={{ fontFamily: MONO, fontSize: 15, color: i.low ? C.copper : C.cream }}>
                {stockAmount(i)}
                {i.unit === "piece" && (
                  <span style={{ fontSize: 11.5, color: C.sageDim }}> left</span>
                )}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 11.5, color: C.sageDim, marginTop: 2 }}>
                {[packsLabel(i), money(Number(i.value), cur)].filter(Boolean).join(" · ")}
              </div>
            </div>
            {i.low && (
              <span style={{ fontFamily: SANS, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em",
                color: C.copper, border: `1px solid ${C.copper}55`, borderRadius: 99, padding: "2px 8px" }}>
                LOW
              </span>
            )}
            <ChevronRight size={16} color={C.sageDim} />
          </div>
        ))}
        {!items.length && (
          <div style={{ padding: 22, fontFamily: SANS, fontSize: 13, color: C.sageDim, lineHeight: 1.6 }}>
            {q ? "Nothing matches." : (
              <>Nothing here yet. Add what you buy — a bottle, a keg, a case — then
              give each drink a recipe. Once both exist, every sale takes stock off
              the shelf on its own and the cost of a drink stops being a guess.</>
            )}
          </div>
        )}
      </div>

      {editing && (
        <IngredientEditor ing={editing} cur={cur} onCancel={() => setEditing(null)}
          onSave={async (v) => { const ok = await actions.saveIngredient(v); if (ok) setEditing(null); }}
          onRemove={async () => { await actions.removeIngredient(editing.id); setEditing(null); }} />
      )}

      {mode && (
        <StockSheet mode={mode} items={stock?.items || []}
          onCancel={() => setMode(null)}
          onSubmit={async (rows, note) => {
            const ok = mode === "delivery"
              ? await actions.receiveDelivery(rows, note)
              : await actions.recordStocktake(rows, note);
            if (ok) setMode(null);
          }} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ platform side */

function AdminBars({ venues, todayByBar, now, openAsOwner, flash, actions, loading }) {
  const [detail, setDetail] = useState(null);
  const [adding, setAdding] = useState(null);
  const [issued, setIssued] = useState(null);
  const [deleting, setDeleting] = useState(null);   // { bar, preview }
  const [resetting, setResetting] = useState(null); // { bar, preview }
  const [resetBusy, setResetBusy] = useState(false);
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

            <Btn icon={RotateCw} style={{ width: "100%", marginBottom: 16 }}
              onClick={async () => {
                const pv = await actions.resetPreview(v);
                if (pv) { setDetail(null); setResetting({ bar: v, preview: pv }); }
              }}>
              Clear their test bills
            </Btn>

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

      {resetting && (
        <ResetDialog
          preview={resetting.preview} cur={resetting.bar.currency} busy={resetBusy} canForce
          onCancel={() => setResetting(null)}
          onConfirm={async (confirm, force) => {
            setResetBusy(true);
            const ok = await actions.resetBar(resetting.bar, confirm, force);
            setResetBusy(false);
            if (ok) setResetting(null);
          }}
        />
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
      position: "fixed", bottom: "calc(22px + env(safe-area-inset-bottom))", left: "50%", transform: "translateX(-50%)", zIndex: 210,
      display: "flex", alignItems: "center", gap: 9, padding: "11px 18px", borderRadius: 99,
      background: C.brass, color: C.onBrass, border: "none", cursor: "pointer",
      fontFamily: SANS, fontSize: 13, fontWeight: 700,
      boxShadow: "0 10px 40px -10px rgba(0,0,0,0.8)",
    }}>
      <RotateCw size={15} /> {t("New version ready — tap to update")}
    </button>
  );
}

function Splash({ text = t("Opening the floor…") }) {
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
  /* Which side of the sheet to land on. Tapping a table is "I'm taking an
     order"; tapping an open bill is "they want to pay". Only matters on a
     phone, where the two panes take turns. */
  const [openOn, setOpenOn] = useState("menu");
  const [sheetBusy, setSheetBusy] = useState(false);
  /* Bumped after a partial payment. The sheet keeps its line list in local
     state, so without a nudge it would keep showing an item that has just been
     paid for and removed from the table. */
  const [sheetSync, setSheetSync] = useState(0);
  const [toast, setToast] = useState(null);
  const now = useNow(20000);
  const installPrompt = useInstallPrompt();
  const [logoStamp, setLogoStamp] = useState(1);

  /* Language. Held in state so switching re-renders; the actual lookup is a
     module-level function, which keeps it out of every component's props. */
  const [lang, setLangState] = useState(() => recallLang());
  useEffect(() => { setLang(lang); }, [lang]);

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
    online, syncing, pendingCount, failed, dismissFailed,
  } = useBarData(session && session.role !== "platform" ? session : null);
  const [showFailed, setShowFailed] = useState(false);
  const client = useMemo(() => (session ? clientFor(session) : null), [session]);

  const venueRaw = data?.venue || null;
  const venue = useMemo(() => {
    if (!venueRaw) return null;
    return { ...venueRaw, logoUrl: client ? api.logoUrl(client, venueRaw.logoPath, logoStamp) : null };
  }, [venueRaw, client, logoStamp]);
  /* Stable identities. `data?.zones || []` creates a fresh array on every
     render, so anything depending on it re-runs constantly — and worse, tempts
     you to leave it out of a dependency array, which is how a hook ends up
     holding last render's data. */
  const zones = useMemo(() => data?.zones || [], [data]);
  const articles = useMemo(() => data?.articles || [], [data]);
  const orders = useMemo(() => data?.orders || {}, [data]);

  useEffect(() => {
    if (zones.length && (!zoneId || !zones.some((z) => z.id === zoneId))) setZoneId(zones[0].id);
  }, [zones, zoneId]);

  useEffect(() => {
    // A bar sets the language its staff read; the device only decides before
    // anyone has signed in.
    if (venue?.language && venue.language !== lang) setLangState(venue.language);
  }, [venue?.language]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!venue) return;
    const brand = { accent: venue.brandAccent, surface: venue.brandSurface };
    applyTheme(brand);
    rememberBrand(brand);
  }, [venue?.brandAccent, venue?.brandSurface, venue]);

  const zone = zones.find((z) => z.id === zoneId) || zones[0] || null;
  /* Takeaway: someone at the counter with no table. save_order_full already
     accepts a null table and a free label, so this needs no schema change —
     just somewhere for it to live, which is Open bills. */
  const [takeaway, setTakeaway] = useState(null);   // { id, label } while open

  const table = takeaway
    || zone?.tables.find((t) => t.id === openTableId)
    || null;

  // Orders are keyed by id; the floor needs them keyed by table.
  const ordersByTable = useMemo(() => {
    const m = {};
    Object.values(orders).forEach((o) => { m[`${o.venueId}/${o.tableId}`] = o; });
    return m;
  }, [orders]);
  const openOrder = takeaway
    ? Object.values(orders).find((o) => o.id === takeaway.orderId) || null
    : table ? ordersByTable[`${venue?.id}/${table.id}`] : null;

  /* ---- auth handlers ---- */
  const doPair = async (code) => {
    setAuthBusy(true); setLoginError("");
    try {
      const bar = await pairDevice(code);
      setPaired(bar);
      if (bar.language) setLangState(bar.language);
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

  const [securityEvents, setSecurityEvents] = useState([]);

  const loadSecurity = useCallback(async () => {
    if (!client || !venue || session?.role !== "owner") return;
    try { setSecurityEvents(await api.securityEvents(client, venue.id)); }
    catch { /* not critical enough to interrupt anyone */ }
  }, [client, venue, session]);

  useEffect(() => { if (tab === "team") loadSecurity(); }, [tab, loadSecurity]);


  /* ---- orders: these are the writes that must survive a dead connection ---- */

  const commitOrder = async (lines, guests, close = true) => {
    setSheetBusy(true);
    try {
    const orderId = openOrder?.id || takeaway?.orderId || crypto.randomUUID();
    /* Returned on success so "Close bill" can create and settle in one go.
       Making a waiter press Save before Close is bookkeeping the app should do
       for itself — and for a takeaway there is nothing to come back to. */
    const payload = {
      orderId, barId: venue.id, tableId: table.id || null, tableLabel: table.label,
      guests, lines, staffId: openOrder?.staffId || session.actorId,
      staffName: openOrder?.staffName || session.actorName,
      openedAt: openOrder?.openedAt || Date.now(),
    };

      const res = await write("order.save", payload, (c) =>
        api.saveOrder(c, {
          orderId, barId: venue.id, table, guests, lines,
          staff: { id: payload.staffId, name: payload.staffName },
          openedAt: payload.openedAt,
        })
      );
      if (close) setOpenTableId(null);
      flash(res === "queued"
        ? `${table.label} saved on this device — will sync`
        : `${table.label} saved`);
      return orderId;
    } catch (e) { flash(e.message); return false; }
    finally { setSheetBusy(false); }
  };

  /* Taking something off a saved table. Goes through the outbox like every
     other write, so a void taken with no signal still reaches the record. */
  const voidLine = async (line, qty, reason, kind, consumed) => {
    if (!openOrder || !line.id) return flash("Save the order first.");
    setSheetBusy(true);
    try {
      await write(
        "order.void",
        { orderId: openOrder.id, lineId: line.id, qty, reason, kind, consumed },
        (c) => api.voidOrderLine(c, { lineId: line.id, qty, reason, kind, consumed })
      );
      setSheetSync((n) => n + 1);
      flash(kind === "comp"
        ? `${line.name} on the house — ${money(line.price * qty, venue.currency)}`
        : `${line.name} taken off — ${reason}`);
      return true;
    } catch (e) { flash(e.message); return false; }
    finally { setSheetBusy(false); }
  };

  /* One guest settles and leaves. Their portion becomes its own bill with its
     own receipt; the table stays open with what's left. */
  const payPart = async (chosen, method) => {
    if (!openOrder) return flash("Save the order first.");
    setSheetBusy(true);
    try {
      const billId = crypto.randomUUID();

      /* The total is worked out here rather than read off the returned bill,
         because queued offline there is no bill yet. These are the prices the
         server stamped on the lines and a part-payment takes no discount, so
         it matches what the database records. */
      const total = round2(chosen.reduce((a, l) => a + l.price * l.qty, 0));

      const res = await write(
        "order.payPart",
        { orderId: openOrder.id, billId, lines: chosen, method, paid: true },
        (c) => api.payPartOfOrder(c, {
          orderId: openOrder.id, billId, lines: chosen, method, paid: true,
        })
      );

      /* Did that clear the table? Work it out from what was taken rather than
         waiting for state to settle. */
      const takenAll = openOrder.lines.every((l) => {
        const c = chosen.find((x) => (x.id || x.articleId) === (l.id || l.articleId));
        return c && c.qty >= l.qty;
      });

      const tail = res === "queued" ? " (will sync)" : "";
      if (takenAll) {
        setOpenTableId(null); setTakeaway(null);
        flash(`Paid ${money(total, venue.currency)} — table closed${tail}`);
      } else {
        // The sheet stays open, so tell it to re-read the remaining lines.
        setSheetSync((n) => n + 1);
        flash(`Paid ${money(total, venue.currency)} — the rest stays on the table${tail}`);
      }
      // A queued sale gets its receipt from the fiscal retry once it syncs.
      if (res !== "queued" && venue.fiscalEnabled && venue.fiscalBridgeUrl) printFiscal(billId);
    } catch (e) { flash(e.message); }
    finally { setSheetBusy(false); }
  };

  const settleOrder = async (method, paid, discount, payments, customer, draft) => {
    /* No saved order yet — create it, then settle it, in one tap. The sheet
       passes its current lines rather than the app reaching into its state. */
    let orderId = openOrder?.id;
    if (!orderId) {
      if (!draft?.lines?.length) return flash("Add something first.");
      orderId = await commitOrder(draft.lines, draft.guests, false);
      if (!orderId) return;
    }

    setSheetBusy(true);
    try {
      const billId = crypto.randomUUID();

      /* Whichever source exists: a saved order, or the draft we just created
         one from. Reading openOrder here was the bug — on the one-tap path it
         is null by definition, so this threw before the try block and left the
         sheet stuck busy with nothing settled and no error shown. */
      const settled = openOrder?.lines || draft?.lines || [];
      const total = round2(
        settled.reduce((a, l) => a + l.price * l.qty, 0) * (1 - (discount || 0) / 100)
      );

      const res = await write(
        "order.close",
        { orderId, billId, method, paid, discount, payments, customer },
        (c) => api.closeBill(c, { orderId, billId, method, paid, discount, payments, customer })
      );

      setOpenTableId(null);
      setTakeaway(null);

      const tail = res === "queued" ? " (will sync)" : "";
      flash(paid
        ? `${table.label} — ${money(total, venue.currency)}${tail}`
        : `${table.label} closed unpaid${tail}`);

      // A cash sale needs its fiscal receipt now, not later.
      if (paid && res !== "queued" && venue.fiscalEnabled && venue.fiscalBridgeUrl) {
        printFiscal(billId);
      }
    } catch (e) {
      flash(e.message);
    } finally {
      setSheetBusy(false);
    }
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

  const [resetPreview, setResetPreview] = useState(null);
  const [resetBusy, setResetBusy] = useState(false);

  const openReset = useCallback(async () => {
    try { setResetPreview(await api.resetPreview(client, venue.id)); }
    catch (e) { flash(e.message); }
  }, [client, venue, flash]);

  const doReset = useCallback(async (confirm) => {
    setResetBusy(true);
    try {
      await api.resetBarData(client, venue.id, confirm);
      setResetPreview(null);
      await refresh();
      loadReports();
      flash("Cleared — open for real business");
    } catch (e) { flash(e.message); }
    finally { setResetBusy(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, venue, refresh, flash]);

  const [drawer, setDrawer] = useState(null);

  const refreshDrawer = useCallback(async () => {
    if (!client || !venue?.fiscalEnabled) return;
    try { setDrawer(await api.cashInDrawer(client, venue.id)); } catch { /* not critical */ }
  }, [client, venue]);

  /* Money into or out of the drawer. It is recorded on the device first — the
     printed slip is the legal record — and only then in our own books, so we
     never claim a movement the device never saw. */
  const doCash = useCallback(async (kind, amount, reason) => {
    if (!(amount > 0)) return flash("Enter an amount greater than zero");
    try {
      let ref = null;
      if (venue.fiscalBridgeUrl) {
        const r = await fiscal.cashMovement(venue.fiscalBridgeUrl, {
          kind, movementId: crypto.randomUUID(), amount, reason, currency: venue.currency,
        }, venue.fiscalBridgeToken);
        ref = r.receiptNo || null;
      }
      await api.recordCashMovement(client, venue.id, { kind, amount, reason, fiscalRef: ref });
      await refreshDrawer();
      flash(`${kind === "in" ? "Paid in" : "Paid out"} ${money(amount, venue.currency)}`);
    } catch (e) { flash(e.message); }
  }, [client, venue, flash, refreshDrawer]);

  const doDrawer = useCallback(async () => {
    try {
      await fiscal.openDrawer(venue.fiscalBridgeUrl, "change", venue.fiscalBridgeToken);
    } catch (e) { flash(e.message); }
  }, [venue, flash]);

  const doXReport = useCallback(async () => {
    try {
      await fiscal.xReport(venue.fiscalBridgeUrl, venue.fiscalBridgeToken);
      await refreshDrawer();
      flash("X report printed — the day is still open");
    } catch (e) { flash(e.message); }
  }, [venue, flash, refreshDrawer]);

  /* Z ends the day on the device and cannot be undone, so it asks first. */
  const doZReport = useCallback(async () => {
    try {
      const r = await fiscal.zReport(venue.fiscalBridgeUrl, venue.fiscalBridgeToken);
      await api.closeBusinessDay(client, venue.id, r.zNumber, r.device).catch(() => {});
      await refreshDrawer();
      flash(`Day closed — Z ${r.zNumber}`);
    } catch (e) { flash(e.message); }
  }, [client, venue, flash, refreshDrawer]);

  useEffect(() => { if (tab === "reports") refreshDrawer(); }, [tab, refreshDrawer]);

  const testPrinter = useCallback(async (cfg) => {
    try {
      const st = await fiscal.printerStatus(cfg.url, cfg.token);
      return st;
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }, []);


  /* ---- owner reports ---- */
  const [mode, setMode] = useState("day");
  const [anchor, setAnchor] = useState(() => new Date());
  const [report, setReport] = useState(null);
  const [unpaid, setUnpaid] = useState([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [products, setProducts] = useState([]);
  const [voids, setVoids] = useState(null);
  const [shift, setShift] = useState(null);
  const [cashingUp, setCashingUp] = useState(false);
  const [moving, setMoving] = useState(null);      // the table being moved
  const [prompt, setPrompt] = useState(null);     // { kind: 'float' | 'cash-in' | 'cash-out' | 'z' }
  const [stock, setStock] = useState(null);
  const [stockLoading, setStockLoading] = useState(false);

  const refreshShift = useCallback(async () => {
    if (!client || !venue || session?.role === "platform") return;
    try { setShift(await api.myShift(client, venue.id)); } catch { /* not critical */ }
  }, [client, venue, session]);

  useEffect(() => { refreshShift(); }, [refreshShift]);

  const loadStock = useCallback(async () => {
    if (!client || !venue || session?.role !== "owner") return;
    setStockLoading(true);
    try { setStock(await api.loadStock(client, venue.id)); }
    catch (e) { flash(e.message); }
    finally { setStockLoading(false); }
  }, [client, venue, session, flash]);

  // Price list needs the ingredient list too, for recipes.
  useEffect(() => {
    if (tab === "stock" || tab === "menu") loadStock();
  }, [tab, loadStock]);

  const [reorder, setReorder] = useState(null);
  const openReorder = useCallback(async () => {
    if (!client || !venue) return;
    try { setReorder(await api.loadReorder(client, venue.id)); }
    catch (e) { flash(e.message); }
  }, [client, venue, flash]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const range = useMemo(() => periodRange(mode, anchor), [mode, anchor]);

  const loadReports = useCallback(async () => {
    if (!client || !venue || session?.role !== "owner") return;
    setReportLoading(true); setProductsLoading(true);
    try {
      const [rep, un, prod, vd] = await Promise.all([
        api.loadReport(client, venue.id, range.from, range.to, mode === "day" ? "hour" : "day"),
        api.loadUnpaidBills(client, venue.id),
        api.loadProductsSold(client, venue.id, range.from, range.to),
        api.loadVoids(client, venue.id, range.from, range.to),
      ]);
      setReport(rep);
      setUnpaid(un);
      setProducts(prod || []);
      setVoids(vd || null);
    } catch (e) { flash(e.message); }
    finally { setReportLoading(false); setProductsLoading(false); }
  }, [client, venue, session, range.from, range.to, mode, flash]);

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
  }, [client, venue, printFiscal, flash, loadReports]);

  /* Declared here, below every callback and piece of state it reads.
     A dependency array is evaluated during render, so listing something
     declared further down is a temporal dead zone error — which is exactly
     what crashed the app on load. */
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
    changeOwnPin: async (cur, next) => {
      const ok = await guard((c) => api.changeOwnPin(c, cur, next), "PIN changed — use the new one next time");
      if (ok) loadSecurity();
      return ok;
    },
    saveBranding: (b) => guard((c) => api.setBranding(c, venue.id, b)),
    setLanguage: (code) => guard((c) => api.setLanguage(c, venue.id, code)),

    saveIngredient: async (v) => {
      const ok = await guard((c) => api.saveIngredient(c, venue.id, v), "Saved");
      if (ok) loadStock();
      return ok;
    },
    removeIngredient: async (id) => {
      const ok = await guard((c) => api.removeIngredient(c, id));
      if (ok) loadStock();
      return ok;
    },
    receiveDelivery: async (rows, note) => {
      const ok = await guard((c) => api.receiveDelivery(c, venue.id, rows, note),
        `${rows.length} received — costs updated`);
      if (ok) { loadStock(); refresh(); }
      return ok;
    },
    recordStocktake: async (rows, note) => {
      const res = await guard((c) => api.recordStocktake(c, venue.id, rows, note));
      if (res) {
        loadStock();
        const off = (res.lines || []).length;
        // The difference is the whole reason for counting, so say it out loud.
        flash(off
          ? `${off} ingredient${off > 1 ? "s" : ""} didn't match — ${money(Math.abs(Number(res.value) || 0), venue.currency)} of variance`
          : "Everything matched the books");
      }
      return res;
    },
    saveRecipe: (articleId, items) => guard((c) => api.saveRecipe(c, articleId, items)),
    linkArticleStock: async (articleId, pack, unitCost) => {
      const ok = await guard((c) => api.linkArticleStock(c, articleId, pack, unitCost));
      if (ok) loadStock();
      return ok;
    },
    unlinkArticleStock: async (articleId) => {
      const ok = await guard((c) => api.unlinkArticleStock(c, articleId));
      if (ok) loadStock();
      return ok;
    },

    startShift: () => setPrompt({ kind: "float" }),
    openShiftWith: async (amount) => {
      const ok = await guard((c) => api.openShift(c, venue.id, amount), "Shift started");
      if (ok) refreshShift();
      return ok;
    },
    endShift: async (declared, note) => {
      const res = await guard((c) => api.closeShift(c, shift.id, declared, note));
      if (res) { setShift(null); refreshShift(); }
      return res;
    },

    /* Named for what it does, not for what it moves. `moveTable` was already
       taken by the floor designer's drag handler, and a duplicate key in this
       object silently replaced it — dragging a table then called this and
       failed on a null `moving`. */
    // Takes the order id rather than finding it: no closure, nothing to go stale.
    transferTable: async (orderId, tableId) => {
      if (!orderId) return flash("Save the table first, then move it.");
      const ok = await guard((c) => api.transferOrder(c, orderId, tableId), "Table moved");
      if (ok) { setMoving(null); setOpenTableId(null); refresh(); }
      return ok;
    },
    mergeTable: async (fromOrderId, intoOrderId) => {
      if (!fromOrderId) return flash("Save the table first, then merge it.");
      const ok = await guard((c) => api.mergeOrders(c, fromOrderId, intoOrderId), "Tables merged");
      if (ok) { setMoving(null); setOpenTableId(null); refresh(); }
      return ok;
    },
    loadRecipe: (articleId) => api.loadRecipe(client, articleId).catch(() => null),
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
    // Every value these actions read has to be listed, or the closure keeps
    // whatever it saw when the memo last ran. That is exactly how "nothing to
    // move" appeared on a table with drinks on it.
  }), [guard, client, venue, flash, loadSecurity, loadStock, refresh, refreshShift,
       orders, moving?.tableId, shift?.id]);

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
      resetPreview: (v) => api.platformResetPreview(v.id).catch((e) => { flash(e.message); return null; }),
      resetBar: (v, confirm, force) => run(() => api.platformResetBar(v.id, confirm, force), `${v.name} cleared`),
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

  /* ---- the back button ----

     These must sit above the early returns below. React counts hooks per
     render, so a hook after a conditional return runs on some renders and not
     others — which is exactly error #310. */

  // Which tab counts as home depends on the role, worked out without touching
  // the tabs array, which is built after the early returns.
  const homeTab = session?.role === "platform" ? "bars" : "floor";
  useBackLayer(!!session && tab !== homeTab, () => setTab(homeTab));

  /* With nothing open, one press warns rather than closing. A tablet on a bar
     wall gets knocked, and losing the floor mid-service isn't acceptable. */
  useExitGuard(() => flash(t("Press back again to leave Backbar")));

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

  if (booting) return <Splash text={t("Starting up…")} />;

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
    ? [["floor", "Floor", LayoutGrid], ["design", "Floor designer", Copy], ["menu", "Price list", ListOrdered], ["reports", "Money", BarChart3], ["stock", "Stock", Package], ["team", "Team", Users], ["brand", "Branding", Palette]]
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

      {/* Sticky at top:0 means the viewport top, which on a notched phone is
          behind the status bar. The header carries the inset so its own
          background fills that strip. */}
      <header style={{ position: "sticky", top: 0, zIndex: 60,
        paddingTop: "env(safe-area-inset-top)",
        background: "rgba(10,20,17,0.92)", backdropFilter: "blur(10px)",
        borderBottom: `1px solid ${C.line}` }}>
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
          {/* Writes the queue gave up on. Loud on purpose: each one is usually
              a bill, and the bar is short that money until someone looks. */}
          {!isPlatform && failed.length > 0 && (
            <button onClick={() => setShowFailed(true)} title="These never reached the server" style={{
              display: "flex", alignItems: "center", gap: 7, padding: "6px 12px", borderRadius: 99,
              border: "1px solid rgba(212,103,74,0.55)", background: "rgba(212,103,74,0.12)", cursor: "pointer",
            }}>
              <AlertTriangle size={13} color={C.copper} />
              <span style={{ fontFamily: MONO, fontSize: 12, color: C.copper, fontWeight: 600 }}>
                {failed.length} not saved
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
              {serving ? t("Manage") : t("Serve")}
            </button>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 6px 5px 11px", borderRadius: 10, background: C.raise, border: `1px solid ${C.line}` }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.cream, lineHeight: 1.2 }}>{session.actorName}</div>
              <div style={{ fontSize: 10, color: serving ? C.brass : C.sageDim, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                {isPlatform ? "You" : isOwner ? (serving ? t("Serving") : t("Bar owner")) : t("Waiter")}
              </div>
            </div>
            <Btn size="sm" variant="bare" icon={LogOut} title={t("Sign out")} onClick={doSignOut} />
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
            <ShiftBar shift={shift} cur={venue.currency} busy={sheetBusy}
              onStart={barActions.startShift} onEnd={() => setCashingUp(true)} />

            <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
              <Btn size="sm" icon={ShoppingBag} variant="ghost"
                onClick={() => setTakeaway({ id: null, label: t("Takeaway"),
                                             orderId: crypto.randomUUID() })}>
                {t("Takeaway")}
              </Btn>
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
              <span style={{ marginLeft: "auto", fontFamily: SANS, fontSize: 12, color: C.sageDim }}>{t("Tap a table to take the order")}</span>
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
                onSelect={(id) => { setOpenOn("menu"); setOpenTableId(id); }}
                onMove={() => {}} currency={venue.currency} now={now} />
            )}

            {openHere.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <Eyebrow style={{ marginBottom: 10 }}>{t("Open bills")}</Eyebrow>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(190px,1fr))", gap: 10 }}>
                  {openHere.slice().sort((a, b) => a.openedAt - b.openedAt).map((o) => {
                    const tot = o.lines.reduce((s, l) => s + l.price * l.qty, 0);
                    const stale = now - o.openedAt > 75 * 60000;
                    const mine = o.staffId === session.actorId;
                    const z = zones.find((zz) => zz.tables.some((t) => t.id === o.tableId));
                    return (
                      <button key={o.id} onClick={() => {
                        setOpenOn("bill");
                        if (o.tableId) { if (z) setZoneId(z.id); setOpenTableId(o.tableId); }
                        // A takeaway has no table to open, so reopen it by id.
                        else setTakeaway({ id: null, label: o.tableLabel, orderId: o.id });
                      }} style={{
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
          <PriceList articles={articles} currency={venue.currency} actions={barActions}
            ingredients={(stock?.items || []).filter((i) => !i.is_article)} />
        )}
        {isOwner && currentTab === "reports" && (
          <Reports
            venue={venue} report={report} loading={reportLoading}
            products={products} productsLoading={productsLoading}
            mode={mode} setMode={setMode} anchor={anchor} setAnchor={setAnchor}
            unpaid={unpaid} onSettleUnpaid={settleUnpaid}
            onExport={exportCsv} exporting={exporting}
            actions={barActions} onTestPrinter={testPrinter} onRetryFiscal={retryFiscal}
            onReset={openReset} voids={voids} drawer={drawer}
            onCash={(kind) => setPrompt({ kind: kind === "in" ? "cash-in" : "cash-out" })}
            onDrawer={doDrawer}
            onX={doXReport} onZ={() => setPrompt({ kind: "z" })}
          />
        )}
        {isOwner && currentTab === "stock" && (
          <Stock venue={venue} stock={stock} loading={stockLoading} actions={barActions}
            onReorder={openReorder} />
        )}
        {isOwner && currentTab === "team" && (
          <Team venue={venue} staff={data.staff || []} events={securityEvents} flash={flash} actions={barActions} />
        )}
        {isOwner && currentTab === "brand" && (
          <Branding venue={venue} flash={flash} actions={barActions}
            onLanguage={(code) => { setLangState(code); barActions.setLanguage(code); }} />
        )}
      </main>

      {table && venue && (
        <OrderSheet
          table={table} zone={zone} venue={venue} order={openOrder} articles={articles} now={now}
          actorName={session.actorName}
          startOn={openOn}
          syncToken={sheetSync}
          canSeeCost={isOwner}
          canDiscount={isOwner || venue.allowStaffDiscount}
          busy={sheetBusy}
          onClose={() => { setOpenTableId(null); setTakeaway(null); }}
          onCommit={commitOrder}
          onSettle={settleOrder}
          onPayPart={payPart}
          onVoid={voidLine}
          onMove={() => setMoving({ tableId: table.id, label: table.label })}
        />
      )}

      {prompt?.kind === "float" && (
        <AmountPrompt
          title="Starting your shift" cur={venue?.currency} busy={sheetBusy}
          hint="How much is going into the drawer to start with? It's counted back at the end, so put 0 if there's no float."
          label="Opening float" confirmLabel="Start shift"
          onCancel={() => setPrompt(null)}
          onConfirm={async (amount) => {
            const ok = await barActions.openShiftWith(amount);
            if (ok) setPrompt(null);
          }} />
      )}

      {(prompt?.kind === "cash-in" || prompt?.kind === "cash-out") && (
        <AmountPrompt
          title={prompt.kind === "cash-in" ? "Money into the drawer" : "Money out of the drawer"}
          hint={prompt.kind === "cash-in"
            ? "A float, or change brought in. It's added to what the drawer should hold."
            : "A supplier paid in cash, or money banked. It comes off what the drawer should hold."}
          label="How much" note="What it's for" cur={venue?.currency} busy={sheetBusy}
          confirmLabel={prompt.kind === "cash-in" ? "Pay in" : "Pay out"}
          onCancel={() => setPrompt(null)}
          onConfirm={async (amount, reason) => {
            await doCash(prompt.kind === "cash-in" ? "in" : "out", amount, reason);
            setPrompt(null);
          }} />
      )}

      {prompt?.kind === "z" && (
        <Confirm
          danger title="Close the day on the printer?"
          body="This ends trading for today and can't be undone. Run an X report instead if you only want to see where the till stands."
          confirmLabel="Close the day" busy={sheetBusy}
          onCancel={() => setPrompt(null)}
          onConfirm={async () => { await doZReport(); setPrompt(null); }} />
      )}

      {reorder && (
        <ReorderSheet data={reorder} cur={venue?.currency} barName={venue?.name}
          flash={flash} onCancel={() => setReorder(null)} />
      )}

      {showFailed && failed.length > 0 && (
        <FailedWrites items={failed} cur={venue?.currency}
          onDismiss={dismissFailed} onClose={() => setShowFailed(false)} />
      )}

      {cashingUp && shift && (
        <CashUp shift={shift} cur={venue?.currency} busy={sheetBusy}
          onCancel={() => setCashingUp(false)}
          onConfirm={(declared, note) => barActions.endShift(declared, note)} />
      )}

      {moving && (
        <MoveTable from={moving} zones={zones} orders={orders} cur={venue?.currency} busy={sheetBusy}
          onCancel={() => setMoving(null)}
          onMove={barActions.transferTable} onMerge={barActions.mergeTable} />
      )}

      {resetPreview && (
        <ResetDialog
          preview={resetPreview} cur={venue?.currency} busy={resetBusy} canForce={false}
          onCancel={() => setResetPreview(null)} onConfirm={doReset}
        />
      )}

      <UpdateChip />

      {toast && (
        <div style={{
          position: "fixed", bottom: "calc(22px + env(safe-area-inset-bottom))", left: "50%", transform: "translateX(-50%)", zIndex: 200,
          background: C.raise, border: `1px solid ${C.brassDim}`, color: C.cream, padding: "11px 18px",
          borderRadius: 11, fontFamily: SANS, fontSize: 13, fontWeight: 600, maxWidth: "90vw", textAlign: "center",
          boxShadow: "0 10px 40px -10px rgba(0,0,0,0.8)",
        }}>{toast}</div>
      )}
    </div>
  );
}
