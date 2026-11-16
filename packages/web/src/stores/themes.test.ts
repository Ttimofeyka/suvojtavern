/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginThemeEntry } from "../lib/plugin-theme";
import { contrastRatio } from "./design";
import { availablePluginThemes, isThemeId, registerPluginThemes, THEMES, themeKind } from "./theme";

/**
 * Contract test for styles/themes.css. The stylesheet is the source of truth
 * for the theme palette, but nothing else in the build links it to the theme
 * store, so a theme could ship half-defined or a store entry could point at a
 * missing block. This parses the stylesheet directly (a hand-rolled parser,
 * not a CSS library — the file is a flat list of custom-property blocks) and
 * pins three invariants:
 *
 *   1. every block defines the full token contract (no half-defined themes);
 *   2. the tokens stores/design.ts parses for its WCAG math stay `#rrggbb`;
 *   3. THEMES and the `data-theme` blocks list exactly the same ids, so the
 *      picker and the palette cannot drift apart.
 */

const CSS_PATH = join(import.meta.dir, "../styles/themes.css");

/**
 * Every token themes.css's header promises every theme block will define: the
 * documented 25 minus --bg-image, which only the gradient themes set and is
 * asserted on its own below. The defaults live in the bare `:root` block, so
 * a theme that omits one silently inherits midnight's value rather than
 * failing to parse — this list is what turns that inheritance into a test
 * failure. `--accent-hover`, `--msg-quote`, `--msg-em` and `--msg-underline`
 * are exactly that kind of hazard, so they must stay on it.
 */
const REQUIRED_TOKENS = [
  "--bg",
  "--bg-elev",
  "--bg-subtle",
  "--fg",
  "--fg-muted",
  "--fg-faint",
  "--accent",
  "--accent-hover",
  "--accent-fg",
  "--focus",
  "--border",
  "--border-strong",
  "--danger",
  "--success",
  "--warning",
  "--msg-quote",
  "--msg-em",
  "--msg-underline",
  "--badge-bg",
  "--badge-fg",
  "--shadow-card",
  "--shadow-deep",
  "--scrim",
  "--scrollbar",
] as const;

/**
 * The three tokens stores/design.ts reads back through normalizeHexColor
 * (pageBackground/pageSurfaces). A gradient placed in one of these — instead
 * of in --bg-image — would make that parse fail and silently swap the accent
 * math onto the wrong literal. The gradient themes must therefore keep these
 * concrete hex.
 *
 * These assertions parse the *source* stylesheet, which is the authored
 * contract. The production build minifies themes.css with lightningcss and
 * rewrites shortenable hex to the 3-digit form (#ffffff -> #fff), so the
 * runtime computed style may hold #fff; design.ts normalizes both forms via
 * normalizeHexColor, so this test pins what the author wrote, not the
 * minified output.
 */
const HEX_TOKENS = ["--bg", "--bg-elev", "--bg-subtle"] as const;

/**
 * Text tokens. These only have to be a resolvable color, not hex: daylight
 * and mist deliberately define --fg as `rgb(0 0 0 / 95%)` so the near-black
 * composites over the themed canvas. design.ts never parses them.
 */
const COLOR_TOKENS = ["--fg", "--fg-muted"] as const;

/** The blocks whose fg/muted must clear WCAG AA on every opaque surface. */
const CONTRAST_CHECKED = ["midnight", "nebula", "lagoon"] as const;

/** The gradient themes, i.e. the only blocks that may set --bg-image. */
const GRADIENT_THEMES = ["nebula", "lagoon"] as const;

const HEX = /^#[0-9a-f]{6}$/i;
const RGB = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*[\d.]+%?\s*\)$/i;

interface ThemeBlock {
  /** The explicit theme id, or "midnight" for the bare `:root` default. */
  id: string;
  selector: string;
  declarations: Map<string, string>;
}

/** Strip comments so the contract listing in the header cannot be mistaken for declarations. */
const CSS = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function parseThemeBlocks(css: string): ThemeBlock[] {
  const blocks: ThemeBlock[] = [];
  // Custom-property values here never contain braces, so a flat scan is exact.
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match = pattern.exec(css);
  while (match !== null) {
    const selector = match[1].trim();
    if (selector === ":root" || selector.includes(":root[data-theme=")) {
      const declarations = new Map<string, string>();
      for (const chunk of match[2].split(";")) {
        const colon = chunk.indexOf(":");
        if (colon === -1) {
          continue;
        }
        declarations.set(chunk.slice(0, colon).trim(), chunk.slice(colon + 1).trim());
      }
      // The default block lists `:root, :root[data-theme="midnight"]`; the
      // shared :root selector means the explicit id (or midnight) wins.
      const explicit = selector.match(/data-theme="([^"]+)"/);
      blocks.push({ id: explicit?.[1] ?? "midnight", selector, declarations });
    }
    match = pattern.exec(css);
  }
  return blocks;
}

