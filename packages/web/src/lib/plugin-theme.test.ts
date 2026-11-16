/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { PluginInfo, PluginThemeInfo } from "./api-plugins";
import {
  buildPluginThemeCss,
  enabledPluginGlobalCss,
  enabledPluginThemes,
  type PluginThemeEntry,
} from "./plugin-theme";

/** A plugin-theme fixture; vars default to a minimal two-token map. */
function theme(overrides: Partial<PluginThemeInfo> = {}): PluginThemeInfo {
  return {
    id: "moss",
    name: "Moss",
    kind: "dark",
    vars: { "--bg": "#0b1f0b", "--accent": "#7ad17a" },
    ...overrides,
  };
}

/** A discovered-plugin fixture with only the fields these helpers read. */
function plugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "p1",
    name: "Plugin One",
    version: "1.0.0",
    enabled: true,
    loaded: true,
    settingsSchema: null,
    settings: null,
    controlValues: null,
    ui: null,
    ...overrides,
  };
}

function entry(overrides: Partial<PluginThemeEntry> = {}): PluginThemeEntry {
  return { ...theme(), pluginName: "Plugin One", ...overrides };
}

describe("enabledPluginThemes", () => {
  it("collects themes from enabled, healthy plugins and attaches the plugin name", () => {
    const list = [
      plugin({ name: "Alpha", themes: [theme({ id: "moss", name: "Moss" })] }),
      plugin({ id: "p2", name: "Beta", themes: [theme({ id: "sand", name: "Sand" })] }),
    ];
    expect(enabledPluginThemes(list)).toEqual([
      {
        id: "moss",
        name: "Moss",
        kind: "dark",
        vars: { "--bg": "#0b1f0b", "--accent": "#7ad17a" },
        pluginName: "Alpha",
      },
      {
        id: "sand",
        name: "Sand",
        kind: "dark",
        vars: { "--bg": "#0b1f0b", "--accent": "#7ad17a" },
        pluginName: "Beta",
      },
    ]);
  });

  it("skips disabled plugins and plugins with an error", () => {
    const list = [
      plugin({ id: "off", name: "Off", enabled: false, themes: [theme({ id: "moss" })] }),
      plugin({ id: "broken", name: "Broken", error: "boom", themes: [theme({ id: "sand" })] }),
      plugin({ id: "healthy", name: "Healthy", themes: [theme({ id: "clay" })] }),
    ];
    expect(enabledPluginThemes(list).map((item) => item.id)).toEqual(["clay"]);
  });

  it("returns an empty list when no plugin contributes themes", () => {
    expect(enabledPluginThemes([plugin(), plugin({ id: "p2", themes: [] })])).toEqual([]);
    expect(enabledPluginThemes([])).toEqual([]);
  });

  it("flattens multiple themes from one plugin in declaration order", () => {
    const list = [plugin({ name: "Multi", themes: [theme({ id: "one" }), theme({ id: "two" })] })];
    expect(enabledPluginThemes(list).map((item) => item.id)).toEqual(["one", "two"]);
  });
});

describe("enabledPluginGlobalCss", () => {
  it("joins globalCss of enabled, healthy plugins with newlines", () => {
    const list = [
      plugin({ globalCss: ".a { color: red; }" }),
      plugin({ id: "p2", globalCss: ".b { color: blue; }" }),
    ];
    expect(enabledPluginGlobalCss(list)).toBe(".a { color: red; }\n.b { color: blue; }");
  });

  it("ignores disabled, broken, and stylesheet-less plugins", () => {
    const list = [
      plugin({ id: "off", enabled: false, globalCss: ".off { display: none; }" }),
      plugin({ id: "broken", error: "boom", globalCss: ".broken { display: none; }" }),
      plugin({ id: "empty", globalCss: "" }),
      plugin({ id: "none" }),
      plugin({ id: "on", globalCss: ".on { display: block; }" }),
    ];
    expect(enabledPluginGlobalCss(list)).toBe(".on { display: block; }");
  });

  it("returns an empty string when nothing contributes", () => {
    expect(enabledPluginGlobalCss([])).toBe("");
    expect(enabledPluginGlobalCss([plugin()])).toBe("");
  });
});

