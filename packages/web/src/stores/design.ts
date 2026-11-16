/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { appStore } from "./store";
import { currentThemeAtom, pluginKindsAtom, themeKind } from "./theme";

/** Motion-intensity preference: scales every duration token. */
export type MotionIntensity = "off" | "subtle" | "full";

/** Surface-style preference: how app chrome and cards are painted. */
export type SurfaceStyle = "flat" | "elevated" | "glass" | "aero";

/** Backdrop-blur strength for the translucent surface styles. */
export type BlurStrength = "light" | "medium" | "heavy";

/** How opaque the frosted chrome is under the translucent surface styles. */
export type Translucency = "sheer" | "balanced" | "dense";

/** Font scale in percent; both knobs are continuous within these bounds. */
export const FONT_SCALE_MIN = 75;
export const FONT_SCALE_MAX = 150;
export const FONT_SCALE_DEFAULT = 100;

/**
 * The old six-step segmented presets, kept only to migrate values already
 * stored in the settings table. Each preset rounds its former multiplier to
 * the nearest whole percent (0.8125 -> 81, 0.875 -> 88, 1.125 -> 113).
 */
const LEGACY_FONT_PRESETS: Readonly<Record<string, number>> = Object.freeze({
  xsmall: 81,
  small: 88,
  medium: 100,
  large: 113,
  xlarge: 125,
  xxlarge: 150,
});

/** User-facing appearance preferences (see styles/design.css). */
export interface DesignState {
  /** Accent override as `#rrggbb`; null follows the theme default. */
  accent: string | null;
  motion: MotionIntensity;
  surfaces: SurfaceStyle;
  /** Glass/aero backdrop blur strength. */
  blur: BlurStrength;
  /** Glass/aero chrome opacity. */
  translucency: Translucency;
  /** Interface scale in percent: scales the whole app via the root font size. */
  uiFont: number;
  /** Chat text scale in percent: bubbles + composers, on top of `uiFont`. */
  chatFont: number;
}

/**
 * Canonical appearance defaults. Exported (and frozen) so the Appearance panel
 * resets to — and checks "already default" against — this exact object instead
 * of re-declaring a copy that could silently drift from the store.
 */
export const DEFAULT_DESIGN: Readonly<DesignState> = Object.freeze({
  accent: null,
  motion: "full",
  surfaces: "elevated",
  blur: "medium",
  translucency: "balanced",
  uiFont: FONT_SCALE_DEFAULT,
  chatFont: FONT_SCALE_DEFAULT,
});

/**
 * The whole appearance object. Components subscribe to this atom (or read it
 * through `useDesign()`); module-level code reads/writes it via `appStore`.
 * Every write replaces the object — Jotai notifies on reference change.
 */
export const designAtom = atom<DesignState>(DEFAULT_DESIGN);

/** Immutable field merge; the atom always holds a fresh object. */
function updateDesign(patch: Partial<DesignState>): void {
  appStore.set(designAtom, { ...appStore.get(designAtom), ...patch });
}

let initialized = false;
let touched = false;
let themeEffectStarted = false;

/** Inline custom properties written for an accent override, in removal order. */
const ACCENT_PROPERTIES = [
  "--accent",
  "--accent-hover",
  "--accent-fg",
  "--focus",
  "--badge-bg",
  "--badge-fg",
] as const;

/**
 * User-supplied accents are validated strictly with this 6-digit check.
 * Deliberately *not* normalized through normalizeHexColor below: the accent
 * picker always emits a full 6-digit hex, and every accent flows into
 * hexToRgb (via compositeOver/ensureContrast/readableForeground), whose
 * `parseInt(hex.slice(1), 16)` mis-parses a short form. Accepting `#fff` here
 * would feed that parser a wrong value, so storedDesign and setAccent keep the
 * strict gate — only the computed-style reads in pageBackground/pageSurfaces,
 * which force expansion through normalizeHexColor, tolerate the short form.
 */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A 3- or 6-digit CSS hex token, case-insensitive. */
