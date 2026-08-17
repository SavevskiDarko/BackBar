/* ===========================================================================
   Per-bar branding.

   A bar owner gets their logo and their accent colour, so staff open the app
   and see their own place rather than ours. What they don't get is free rein
   over the whole palette — a dim room needs a dark surface and a legible
   accent, and "pick any two colours" reliably produces something unreadable.

   So: the surface comes from a small set of designed pairings, the accent is
   free, and the text colour that sits ON the accent is computed rather than
   chosen. Everything is applied as CSS custom properties, which is why the
   several hundred style props in App.jsx didn't need touching.
   =========================================================================== */

export const SURFACES = {
  bottle: {
    name: "Bottle green",
    ink: "#0A1411", panel: "#101D18", raise: "#16261F",
    line: "#23392F", line2: "#2F4C40",
    cream: "#F4EDDF", creamDim: "#CFC4AC", sage: "#8CA69B", sageDim: "#5C736A",
  },
  midnight: {
    name: "Midnight blue",
    ink: "#0A1018", panel: "#101823", raise: "#16202E",
    line: "#22303F", line2: "#2E4054",
    cream: "#EFF2F7", creamDim: "#C3CBD8", sage: "#8C9BB0", sageDim: "#5B6878",
  },
  charcoal: {
    name: "Charcoal",
    ink: "#101011", panel: "#181819", raise: "#202022",
    line: "#2C2C2E", line2: "#3C3C40",
    cream: "#F2F1EF", creamDim: "#C9C7C3", sage: "#9A9894", sageDim: "#67655F",
  },
  espresso: {
    name: "Espresso",
    ink: "#12100D", panel: "#1B1814", raise: "#241F1A",
    line: "#332C24", line2: "#463C31",
    cream: "#F6EFE4", creamDim: "#D2C6B4", sage: "#A79883", sageDim: "#726555",
  },
};

export const DEFAULT_BRAND = { surface: "bottle", accent: "#E6B450" };

/* A handful of accents that actually work on a dark surface. Owners can enter
   any hex, but most people would rather pick than fiddle. */
export const ACCENT_SUGGESTIONS = [
  "#E6B450", // brass
  "#E0733D", // amber
  "#D95757", // red
  "#C9629B", // rose
  "#8E7CD8", // violet
  "#4FA3D9", // sky
  "#3FBFA0", // teal
  "#8CBF3F", // olive
];

const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const toHex = ({ r, g, b }) =>
  "#" + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, "0")).join("");

/** WCAG relative luminance. Used to decide what colour of text can sit on the
    accent, and whether the accent is bright enough to read against the ink. */
export function luminance(hex) {
  const c = parseHex(hex);
  if (!c) return 0;
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const mix = (hex, target, amount) => {
  const c = parseHex(hex), t = parseHex(target);
  if (!c || !t) return hex;
  return toHex({
    r: c.r + (t.r - c.r) * amount,
    g: c.g + (t.g - c.g) * amount,
    b: c.b + (t.b - c.b) * amount,
  });
};

const rgba = (hex, a) => {
  const c = parseHex(hex);
  return c ? `rgba(${c.r},${c.g},${c.b},${a})` : hex;
};

/** Everything the UI needs, derived from a surface key plus one accent. */
export function buildTheme(brand) {
  const surface = SURFACES[brand?.surface] || SURFACES[DEFAULT_BRAND.surface];
  let accent = parseHex(brand?.accent) ? brand.accent : DEFAULT_BRAND.accent;

  // An accent that can't be read against the surface is worse than no branding.
  // Lift it towards the surface's text colour until it clears a usable ratio.
  let guard = 0;
  while (contrast(accent, surface.ink) < 3.5 && guard++ < 12) {
    accent = mix(accent, surface.cream, 0.12);
  }

  // Text sitting on a filled accent button: dark on a light accent, light on a
  // dark one. Chosen by luminance rather than by the owner, who can't be
  // expected to think about it.
  const onAccent = luminance(accent) > 0.42 ? "#14100A" : "#FFFFFF";

  return {
    ...surface,
    accent,
    accentDim: mix(accent, surface.ink, 0.45),
    onAccent,
    lineFade: rgba(surface.line, 0.33),
    alphas: [0.05, 0.07, 0.08, 0.1, 0.12, 0.16, 0.2, 0.35, 0.45, 0.5, 0.55]
      .reduce((acc, a) => {
        acc[String(a).replace("0.", "")] = rgba(accent, a);
        return acc;
      }, {}),
    glow: rgba(accent, 0.45),
    glowSoft: rgba(accent, 0.2),
  };
}

/** Push the theme onto :root. Inline styles read these through var(). */
export function applyTheme(brand) {
  if (typeof document === "undefined") return;
  const t = buildTheme(brand);
  const r = document.documentElement.style;

  r.setProperty("--ink", t.ink);
  r.setProperty("--panel", t.panel);
  r.setProperty("--raise", t.raise);
  r.setProperty("--line", t.line);
  r.setProperty("--line2", t.line2);
  r.setProperty("--line-fade", t.lineFade);
  r.setProperty("--cream", t.cream);
  r.setProperty("--cream-dim", t.creamDim);
  r.setProperty("--sage", t.sage);
  r.setProperty("--sage-dim", t.sageDim);
  r.setProperty("--accent", t.accent);
  r.setProperty("--accent-dim", t.accentDim);
  r.setProperty("--on-accent", t.onAccent);
  r.setProperty("--glow", t.glow);
  r.setProperty("--glow-soft", t.glowSoft);
  for (const [k, v] of Object.entries(t.alphas)) r.setProperty(`--accent-${k}`, v);

  // The browser chrome and the installed app's splash follow the surface.
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.ink);
  document.body.style.background = t.ink;

  return t;
}

/* Branding travels with the device pairing so the PIN screen is already the
   bar's own before anyone signs in — which is the moment it matters most. */
const BRAND_KEY = "backbar.brand";

export function rememberBrand(brand) {
  try { localStorage.setItem(BRAND_KEY, JSON.stringify(brand || DEFAULT_BRAND)); } catch { /* ignore */ }
}
export function recallBrand() {
  try {
    return JSON.parse(localStorage.getItem(BRAND_KEY) || "null") || DEFAULT_BRAND;
  } catch {
    return DEFAULT_BRAND;
  }
}
