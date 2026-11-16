/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Theme Plugin — the living walkthrough of the appearance contribution API.
 *
 * Appearance is contributed declaratively on the definition, exactly like
 * sidebar items: plugins never ship frontend code, they declare palettes and
 * a stylesheet and the web client injects them. Full reference:
 * docs/PLUGINS.md ("Themes" / "Global stylesheet").
 *
 * This plugin demonstrates, with deliberately small code:
 *
 *   1. `themes` — two complete palettes, one `dark` and one `light`, that
 *      appear in Settings → Appearance next to the eight built-ins;
 *   2. the optional `--bg-image` decorative token, which is how a palette
 *      paints a gradient wash without breaking the client's WCAG math;
 *   3. `globalCss` — a raw stylesheet applied to the host document while the
 *      plugin is enabled.
 *
 * A theme is only APPLIED while both conditions hold: the user selected it
 * AND this plugin is enabled. Disabling the plugin withdraws its palettes
 * (the picker falls back to a built-in) and removes the stylesheet; the
 * plugin holds no server-side state, so it has nothing to do in `setup`.
 */
import { definePlugin, type PluginTheme } from "@suvoj/plugin-sdk";

/**
 * Evergreen — a cool forest dark, distinct from all eight built-ins (their
 * darks are warm charcoal, espresso brown, indigo, and nebula violet).
 *
 * The three surface tokens are the same relationship the built-ins use:
 * `--bg-elev` lighter than `--bg` (raised cards read as nearer the light),
 * `--bg-subtle` darker (recessed chrome). They are concrete `#rrggbb` hex
 * because the web client parses them out of the computed style for its
 * accent/badge contrast math — a gradient here would silently break it.
 *
 * `--fg` and `--fg-muted` both clear WCAG AA (>= 4.5:1) on every one of the
 * three surfaces; faint is the placeholder/disabled chrome, deliberately not
 * a text colour. The mint accent reads as text at ~9.3:1 on `--bg`.
 */
const evergreen: PluginTheme = {
  id: "evergreen",
  name: "Evergreen",
  kind: "dark",
  vars: {
    "--bg": "#121a16",
    // The one decorative token: a forest-green → cool-teal wash whose stops
    // sit within a few percent of `--bg`, so body copy keeps its contrast.
    // Painted through `--bg-image` (base.css), never through `--bg`.
    "--bg-image": `radial-gradient(
      130% 115% at 15% -10%,
      #1a2a1f 0%,
      color-mix(in srgb, #1a2a1f 45%, #121a16) 38%,
      #121a16 68%,
      #10201c 100%
    )`,
    "--bg-elev": "#1b2620",
    "--bg-subtle": "#0c1210",
    "--fg": "#e8efe9",
    "--fg-muted": "#a3b6a8",
    "--fg-faint": "#74857a",
    "--accent": "#5fd0a0",
    "--accent-hover": "#86dcb8",
    "--accent-fg": "#0d1a15",
    "--focus": "#5fd0a0",
    "--border": "rgb(220 245 230 / 12%)",
    "--border-strong": "rgb(220 245 230 / 19%)",
    "--danger": "#ef7a6a",
    "--success": "#5fd0a0",
    "--warning": "#e8b55f",
    "--msg-quote": "#e9a45c",
    "--msg-em": "#9aab9f",
    "--msg-underline": "#bfe8d6",
    "--badge-bg": "rgb(95 208 160 / 16%)",
    "--badge-fg": "#86dcb8",
    // The two shadow tokens are full multi-layer values, like the built-ins.
    // Split across lines for readability; CSS custom-property values may
    // contain newlines, and the injector emits the string verbatim.
    "--shadow-card":
      "rgb(3 10 6 / 24%) 0 4px 18px, rgb(3 10 6 / 18%) 0 2.025px 7.847px, " +
      "rgb(3 10 6 / 14%) 0 0.8px 2.925px, rgb(3 10 6 / 10%) 0 0.175px 1.041px",
    "--shadow-deep":
      "rgb(3 10 6 / 20%) 0 1px 3px, " +
      "rgb(3 10 6 / 24%) 0 3px 7px, " +
      "rgb(3 10 6 / 28%) 0 7px 15px, " +
      "rgb(3 10 6 / 32%) 0 14px 28px, " +
      "rgb(3 10 6 / 35%) 0 23px 52px",
    "--scrim": "rgb(3 10 6 / 60%)",
    "--scrollbar": "rgb(220 245 230 / 18%)",
  },
};