const SHORT_OR_FULL_HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Normalize a CSS hex color token to full 6-digit lowercase `#rrggbb`,
 * accepting both `#rgb` and `#rrggbb` (case-insensitive); anything else
 * returns null.
 *
 * Why this exists: the production build minifies CSS with lightningcss, which
 * rewrites every shortenable hex to its shortest form (`#ffffff` -> `#fff`,
 * `#ff0000` -> `#f00`). The theme tokens read back from the computed style
 * therefore arrive 3-digit in a production build, and a strict 6-digit length
 * check would silently reject a perfectly valid theme color and swap in a
 * hardcoded kind-based surface (SURFACE_FALLBACKS). The 3-digit form must also
 * be *expanded*, not merely accepted: hexToRgb reads `hex.slice(1)` as one
 * integer, so a raw `#fff` would mis-parse as `#000fff`, not `#ffffff`.
 */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = SHORT_OR_FULL_HEX.exec(value);
  if (match === null) {
    return null;
  }
  const digits = (match[1] ?? "").toLowerCase();
  if (digits.length === 6) {
    return `#${digits}`;
  }
  // Length is 3 (the regex admits nothing else): double each nibble.
  const r = digits.charAt(0);
  const g = digits.charAt(1);
  const b = digits.charAt(2);
  return `#${r}${r}${g}${g}${b}${b}`;
}

function isMotion(value: unknown): value is MotionIntensity {
  return value === "off" || value === "subtle" || value === "full";
}

function isSurfaces(value: unknown): value is SurfaceStyle {
  return value === "flat" || value === "elevated" || value === "glass" || value === "aero";
}

function isBlur(value: unknown): value is BlurStrength {
  return value === "light" || value === "medium" || value === "heavy";
}

function isTranslucency(value: unknown): value is Translucency {
  return value === "sheer" || value === "balanced" || value === "dense";
}

/** Clamp an arbitrary number to a whole percent inside the supported range. */
function clampFontScale(value: number): number {
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(value)));
}

/**
 * Read a stored font scale. Numbers are rounded and clamped into range so a
 * hand-edited or out-of-date row still yields a usable size; the legacy preset
 * names map onto their former percentages. Anything else returns null so the
 * caller falls back to the default.
 */
function storedFontScale(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampFontScale(value);
  }
  if (typeof value === "string" && Object.hasOwn(LEGACY_FONT_PRESETS, value)) {
    return LEGACY_FONT_PRESETS[value] ?? null;
  }
  return null;
}

function readSetting(settings: unknown, key: string): unknown {
  if (typeof settings !== "object" || settings === null) {
    return null;
  }
  return (settings as Record<string, unknown>)[key] ?? null;
}

/** Merge an unknown stored value onto the defaults, tolerating null/bad shapes. */
export function storedDesign(value: unknown): DesignState {
  const next: DesignState = { ...DEFAULT_DESIGN };
  if (typeof value === "object" && value !== null) {
    const stored = value as Record<string, unknown>;
    if (
      stored.accent === null ||
      (typeof stored.accent === "string" && HEX_COLOR.test(stored.accent))
    ) {
      next.accent = stored.accent as string | null;
    }
    if (isMotion(stored.motion)) {
      next.motion = stored.motion;
    }
    if (isSurfaces(stored.surfaces)) {
      next.surfaces = stored.surfaces;
    }
    if (isBlur(stored.blur)) {
      next.blur = stored.blur;
    }
    if (isTranslucency(stored.translucency)) {
      next.translucency = stored.translucency;
    }
    const uiFont = storedFontScale(stored.uiFont);
    if (uiFont !== null) {
      next.uiFont = uiFont;
    }
    const chatFont = storedFontScale(stored.chatFont);
    if (chatFont !== null) {
      next.chatFont = chatFont;
    }
  }
  return next;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((channel) => clampByte(channel).toString(16).padStart(2, "0")).join("")}`;
}

/** One WCAG relative-luminance channel (sRGB -> linear). */
function linearize(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 = black, 1 = white). */
function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** Mix a hex toward white (amount > 0) or black (amount < 0) by `amount`. */
export function shade(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const target = amount >= 0 ? 255 : 0;
  const mix = Math.abs(amount);
  return rgbToHex({
    r: r + (target - r) * mix,
    g: g + (target - g) * mix,
    b: b + (target - b) * mix,
  });
}

/**
 * Alpha-composite `tint` over an opaque `base` at `tintAmount` (0..1) and
 * return `#rrggbb`. This mirrors how a `color-mix(in srgb, tint N%, transparent)`
 * layer actually paints once it sits on top of `base`, which is what the
 * badge's foreground has to clear — the tint, not the page, is the real
 * background there. `tintAmount` is clamped to 0..1.
 */
export function compositeOver(tint: string, tintAmount: number, base: string): string {
  const { r: tr, g: tg, b: tb } = hexToRgb(tint);
  const { r: br, g: bg, b: bb } = hexToRgb(base);
  const mix = Math.max(0, Math.min(1, tintAmount));
  return rgbToHex({
    r: tr * mix + br * (1 - mix),
    g: tg * mix + bg * (1 - mix),
    b: tb * mix + bb * (1 - mix),
  });
}

