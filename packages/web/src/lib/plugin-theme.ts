/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginInfo, PluginThemeInfo } from "./api-plugins";

/**
 * Plugin-theme plumbing, kept pure and DOM-free so it is unit-testable
 * without a browser: which themes a plugin list contributes, and the CSS text
 * that declares them. The store (stores/plugin-theme.ts) is the only caller
 * that touches the document.
 */

/** A plugin theme plus the display name of the plugin that contributed it. */
export interface PluginThemeEntry extends PluginThemeInfo {
  pluginName: string;
}

/**
 * The one contribution filter: a disabled plugin contributes nothing, and a
 * broken one (import/validation/setup failure) contributes nothing even while
 * its toggle still works. Mirrors components/Sidebar.tsx exactly; kept here as
 * a shared predicate so the theme and stylesheet paths cannot drift.
 */
function healthyPlugins(plugins: PluginInfo[]): PluginInfo[] {
  return plugins.filter((plugin) => plugin.enabled && plugin.error == null);
}

/** Themes from enabled, healthy plugins, tagged with their contributing plugin. */
export function enabledPluginThemes(plugins: PluginInfo[]): PluginThemeEntry[] {
  return healthyPlugins(plugins).flatMap((plugin) =>
    (plugin.themes ?? []).map((theme) => ({ ...theme, pluginName: plugin.name })),
  );
}

/**
 * globalCss of every enabled, healthy plugin, joined with "\n". Plugins
 * without a stylesheet (or with an empty one) contribute no separator, so the
 * result is "" when nothing is enabled and never has leading/trailing blanks.
 */
export function enabledPluginGlobalCss(plugins: PluginInfo[]): string {
  return healthyPlugins(plugins)
    .map((plugin) => plugin.globalCss ?? "")
    .filter((css) => css !== "")
    .join("\n");
}

/**
 * Shapes that let a custom-property value escape its declaration and corrupt
 * the injected sheet. Every plugin theme shares ONE `<style>` element, so a
 * value that unbalances the tokenizer does not just ruin its own rule — it
 * swallows or rewrites every rule after it, i.e. one plugin's bad value
 * silently deletes all other plugins' themes. Each rejected class is
 * structural, not stylistic:
 *
 *   - `{`/`}` open or close a rule, splicing selectors/declarations;
 *   - `<` opens a bogus tag when the sheet text is re-parsed as markup;
 *   - `;` ends the declaration, so `red; position: fixed` splices a new
 *     declaration onto `:root`;
 *   - the comment open and close sequences toggle comment state: an
 *     unterminated opener (`red /*`) runs the tokenizer past the end of this
 *     rule and comments out the rest of the sheet (all following themes),
 *     while a stray closer ends a comment the value did not open;
 *   - `"`/`'` open a string, which the tokenizer runs past the rule.
 *
 * Parentheses are deliberately NOT rejected: `rgb(...)`, `color-mix(...)`
 * and `radial-gradient(...)` are real values. They only have to be BALANCED
 * (see hasBalancedParens) — an unmatched count is itself a breakout.
 *
 * Plugin source is trusted local code (docs/PLUGINS.md) and values are
 * validated server-side, but a single malformed theme must not corrupt the
 * rest of the document. A skipped token simply inherits from the `:root`
 * default block, which is exactly what a missing token does.
 */
const VALUE_BREAKOUT = /[{}<>;"']|\/\*|\*\//;

/**
 * A custom-property name must keep that shape: the token rides before the
 * colon, so a name containing a space, brace, quote, colon (or anything else)
 * would let the rest of the key splice declarations or rules. Permissive
 * enough for real tokens (`--bg-image`, `--fg-muted`) and plugin-custom ones
 * (`--my-token`), strict enough to reject anything structural.
 */
const TOKEN_NAME = /^--[A-Za-z0-9_-]+$/;

/**
 * The same hazard on the other half of the rule: the id rides inside a quoted
 * attribute selector, so a quote, brace, angle bracket or whitespace could
 * break out of `[data-theme="..."]` and inject a selector. Ids are validated
 * server-side (kebab-case) and reserved ids are rejected there too, but the
 * injector is the last line of defense for the document it writes into — an
 * unsafe id is dropped rather than trusted. Keys and values are filtered the
 * same way (TOKEN_NAME / VALUE_BREAKOUT), so all three parts are vetted here.
 */
const ID_BREAKOUT = /["{}<\s]/;

/**
 * Whether every `(` in `value` is matched by a later `)`. An unbalanced count
 * leaves the CSS tokenizer in a nesting state it never exits, so the
 * remainder of the sheet — including every other plugin's theme — is parsed
 * as part of this declaration.
 */
function hasBalancedParens(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

/**
 * CSS text declaring every plugin theme: one `:root[data-theme="<id>"]` rule
 * each, matching the shape of the built-in blocks in styles/themes.css so the
 * cascade treats them identically (later rules of equal specificity win, so a
 * plugin theme overrides the `:root` baseline just like a built-in).
 *
 * `color-scheme` is emitted from `kind` for the same reason the built-in
 * blocks do it: without it, native widgets, form controls and scrollbars keep
 * the OS default and visibly disagree with the palette. `kind` is itself
 * filtered — anything but "dark"/"light" would splice a raw value into the
 * sheet, so the declaration is omitted and the property inherits.
 *
 * Every entry in `vars` is emitted (including optional decorative tokens like
 * `--bg-image`) in object insertion order, so a theme author controls the
 * cascade among their own declarations. The id, each token name and each value
 * are filtered (ID_BREAKOUT / TOKEN_NAME / VALUE_BREAKOUT); a rejected token
 * is skipped without leaving a dangling separator, so the remaining
 * declarations stay valid and the token falls back to the `:root` default.
 */
export function buildPluginThemeCss(themes: PluginThemeEntry[]): string {
  const rules: string[] = [];
  for (const theme of themes) {
    if (ID_BREAKOUT.test(theme.id)) {
      continue;
    }
    const declarations: string[] = [];
    if (theme.kind === "dark" || theme.kind === "light") {
      declarations.push(`color-scheme: ${theme.kind}`);
    }
    for (const [token, value] of Object.entries(theme.vars)) {
      if (!TOKEN_NAME.test(token) || VALUE_BREAKOUT.test(value) || !hasBalancedParens(value)) {
        continue;
      }
      declarations.push(`${token}: ${value}`);
    }
    rules.push(`:root[data-theme="${theme.id}"] { ${declarations.join("; ")} }`);
  }
  return rules.join("\n");
}