/**
 * Blush — a rosy light, distinct from the four built-in lights (Notion
 * white, cream/sepia, gray-blue, aqua). Same surface relationship as the
 * built-ins, mirrored for light: `--bg-elev` is the lightest (paper-white
 * cards), `--bg-subtle` a touch darker and rosier.
 *
 * The deep raspberry accent reads as text at ~5.7:1 on `--bg`; `--fg` and
 * `--fg-muted` clear AA on all three surfaces. No `--bg-image` here — the
 * flat canvas keeps the reference minimal, and the escape hatch is already
 * demonstrated above.
 */
const blush: PluginTheme = {
  id: "blush",
  name: "Blush",
  kind: "light",
  vars: {
    "--bg": "#f9f1f2",
    "--bg-elev": "#fffbfc",
    "--bg-subtle": "#f2e6e9",
    "--fg": "#3a2530",
    "--fg-muted": "#77545f",
    "--fg-faint": "#a98d96",
    "--accent": "#a8335f",
    "--accent-hover": "#8a2749",
    "--accent-fg": "#fffbfc",
    "--focus": "#a8335f",
    "--border": "rgb(58 37 48 / 12%)",
    "--border-strong": "rgb(58 37 48 / 20%)",
    "--danger": "#b3261e",
    "--success": "#0e756c",
    "--warning": "#96460a",
    "--msg-quote": "#9c4a05",
    "--msg-em": "#6d5a62",
    "--msg-underline": "#17714e",
    "--badge-bg": "rgb(168 51 95 / 12%)",
    "--badge-fg": "#8f2b53",
    "--shadow-card":
      "rgb(58 37 48 / 5%) 0 4px 18px, rgb(58 37 48 / 3%) 0 2.025px 7.847px, " +
      "rgb(58 37 48 / 2%) 0 0.8px 2.925px, rgb(58 37 48 / 1%) 0 0.175px 1.041px",
    "--shadow-deep":
      "rgb(58 37 48 / 2%) 0 1px 3px, " +
      "rgb(58 37 48 / 3%) 0 3px 7px, " +
      "rgb(58 37 48 / 3%) 0 7px 15px, " +
      "rgb(58 37 48 / 5%) 0 14px 28px, " +
      "rgb(58 37 48 / 6%) 0 23px 52px",
    "--scrim": "rgb(58 37 48 / 45%)",
    "--scrollbar": "rgb(58 37 48 / 22%)",
  },
};

export default definePlugin({
  id: "theme-plugin",
  name: "Theme Plugin",
  version: "0.1.0",
  description:
    "Adds two example palettes (Evergreen and Blush) to Settings → Appearance, " +
    "plus a small global stylesheet. Safe to keep enabled.",
  author: "SuvojTavern",

  // Contributed while the plugin is enabled; withdrawn on disable/error. Each
  // entry becomes its own `:root[data-theme="<id>"]` rule, so a user can pick
  // one independently of the built-ins.
  themes: [evergreen, blush],

  /**
   * A raw stylesheet applied to the host document while the plugin is
   * enabled. Unlike a drawer tab's `css`, this is NOT scoped: it targets the
   * whole page and can restyle ANYTHING — plugins are trusted local code
   * (see docs/PLUGINS.md "Error isolation guarantees"), so the API trusts you
   * to keep it tasteful. It disappears the moment the plugin is disabled.
   *
   * The selection tint derives from `var(--accent)`, so it follows whichever
   * palette the user picked (built-in or plugin) instead of hardcoding a
   * colour.
   */
  globalCss: `
    ::selection {
      background: color-mix(in srgb, var(--accent) 32%, transparent);
      color: var(--fg);
    }
  `,

  // A pure UI contribution: no hooks, strategies, or settings to register.
  // `setup` must exist (the host calls it on activation) but has nothing to
  // do beyond saying hello.
  setup(ctx) {
    ctx.log("themes ready — pick one in Settings → Appearance");
  },
});
