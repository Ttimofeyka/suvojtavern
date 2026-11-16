/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAtomValue } from "jotai";
import { renderTemplate } from "../../lib/tracker-template";
import { currentThemeAtom, themeKind } from "../../stores/theme";

/**
 * Renders a template + JSON inside a sandboxed iframe. The sandbox is the
 * EMPTY string — no scripts, no same-origin — so server/plugin-provided
 * markup and styles can never execute anything; `{{ }}` interpolation is
 * additionally HTML-escaped on top.
 *
 * The frame fills its container's available height; callers size the
 * wrapper. A malformed template surfaces as a visible error note inside
 * the frame instead of throwing out of the component.
 */

/**
 * The `--tf-*` palette the sandbox reads, paired with the APP THEME TOKEN each
 * entry derives from. Mapping the contract onto the live theme (instead of
 * shipping a fixed literal pair) is what makes the tracker follow every theme
 * rather than only its light/dark kind: Coffee's amber, Nebula's violet,
 * Daylight's cool grey and a plugin theme's own palette each repaint the card,
 * because the values are read out of the cascade the active theme sets.
 *
 * The two accent roles stay distinct in every theme: the scene border keeps the
 * warm gold/amber role (`--warning`), while the character border and name take
 * the accent, so a card never collapses into one hue. Two further tokens are
 * composed rather than mapped (see trackerPalette): the section well and the
 * pill edge.
 */
const TF_TOKENS: ReadonlyArray<readonly [name: string, source: string]> = [
  ["--tf-card-bg", "--bg-elev"],
  ["--tf-card-fg", "--fg"],
  ["--tf-card-border", "--border-strong"],
  ["--tf-section-border", "--border"],
  ["--tf-label", "--fg-muted"],
  ["--tf-section-name", "--fg-faint"],
  ["--tf-scene-accent", "--warning"],
  ["--tf-character-accent", "--accent"],
  ["--tf-character-name", "--badge-fg"],
  ["--tf-topic-fg", "--badge-fg"],
  ["--tf-topic-bg", "--badge-bg"],
];

/**
 * Per-kind fallbacks for a `--tf-*` whose source token the active theme does
 * not define — or for the boot window before a stylesheet lands. They are the
 * original dark game-UI values plus their light counterparts, so the frame is
 * always legible; a theme that defines its tokens never reaches them. These are
 * the only literals left: everything else comes from the theme.
 */
const PALETTE_FALLBACKS: Record<"dark" | "light", Record<string, string>> = {
  dark: {
    "--tf-card-bg": "#15171d",
    "--tf-card-fg": "#d8d5cd",
    "--tf-card-border": "#2b2f3a",
    "--tf-section-border": "#262a34",
    "--tf-scene-accent": "#8a7a4f",
    "--tf-character-accent": "#4f6a8a",
    "--tf-character-name": "#9fc2e8",
    "--tf-label": "#8b8fa3",
    "--tf-section-name": "#a9adc0",
    "--tf-topic-fg": "#c8b878",
    "--tf-topic-bg": "rgba(138, 122, 79, 0.12)",
    "--tf-topic-border": "rgba(138, 122, 79, 0.35)",
  },
  light: {
    "--tf-card-bg": "#fffdf8",
    "--tf-card-fg": "#2f2a22",
    "--tf-card-border": "#e3dccd",
    "--tf-section-border": "#e9e1d1",
    "--tf-scene-accent": "#a8894f",
    "--tf-character-accent": "#6a86a8",
    "--tf-character-name": "#2b5f8f",
    "--tf-label": "#6f6656",
    "--tf-section-name": "#5c5344",
    "--tf-topic-fg": "#7a5f1f",
    "--tf-topic-bg": "rgba(138, 122, 79, 0.14)",
    "--tf-topic-border": "rgba(138, 122, 79, 0.4)",
  },
};

/**
 * Strips characters that could terminate the injected declaration block or
 * close its <style> element. Token values are effectively author input (plugin
 * themes ride the same cascade) and are injected as raw CSS text, and no color
 * literal legitimately contains them.
 */
function sanitizeToken(value: string): string {
  return value.replace(/[;{}<>]/g, "").trim();
}

