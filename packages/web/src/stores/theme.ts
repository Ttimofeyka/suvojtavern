/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BUILT_IN_THEMES as THEMES } from "@suvoj/plugin-sdk/themes";
import { atom, useAtomValue } from "jotai";
import type { PluginThemeEntry } from "../lib/plugin-theme";
import { appStore } from "./store";

export { THEMES };

/**
 * A theme id — built-in or plugin-contributed. Deliberately `string`, not the
 * literal union of THEMES: plugin themes are dynamic (they appear and
 * disappear with the plugin list), so the selection atom cannot be typed
 * against a frozen list. `THEMES` remains the source of truth for the
 * built-in palettes.
 */
export type ThemeId = string;

export const DEFAULT_THEME: ThemeId = "tavern";

/**
 * Kebab-case shape a theme id must have to be stored. Why shape-only, not a
 * membership check: the selection is hydrated from GET /api/settings before
 * the plugin list arrives, so a plugin theme id cannot yet be recognized as
 * available. Accepting it on shape alone means the stored choice survives: its
 * `:root[data-theme="<id>"]` rule is injected once the plugin list lands and
 * the palette appears then; if the plugin never arrives, the unknown id simply
 * falls back to the default `:root` block. Garbage that could not be an id
 * (spaces, uppercase, empty, punctuation) is still rejected.
 */
const THEME_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Current theme selection. Components subscribe with `useAtomValue` (or the
 * `useTheme()` hook, which does it for them); module-level code reads/writes it
 * through `appStore`.
 */
export const currentThemeAtom = atom<ThemeId>(DEFAULT_THEME);

/**
 * Plugin-contributed theme registry. Two atoms rather than one because they
 * change together but for different consumers: `pluginThemesAtom` is the
 * picker's list, `pluginKindsAtom` the id→kind map the accent math reads. Both
 * are written together by registerPluginThemes; `themeKind` reads
 * `pluginKindsAtom` so a registry change re-runs anything watching the kind
 * (e.g. the accent subscription in stores/design.ts) without those consumers
 * knowing about plugins.
 */
export const pluginThemesAtom = atom<PluginThemeEntry[]>([]);
export const pluginKindsAtom = atom<Record<string, "dark" | "light">>({});

/**
 * Replaces the plugin-theme registry (called whenever the plugin list
 * changes). Replacement, not merging: the server's list is the whole truth,
 * so a disabled plugin's themes must disappear rather than linger.
 */
export function registerPluginThemes(entries: PluginThemeEntry[]): void {
  appStore.set(pluginThemesAtom, entries);
  appStore.set(pluginKindsAtom, Object.fromEntries(entries.map((theme) => [theme.id, theme.kind])));
}

/** Current plugin-theme entries (the picker reads this, or `pluginThemesAtom` reactively). */
export function availablePluginThemes(): PluginThemeEntry[] {
  return appStore.get(pluginThemesAtom);
}

/** The kind of a theme id (built-in or plugin), or null when unknown. */
export function themeKind(id: string): "dark" | "light" | null {
  const builtin = THEMES.find((theme) => theme.id === id);
  if (builtin !== undefined) {
    return builtin.kind;
  }
  // Own-property read: pluginKindsAtom holds a plain object, so a bare lookup
  // would resolve prototype members ("constructor") and return a function
  // where a kind is expected — breaking stores/plugin-theme.ts's
  // stale-selection fallback (kind !== null) and making design.ts's surface
  // math index SURFACE_FALLBACKS with a non-kind. Reading the atom is the
  // point: its subscribers re-run when the registry changes.
  const kinds = appStore.get(pluginKindsAtom);
  if (!Object.hasOwn(kinds, id)) {
    return null;
  }
  const kind = kinds[id];
  return kind === "dark" || kind === "light" ? kind : null;
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEME_ID_PATTERN.test(value);
}

let initialized = false;
let userSelected = false;

function readSetting(settings: unknown, key: string): unknown {
  if (typeof settings !== "object" || settings === null) {
    return null;
  }
  return (settings as Record<string, unknown>)[key] ?? null;
}

function applyTheme(themeId: ThemeId): void {
  document.documentElement.dataset.theme = themeId;
  appStore.set(currentThemeAtom, themeId);
}

function persistTheme(themeId: ThemeId): void {
  fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ theme: themeId }),
  }).catch(() => {});
}

/**
 * Applies a theme as if the user had picked it (persisting the choice). This
 * is the module-level form of `useTheme().set`, callable outside React (the
 * stale-selection fallback in stores/plugin-theme.ts uses it).
 */
export function setTheme(themeId: ThemeId): void {
  userSelected = true;
  applyTheme(themeId);
  persistTheme(themeId);
}

/**
 * Theme store. The first call applies the default synchronously (so render is
 * never blocked) and then hydrates the stored theme from GET /api/settings.
 * If the user picks a theme before hydration finishes, the stored value is
 * skipped so a stale response cannot clobber the selection.
 */
export function useTheme(): {
  current: ThemeId;
  set(themeId: ThemeId): void;
} {
  const current = useAtomValue(currentThemeAtom);
  // Also subscribe to the tag registry: `availablePluginThemes()` is a plain
  // read, so the appearance picker (which uses this hook and then reads the
  // list) has to re-render when the plugin list lands.
  useAtomValue(pluginThemesAtom);

  if (!initialized) {
    initialized = true;
    document.documentElement.dataset.theme = DEFAULT_THEME;
    fetch("/api/settings")
      .then((response) => (response.ok ? response.json() : null))
      .then((settings: unknown) => {
        if (userSelected) {
          return;
        }
        const stored = readSetting(settings, "theme");
        if (isThemeId(stored)) {
          applyTheme(stored);
        }
      })
      .catch(() => {});
  }

  return {
    current,
    set: setTheme,
  };
}