describe("buildPluginThemeCss", () => {
  it("emits one :root[data-theme] rule per theme with color-scheme from kind", () => {
    const css = buildPluginThemeCss([
      entry({ id: "moss", kind: "dark" }),
      entry({ id: "sand", name: "Sand", kind: "light" }),
    ]);
    expect(css).toBe(
      ':root[data-theme="moss"] { color-scheme: dark; --bg: #0b1f0b; --accent: #7ad17a }\n' +
        ':root[data-theme="sand"] { color-scheme: light; --bg: #0b1f0b; --accent: #7ad17a }',
    );
  });

  it("emits every var in insertion order, including decorative --bg-image", () => {
    const css = buildPluginThemeCss([
      entry({
        vars: {
          "--bg": "#171528",
          "--bg-image": "radial-gradient(#2b1a40 0%, #171528 100%)",
          "--accent": "#b48cf5",
        },
      }),
    ]);
    expect(css).toBe(
      ':root[data-theme="moss"] { color-scheme: dark; ' +
        "--bg: #171528; --bg-image: radial-gradient(#2b1a40 0%, #171528 100%); " +
        "--accent: #b48cf5 }",
    );
  });

  it("skips values that could break out of the declaration and keeps the rest", () => {
    const css = buildPluginThemeCss([
      entry({
        vars: {
          "--bg": "#0b1f0b",
          "--evil": "red } .x { color: blue",
          "--tag": "</style><script>alert(1)</script>",
          "--accent": "#7ad17a",
        },
      }),
    ]);
    expect(css).toContain("--bg: #0b1f0b");
    expect(css).toContain("--accent: #7ad17a");
    expect(css).not.toContain("--evil");
    expect(css).not.toContain("<script>");
    // The rule still closes exactly once, so the skipped tokens cannot have
    // spliced anything into the sheet.
    expect(css).toBe(
      ':root[data-theme="moss"] { color-scheme: dark; --bg: #0b1f0b; --accent: #7ad17a }',
    );
  });

  it("skips values that would unbalance the shared sheet's tokenizer", () => {
    // Every plugin theme rides in one <style>, so an unterminated comment,
    // string, paren or a spliced declaration from one theme would swallow or
    // rewrite the rules that follow it. Each bad token is dropped on its own
    // while its legitimate sibling still emits; the rule stays exactly closed.
    const cases = [
      "red /*", // unterminated comment: comments out the rest of the sheet
      'red "', // unterminated string: tokenizer runs past the rule
      "url(red", // unbalanced paren: nesting never closes
      "red; position: fixed", // spliced declaration onto the :root baseline
      "red */", // stray comment close: ends a comment it did not open
    ];
    for (const value of cases) {
      const css = buildPluginThemeCss([entry({ vars: { "--bad": value, "--good": "#7ad17a" } })]);
      expect(css, value).not.toContain("--bad");
      expect(css, value).toContain("--good: #7ad17a");
      expect(css, value).toBe(':root[data-theme="moss"] { color-scheme: dark; --good: #7ad17a }');
    }
  });

  it("keeps values with balanced parentheses", () => {
    // Parens are the rule's BALANCE, not their absence: color-mix and gradients
    // are exactly the values plugin themes are expected to carry.
    const value = "color-mix(in srgb, var(--accent) 32%, transparent)";
    const gradient = "radial-gradient(130% 115% at 12% -10%, #2b1a40 0%, #171528 100%)";
    const css = buildPluginThemeCss([
      entry({ vars: { "--badge": value, "--bg-image": gradient } }),
    ]);
    expect(css).toContain(`--badge: ${value}`);
    expect(css).toContain(`--bg-image: ${gradient}`);
    expect(css).toBe(
      ':root[data-theme="moss"] { color-scheme: dark; ' +
        `--badge: ${value}; --bg-image: ${gradient} }`,
    );
  });

  it("skips a token name that is not a custom-property identifier", () => {
    const css = buildPluginThemeCss([
      entry({
        vars: {
          "--bg": "#171528",
          "--x } body { color": "red",
          "not-a-token": "red",
          "--ok": "#b48cf5",
        },
      }),
    ]);
    expect(css).toContain("--bg: #171528");
    expect(css).toContain("--ok: #b48cf5");
    expect(css).not.toContain("body");
    expect(css).not.toContain("not-a-token");
    expect(css).toBe(
      ':root[data-theme="moss"] { color-scheme: dark; --bg: #171528; --ok: #b48cf5 }',
    );
  });

  it("omits color-scheme when kind is neither dark nor light", () => {
    // The loader validates kind, but this function is the last line of
    // defense: an unrecognized kind must not be interpolated raw. The cast
    // models a hostile plugin whose value slipped past that validation.
    const hostile = entry({ vars: { "--bg": "#0b1f0b" } });
    const css = buildPluginThemeCss([
      { ...hostile, kind: "dark; } body { color: red" } as unknown as PluginThemeEntry,
    ]);
    expect(css).not.toContain("body");
    expect(css).not.toContain("color-scheme");
    expect(css).toBe(':root[data-theme="moss"] { --bg: #0b1f0b }');
  });

  it("skips a theme whose id could break out of the attribute selector", () => {
    const css = buildPluginThemeCss([
      entry({ id: 'x"] { color: red } [data-theme="y' }),
      entry({ id: "safe" }),
    ]);
    expect(css).not.toContain("color: red");
    expect(css).toBe(
      ':root[data-theme="safe"] { color-scheme: dark; --bg: #0b1f0b; --accent: #7ad17a }',
    );
  });

  it("returns an empty string for an empty list", () => {
    expect(buildPluginThemeCss([])).toBe("");
  });
});