/** WCAG contrast ratio between two colors, from 1 (identical) to 21 (black/white). */
export function contrastRatio(a: string, b: string): number {
  const luminanceA = relativeLuminance(hexToRgb(a));
  const luminanceB = relativeLuminance(hexToRgb(b));
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

const CONTRAST_STEPS = 100;

/**
 * Alpha fraction of the raw accent in `--badge-bg` (see applyAccent). This is
 * the single source of truth for the tint percentage; the emitted color-mix
 * literal is derived from it so the two cannot drift.
 */
const BADGE_TINT = 0.14;

/**
 * Nudge `fg` toward black or white — whichever endpoint reaches the higher
 * contrast against `bg` — until it clears `min`. The raw accent is fine as a
 * fill, but an accent used as *text* (links, badge labels) or as the focus
 * ring has to clear WCAG AA against the page. Returns `fg` unchanged when it
 * already passes, and the endpoint color when even that cannot reach `min`
 * (only possible if `min` exceeds 21 or the inputs are malformed).
 */
export function ensureContrast(fg: string, bg: string, min: number): string {
  if (contrastRatio(fg, bg) >= min) {
    return fg;
  }
  const towardBlack = contrastRatio("#000000", bg);
  const towardWhite = contrastRatio("#ffffff", bg);
  const direction = towardBlack >= towardWhite ? -1 : 1;
  for (let step = 1; step <= CONTRAST_STEPS; step++) {
    const candidate = shade(fg, (direction * step) / CONTRAST_STEPS);
    if (contrastRatio(candidate, bg) >= min) {
      return candidate;
    }
  }
  return direction < 0 ? "#000000" : "#ffffff";
}

const DARK_ACCENT_FG = "#111111";
const DARK_ACCENT_FG_LUMINANCE = relativeLuminance(hexToRgb(DARK_ACCENT_FG));

/**
 * Pick the accent's foreground by whichever of white/#111111 has the higher
 * WCAG contrast ratio. A plain luminance midpoint would hand light-blue and
 * periwinkle accents (the common ones) unreadable white text.
 */
export function readableForeground(accent: string): string {
  const luminance = relativeLuminance(hexToRgb(accent));
  const whiteContrast = 1.05 / (luminance + 0.05);
  const darkContrast = (luminance + 0.05) / (DARK_ACCENT_FG_LUMINANCE + 0.05);
  return whiteContrast >= darkContrast ? "#ffffff" : DARK_ACCENT_FG;
}

/**
 * The active theme's page background as a `#rrggbb` hex, for contrast math.
 * Themes define `--bg` as a concrete hex, so the computed value is usable
 * directly once normalized (see normalizeHexColor — the production minifier
 * shortens it to 3 digits); the kind-based literal is only a defensive
 * fallback for a missing or non-hex value (e.g. no stylesheet loaded yet).
 */
function pageBackground(kind: "dark" | "light"): string {
  if (typeof document !== "undefined") {
    const value = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    const normalized = normalizeHexColor(value);
    if (normalized !== null) {
      return normalized;
    }
  }
  return kind === "dark" ? "#1e1d1b" : "#ffffff";
}

/** Per-kind fallbacks for the opaque surfaces, in `--bg`/`--bg-elev`/`--bg-subtle` order. */
const SURFACE_FALLBACKS: Record<"dark" | "light", readonly [string, string, string]> = {
  dark: ["#1e1d1b", "#262522", "#2a2926"],
  light: ["#ffffff", "#ffffff", "#f4f3f1"],
};

/**
 * The active theme's opaque page surfaces as `#rrggbb` hex, in
 * `--bg`/`--bg-elev`/`--bg-subtle` order. Badges and pills are painted on any
 * of them, so the badge foreground is validated against all three. Each token
 * is read from the computed style and normalized by normalizeHexColor, which
 * accepts the minifier's 3-digit form and expands it (a strict 6-digit check
 * would reject it and fall back to a kind-based literal); a missing or non-hex
 * value falls back to a kind-based literal (e.g. no stylesheet loaded yet).
 */
export function pageSurfaces(kind: "dark" | "light"): string[] {
  const style = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const names = ["--bg", "--bg-elev", "--bg-subtle"] as const;
  const fallbacks = SURFACE_FALLBACKS[kind];
  return names.map((name, index) => {
    const value = style?.getPropertyValue(name).trim() ?? "";
    return normalizeHexColor(value) ?? fallbacks[index] ?? fallbacks[0];
  });
}

/** The current theme id; the theme atom is what the accent subscriptions watch. */
function currentThemeId(): string {
  return appStore.get(currentThemeAtom);
}

/** Re-resolve the accent from the current theme id and kind. */
function applyCurrentAccent(): void {
  const themeId = currentThemeId();
  applyAccent(themeId, themeKind(themeId) ?? "dark");
}

/**
 * Mirror the accent preference onto documentElement as inline custom
 * properties. `null` removes them so the active theme's own accent (and its
 * hand-tuned hover/foreground) applies again. The hover variant and the
 * accent foreground depend on the theme kind, so this must be re-run whenever
 * the theme changes.
 *
 * `kind` is passed in rather than looked up here: built-in palettes carry it
 * in THEMES, but plugin themes only expose it through the registry
 * (themeKind), and this function must not subscribe to anything — its callers
 * own the reactivity (see ensureThemeReactivity). The `_themeId` parameter is
 * kept in the signature because it documents which theme the derived accent
 * belongs to at each call site; the math itself only needs the kind.
 */
function applyAccent(_themeId: string, kind: "dark" | "light"): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const accent = appStore.get(designAtom).accent;
  if (accent === null) {
    for (const property of ACCENT_PROPERTIES) {
      root.style.removeProperty(property);
    }
    return;
  }
  const page = pageBackground(kind);
  // The raw accent paints the badge tint, but the accent-as-text roles below
  // need WCAG AA against the page background or a light accent vanishes on a
  // light theme.
  const textAccent = ensureContrast(accent, page, 4.5);
  root.style.setProperty("--accent", textAccent);
  // Hover is a shade of the text-safe accent (not the raw one), then re-checked:
  // the hover background still carries --accent-fg, which was paired with
  // textAccent, so it must stay just as readable.
  const hoverAccent = ensureContrast(shade(textAccent, kind === "dark" ? 0.12 : -0.1), page, 4.5);
  root.style.setProperty("--accent-hover", hoverAccent);
  root.style.setProperty("--focus", textAccent);
  // The badge paints --badge-fg on the accent tint composited over whatever
  // surface it sits on. Badges appear on --bg, --bg-elev and --bg-subtle, so
  // validate against the composite that yields the LOWEST contrast and clear
  // AA against that worst case.
  const badgeSurfaces = pageSurfaces(kind).map((surface) =>
    compositeOver(accent, BADGE_TINT, surface),
  );
  const worstBadgeBg = badgeSurfaces.reduce((worst, surface) =>
    contrastRatio(textAccent, surface) < contrastRatio(textAccent, worst) ? surface : worst,
  );
  root.style.setProperty("--badge-fg", ensureContrast(textAccent, worstBadgeBg, 4.5));
  // Custom properties may hold color-mix expressions; the literal string is
  // resolved by the browser when the token is consumed. The percentage is
  // derived from BADGE_TINT so the two cannot drift.
  root.style.setProperty(
    "--badge-bg",
    `color-mix(in srgb, ${accent} ${Math.round(BADGE_TINT * 100)}%, transparent)`,
  );
  // --accent-fg is text placed on the --accent fill, so it pairs with the
  // text-safe accent that actually paints that background.
  root.style.setProperty("--accent-fg", readableForeground(textAccent));
}

