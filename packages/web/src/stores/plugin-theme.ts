/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  buildPluginThemeCss,
  enabledPluginGlobalCss,
  enabledPluginThemes,
} from "../lib/plugin-theme";
import { pluginsAtom, pluginsLoadedAtom } from "./plugins";
import { appStore } from "./store";
import {
  currentThemeAtom,
  DEFAULT_THEME,
  pluginKindsAtom,
  registerPluginThemes,
  setTheme,
  themeKind,
} from "./theme";

/**
 * Plugin-theme injector. It mirrors the shared plugin store onto two things:
 *
 *  1. the theme registry (stores/theme.ts), so the appearance picker can list
 *     plugin palettes and the accent math can resolve their dark/light kind;
 *  2. two `<style>` elements in <head>, one for the `:root[data-theme=...]`
 *     declarations of every contributed theme and one for enabled plugins'
 *     `globalCss`.
 *
 * Nothing here renders — a plugin theme is "applied" purely by its injected
 * rule matching the `data-theme` attribute useTheme() already sets.
 */

/** Stable ids for the two injected sheets, so a re-import reuses them. */
const THEME_VARS_STYLE_ID = "suvoj-plugin-theme-vars";
const GLOBAL_CSS_STYLE_ID = "suvoj-plugin-global-css";

let started = false;

/**
 * Find or create the injected <style> by id. Reuse rather than replace: the
 * sheet is part of the document's cascade while the app runs, and swapping the
 * node on every plugin-list change would flash the previous palette out. The
 * element is deliberately never removed — an emptied sheet is harmless and
 * keeps this idempotent.
 */
function ensureStyleElement(id: string): HTMLStyleElement {
  const existing = document.getElementById(id);
  if (existing instanceof HTMLStyleElement) {
    return existing;
  }
  const element = document.createElement("style");
  element.id = id;
  document.head.appendChild(element);
  return element;
}

/**
 * Start the injector's reactivity. Subscriptions are app-lifetime: created on
 * first use and never torn down, matching the store they mirror (see
 * ensureThemeReactivity in stores/design.ts); the `started` guard makes a
 * repeat call (HMR re-import, StrictMode) a no-op.
 */
function ensurePluginThemeReactivity(): void {
  if (started || typeof document === "undefined") {
    return;
  }
  started = true;

  // Registration runs first and the fallback second; on the very first pass
  // (and whenever both change together) that guarantees the registry already
  // reflects the fresh list by the time availability is judged.
  const syncPluginThemes = (): void => {
    const list = appStore.get(pluginsAtom) ?? [];
    const entries = enabledPluginThemes(list);
    registerPluginThemes(entries);
    ensureStyleElement(THEME_VARS_STYLE_ID).textContent = buildPluginThemeCss(entries);
    ensureStyleElement(GLOBAL_CSS_STYLE_ID).textContent = enabledPluginGlobalCss(list);
  };
  // Jotai's store.sub has no fireImmediately option, so each body is invoked
  // once directly — matching the old createEffect, which ran on creation.
  appStore.sub(pluginsAtom, syncPluginThemes);
  syncPluginThemes();

  // Stale-selection fallback. Ordering hazard: while the plugin list is still
  // loading it is null, so an unknown id cannot be told apart from a plugin
  // theme whose plugin has simply not been reported yet. Judging availability
  // before the list arrives would reset a perfectly valid stored selection to
  // midnight on every boot. Once loaded, an id that resolves to neither a
  // built-in nor a registered plugin theme is genuinely gone (disabled or
  // removed), so fall back — and persist — rather than leave the document on
  // the default `:root` block while the picker shows nothing selected.
  const maybeResetStaleTheme = (): void => {
    if (!appStore.get(pluginsLoadedAtom)) {
      return;
    }
    const themeId = appStore.get(currentThemeAtom);
    if (themeKind(themeId) === null) {
      setTheme(DEFAULT_THEME);
    }
  };
  // Watch the registry (registration rewrites the kinds), the loaded flag (its
  // flip may land after the registry update) and the selection (a hydrated id
  // is judged once it lands). The reset writes the theme atom, but the
  // re-entrant check sees a built-in kind and stops.
  appStore.sub(pluginKindsAtom, maybeResetStaleTheme);
  appStore.sub(pluginsLoadedAtom, maybeResetStaleTheme);
  appStore.sub(currentThemeAtom, maybeResetStaleTheme);
  maybeResetStaleTheme();
}

/**
 * Wire the plugin-theme injector. Called once from the app shell purely for
 * its side effects — reads go through availablePluginThemes()/themeKind() in
 * stores/theme.ts, so this returns nothing (unlike the state-owning stores).
 * The guard lives in ensurePluginThemeReactivity, which is a no-op once the
 * subscriptions exist and is also a no-op without a DOM.
 */
export function usePluginThemes(): void {
  ensurePluginThemeReactivity();
}