/** Reads one theme token off the live cascade (empty string when there is no document). */
function cssToken(name: string): string {
  if (typeof document === "undefined") {
    return "";
  }
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

/**
 * Builds the `--tf-*` block for the active theme. `read` is the token reader,
 * defaulting to the live computed style; it is injectable so the mapping and
 * its fallbacks can be pinned by a test without a DOM.
 */
export function trackerPalette(
  kind: "dark" | "light",
  read: (name: string) => string = cssToken,
): string {
  const fallbacks = PALETTE_FALLBACKS[kind];
  const literal = (name: string): string => fallbacks[name] ?? "";
  const from = (name: string, source: string): string =>
    sanitizeToken(read(source)) || literal(name);
  const tokens: Record<string, string> = {};
  for (const [name, source] of TF_TOKENS) {
    tokens[name] = from(name, source);
  }
  // Section wells carry a step OFF THE CARD, not a step into the page: the
  // app's own `--bg-subtle` is DEEPER than `--bg-elev` on dark themes, which
  // would punch near-black holes in the card and hide the section hairline.
  // Mixing the theme's own text color into the card reproduces the original
  // lighter-when-dark / darker-when-light relationship in every theme.
  tokens["--tf-section-bg"] =
    `color-mix(in srgb, ${tokens["--tf-card-fg"]} 7%, ${tokens["--tf-card-bg"]})`;
  // The pill edge: the theme's accent at border alpha. Derived rather than
  // mapped because no theme token carries "accent at N%" — --badge-bg is the
  // 14% tint the pill body already uses.
  const accent = sanitizeToken(read("--accent"));
  tokens["--tf-topic-border"] =
    accent === "" ? literal("--tf-topic-border") : `color-mix(in srgb, ${accent} 35%, transparent)`;
  return [
    ...TF_TOKENS.map(([name]) => `${name}:${tokens[name]}`),
    `--tf-section-bg:${tokens["--tf-section-bg"]}`,
    `--tf-topic-border:${tokens["--tf-topic-border"]}`,
  ].join(";");
}

/**
 * Minimal, inherit-free reset so the injected CSS starts from a clean slate.
 * The document paints nothing itself (transparent background) — the app's
 * surface shows through wherever the user CSS stops.
 *
 * `color-scheme` follows the ACTIVE theme's kind rather than pinning dark:
 * the sandbox is opaque to the app's own scrollbar styling, so without a
 * scheme an overflowing document would paint the browser's default (light)
 * scrollbars over a dark UI; deriving it keeps the scrollbars and any
 * `light-dark()` user CSS in step with the theme, and a light theme no longer
 * renders an opaque dark canvas behind a light card. User styles are injected
 * after the reset, so a preset can still override with its own CSS.
 */
function baseCss(kind: "dark" | "light"): string {
  const thumb = kind === "dark" ? "rgb(255 253 248 / 18%)" : "rgb(0 0 0 / 22%)";
  return (
    `html{color-scheme:${kind};scrollbar-width:thin;scrollbar-color:${thumb} transparent}` +
    `:root{${trackerPalette(kind)}}` +
    "::-webkit-scrollbar{width:8px;height:8px}" +
    `::-webkit-scrollbar-thumb{background:${thumb};border-radius:999px}` +
    "::-webkit-scrollbar-track{background:transparent}" +
    "html,body{margin:0;padding:0;font:14px/1.5 system-ui;background:transparent}" +
    "pre.template-frame-error{margin:0;padding:8px;color:var(--tf-card-fg,#d8d5cd);" +
    "white-space:pre-wrap;overflow-wrap:anywhere}"
  );
}

export function TemplateFrame(props: {
  html: string;
  css?: string;
  data: Record<string, unknown>;
  className?: string;
}) {
  // Subscribes to the selection so a theme switch recomposes the document
  // (React diffs `srcdoc` by value, so an unchanged document never touches the
  // DOM). An unknown/plugin-only id falls back to dark. This re-render is also
  // what repaints the frame: the palette is read off the live cascade, so the
  // theme's tokens are already the new ones by the time it runs.
  const theme = useAtomValue(currentThemeAtom);
  const kind = themeKind(theme) ?? "dark";

  // The composed document string is rebuilt on every render (cheap). It stays
  // byte-identical in shape to BASE_CSS + user css + body, with a failed render
  // swapped for an error note instead of throwing out of the component.
  let body = "";
  let error: string | null = null;
  try {
    body = renderTemplate(props.html, props.data);
  } catch (err) {
    error = err instanceof Error ? err.message : "Template rendering failed";
  }
  const srcDoc = [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    baseCss(kind),
    props.css ?? "",
    "</style></head><body>",
    error === null ? body : `<pre class="template-frame-error">${error}</pre>`,
    "</body></html>",
  ].join("");

  return (
    <iframe
      className={props.className}
      style={{
        width: "100%",
        height: "100%",
        border: "0",
        display: "block",
        background: "transparent",
      }}
      sandbox=""
      title="Rendered content"
      srcDoc={srcDoc}
    />
  );
}