/** Mirror motion/surfaces/blur/translucency onto data attributes, the two font
 *  scales onto custom properties, and (re)apply the accent. */
function apply(): void {
  if (typeof document === "undefined") {
    return;
  }
  const design = appStore.get(designAtom);
  const root = document.documentElement;
  root.dataset.motion = design.motion;
  root.dataset.surfaces = design.surfaces;
  root.dataset.blur = design.blur;
  root.dataset.translucency = design.translucency;
  // The font knobs are continuous, so they cannot map onto a fixed set of
  // attribute rules: write the multipliers inline (they always overwrite the
  // token defaults, so switching back to 100% cannot leave a stale value).
  root.style.setProperty("--ui-scale", String(design.uiFont / 100));
  root.style.setProperty("--chat-scale", String(design.chatFont / 100));
  applyCurrentAccent();
}

/**
 * Re-apply the accent whenever the theme changes (the dark/light kind flips
 * the derived hover and foreground), and whenever the plugin-theme registry
 * changes (registering or dropping a plugin theme can change the kind of the
 * currently selected id). Subscriptions are app-lifetime: created lazily on
 * first use and never torn down, matching the store they mirror, with the
 * `themeEffectStarted` guard preventing a second subscription (HMR re-import
 * or React StrictMode double-invoke). The callback reads the design accent
 * directly rather than subscribing to it, so setAccent does not double-apply;
 * only the theme id and its resolved kind drive re-runs — the same two inputs
 * the Solid effect tracked.
 */