/** Normalize a theme token to `#rrggbb`; null when it is not a color we understand. */
function colorToHex(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (HEX.test(value)) {
    return value.toLowerCase();
  }
  const rgb = value.match(RGB);
  if (!rgb) {
    return null;
  }
  return `#${[rgb[1], rgb[2], rgb[3]]
    .map((channel) => Number(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

const BLOCKS = parseThemeBlocks(CSS);

describe("themes.css contract", () => {
  it("parses one block per THEMES entry and no more", () => {
    expect(BLOCKS.length).toBe(THEMES.length);
    expect(BLOCKS.map((block) => block.id)).toEqual(THEMES.map((theme) => theme.id));
  });

  it("defines the full token set in every block", () => {
    for (const block of BLOCKS) {
      for (const token of REQUIRED_TOKENS) {
        expect(block.declarations.get(token), `${block.id} is missing ${token}`).toBeTruthy();
      }
    }
  });

  it("keeps the design.ts surface tokens as concrete hex in every block", () => {
    for (const block of BLOCKS) {
      for (const token of HEX_TOKENS) {
        expect(block.declarations.get(token), `${block.id} ${token}`).toMatch(HEX);
      }
    }
  });

  it("defines every text token as a resolvable color", () => {
    for (const block of BLOCKS) {
      for (const token of COLOR_TOKENS) {
        expect(colorToHex(block.declarations.get(token)), `${block.id} ${token}`).not.toBeNull();
      }
    }
  });

  it("sets --bg-image only on the gradient themes", () => {
    for (const block of BLOCKS) {
      const hasImage = block.declarations.has("--bg-image");
      expect(hasImage, `${block.id}`).toBe(
        (GRADIENT_THEMES as readonly string[]).includes(block.id),
      );
    }
  });

  it("clears WCAG AA for fg and muted text on every opaque surface", () => {
    for (const id of CONTRAST_CHECKED) {
      const block = BLOCKS.find((candidate) => candidate.id === id);
      expect(block, `missing ${id} block`).toBeDefined();
      const surfaces = HEX_TOKENS.map((token) => colorToHex(block?.declarations.get(token)));
      for (const token of COLOR_TOKENS) {
        const fg = colorToHex(block?.declarations.get(token));
        expect(fg, `${id} ${token}`).not.toBeNull();
        for (const surface of surfaces) {
          expect(surface, `${id} surface`).not.toBeNull();
          expect(
            contrastRatio(fg as string, surface as string),
            `${id} ${token} on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

/** A registry fixture; only the fields themeKind/availablePluginThemes read. */
function pluginTheme(overrides: Partial<PluginThemeEntry> = {}): PluginThemeEntry {
  return {
    id: "moss",
    name: "Moss",
    kind: "dark",
    vars: { "--bg": "#0b1f0b", "--accent": "#7ad17a" },
    pluginName: "Plugin One",
    ...overrides,
  };
}

describe("plugin-theme registry", () => {
  // The signals are module-level, so a registration would leak into this
  // file's other tests (and any suite sharing the module instance). Reset to
  // the pristine empty registry after every test; the built-in themes.css
  // contract above never reads the registry, so it stays unaffected either way.
  afterEach(() => {
    registerPluginThemes([]);
  });

  it("starts empty and grows with a registration", () => {
    expect(availablePluginThemes()).toEqual([]);
    registerPluginThemes([pluginTheme()]);
    expect(availablePluginThemes()).toEqual([pluginTheme()]);
  });

  it("replaces the registry rather than appending to it", () => {
    registerPluginThemes([pluginTheme({ id: "moss" }), pluginTheme({ id: "sand" })]);
    registerPluginThemes([pluginTheme({ id: "clay" })]);
    expect(availablePluginThemes().map((item) => item.id)).toEqual(["clay"]);
  });

  it("resolves the kind of every built-in theme", () => {
    for (const theme of THEMES) {
      expect(themeKind(theme.id), theme.id).toBe(theme.kind);
    }
  });

  it("resolves a registered plugin theme and returns null for an unregistered id", () => {
    registerPluginThemes([pluginTheme({ id: "moss", kind: "light" })]);
    expect(themeKind("moss")).toBe("light");
    expect(themeKind("gone")).toBeNull();
    expect(themeKind("MOSS")).toBeNull();
  });

  it("drops a plugin theme's kind once it is no longer registered", () => {
    registerPluginThemes([pluginTheme({ id: "moss" })]);
    expect(themeKind("moss")).toBe("dark");
    registerPluginThemes([]);
    expect(themeKind("moss")).toBeNull();
  });

  it("does not resolve Object.prototype members as theme kinds", () => {
    // `constructor` is valid kebab-case (isThemeId accepts it) and the server
    // stores it, so it reaches this lookup. A bare object read would return
    // Object's constructor here — a function where a kind belongs — which
    // defeats the stale-selection fallback and throws in design.ts's surface
    // math. The registry is empty, so every prototype member must be null.
    expect(themeKind("constructor")).toBeNull();
    expect(themeKind("toString")).toBeNull();
    expect(themeKind("hasOwnProperty")).toBeNull();
    expect(themeKind("__proto__")).toBeNull();
  });

  it("resolves a registered plugin theme whose id shadows a prototype member", () => {
    // A plugin theme legitimately named "constructor" must win over the
    // prototype: the own-property read sees the registry entry, not Object.
    registerPluginThemes([pluginTheme({ id: "constructor", kind: "light" })]);
    expect(themeKind("constructor")).toBe("light");
    // A sibling of that theme still resolves normally on the same map.
    registerPluginThemes([
      pluginTheme({ id: "constructor", kind: "light" }),
      pluginTheme({ id: "moss", kind: "dark" }),
    ]);
    expect(themeKind("constructor")).toBe("light");
    expect(themeKind("moss")).toBe("dark");
  });
});

describe("isThemeId", () => {
  it("accepts a kebab-case plugin id on shape alone", () => {
    // The stored theme hydrates before the plugin list arrives, so the id of a
    // not-yet-registered plugin theme must still be accepted.
    expect(isThemeId("moss")).toBe(true);
    expect(isThemeId("my-plugin-2")).toBe(true);
    expect(isThemeId("midnight")).toBe(true);
  });

  it("rejects garbage that could not be a theme id", () => {
    expect(isThemeId("has space")).toBe(false);
    expect(isThemeId("UpperCase")).toBe(false);
    expect(isThemeId("")).toBe(false);
    expect(isThemeId("semi;colon")).toBe(false);
    expect(isThemeId(42)).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
  });
});