function ensureThemeReactivity(): void {
  if (themeEffectStarted || typeof document === "undefined") {
    return;
  }
  themeEffectStarted = true;
  // Jotai's store.sub has no fireImmediately option, so the body is invoked
  // once directly — matching the old createEffect, which ran on creation.
  appStore.sub(currentThemeAtom, applyCurrentAccent);
  applyCurrentAccent();
  appStore.sub(pluginKindsAtom, applyCurrentAccent);
}

/**
 * Persist the whole appearance object; failures are ignored. Writes are
 * trailing-debounced because the font sliders emit a change on every pixel of
 * a drag: coalescing keeps one PUT per settled value instead of dozens, and
 * the last write always carries the final appearance object.
 */
const PERSIST_DELAY_MS = 180;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persist(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appearance: { ...appStore.get(designAtom) } }),
    }).catch(() => {});
  }, PERSIST_DELAY_MS);
}

/**
 * Design-preferences store. The first call applies the defaults synchronously
 * (data attributes plus any stored accent) and then hydrates from
 * GET /api/settings; mutations persist the whole `appearance` object
 * (fire-and-forget). If the user interacts before hydration finishes, the
 * stored value is skipped so it cannot clobber their edits.
 *
 * `setAppearance` is the multi-knob path: it writes the patch, reapplies and
 * persists exactly once, so the one PUT it issues carries the complete final
 * state (see the inline note on its type).
 */
export function useDesign(): {
  design: DesignState;
  setAccent(value: string | null): void;
  setMotion(value: MotionIntensity): void;
  setSurfaces(value: SurfaceStyle): void;
  setBlur(value: BlurStrength): void;
  setTranslucency(value: Translucency): void;
  setUiFont(value: number): void;
  setChatFont(value: number): void;
  /**
   * Apply several knobs in ONE update/apply/persist cycle. Needed by
   * resetAppearance: the individual setters each fire an independent
   * fire-and-forget whole-object PUT, so calling seven of them lets the
   * requests land out of order and persist a mix of old and new values. A
   * multi-field patch is validated as a unit — a bad accent rejects the
   * whole patch, matching setAccent's "never reach hexToRgb" gate.
   */
  setAppearance(patch: Partial<DesignState>): void;
} {
  // Subscribe so the returned snapshot is reactive and the setters below are
  // called on a re-rendered component.
  const design = useAtomValue(designAtom);

  if (!initialized) {
    initialized = true;
    apply();
    ensureThemeReactivity();
    fetch("/api/settings")
      .then((response) => (response.ok ? response.json() : null))
      .then((settings: unknown) => {
        if (touched) {
          return;
        }
        appStore.set(designAtom, storedDesign(readSetting(settings, "appearance")));
        apply();
      })
      .catch(() => {});
  }

  return {
    design,
    setAccent(value: string | null) {
      // Mirror the stored-value gate: a bad string must never reach hexToRgb.
      if (value !== null && !HEX_COLOR.test(value)) {
        return;
      }
      touched = true;
      updateDesign({ accent: value });
      apply();
      persist();
    },
    setMotion(value: MotionIntensity) {
      touched = true;
      updateDesign({ motion: value });
      apply();
      persist();
    },
    setSurfaces(value: SurfaceStyle) {
      touched = true;
      updateDesign({ surfaces: value });
      apply();
      persist();
    },
    setBlur(value: BlurStrength) {
      touched = true;
      updateDesign({ blur: value });
      apply();
      persist();
    },
    setTranslucency(value: Translucency) {
      touched = true;
      updateDesign({ translucency: value });
      apply();
      persist();
    },
    setUiFont(value: number) {
      touched = true;
      updateDesign({ uiFont: clampFontScale(value) });
      apply();
      persist();
    },
    setChatFont(value: number) {
      touched = true;
      updateDesign({ chatFont: clampFontScale(value) });
      apply();
      persist();
    },
    setAppearance(patch: Partial<DesignState>) {
      // Mirror the stored-value gate: a bad string must never reach hexToRgb.
      if (patch.accent !== undefined && patch.accent !== null && !HEX_COLOR.test(patch.accent)) {
        return;
      }
      touched = true;
      updateDesign(patch);
      apply();
      // One PUT for the whole patch — see the interface note above.
      persist();
    },
  };
}
