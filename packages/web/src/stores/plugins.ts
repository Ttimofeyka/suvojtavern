/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { listPlugins, type PluginInfo, reloadPlugins, setPluginEnabled } from "../lib/api-plugins";
import { appStore } from "./store";

/**
 * Singleton plugin store — the single source of truth for discovered plugins.
 * Both the Settings panel and the sidebar contributions read from these atoms,
 * so toggling a plugin updates the sidebar immediately (and vice versa, no
 * matter which view touched it first).
 */

export const pluginsAtom = atom<PluginInfo[] | null>(null);
export const pluginsLoadedAtom = atom(false);
export const pluginsErrorAtom = atom<string | null>(null);
export const pluginsReloadingAtom = atom(false);

/**
 * In-flight request memo: concurrent callers (sidebar + panel mounting
 * together) share one GET. It is cleared when the request settles so a later
 * load() refetches — unlike app settings, the plugin list can change
 * server-side (restart, another client's reload) between visits.
 */
let loadInFlight: Promise<void> | null = null;

function applyList(list: PluginInfo[]): void {
  appStore.set(pluginsAtom, list);
  appStore.set(pluginsLoadedAtom, true);
  appStore.set(pluginsErrorAtom, null);
}

/**
 * Fetches the plugin list. Failures are recorded on the error atom instead of
 * rejecting — mount-time callers (sidebar) never need per-call catch blocks;
 * the panel renders the atom reactively.
 */
function load(): Promise<void> {
  loadInFlight ??= listPlugins()
    .then(({ plugins }) => applyList(plugins))
    .catch((err) => {
      appStore.set(pluginsErrorAtom, err instanceof Error ? err.message : "Failed to load plugins");
    })
    .finally(() => {
      loadInFlight = null;
    });
  return loadInFlight;
}

/**
 * Rescans the plugins folder server-side (the Reload button): new folders
 * appear, removed ones disappear, edited source re-imports. The previous
 * list stays on screen if the rescan fails.
 */
async function reloadAll(): Promise<void> {
  appStore.set(pluginsReloadingAtom, true);
  try {
    const { plugins } = await reloadPlugins();
    applyList(plugins);
  } catch (err) {
    appStore.set(pluginsErrorAtom, err instanceof Error ? err.message : "Failed to reload plugins");
  } finally {
    appStore.set(pluginsReloadingAtom, false);
  }
}

/**
 * Optimistically flips a plugin's enablement so the sidebar reacts
 * instantly, then reconciles with the server's entry (which also refreshes
 * its error/settings state). On failure the flip reverts and the error
 * rejects for the caller to surface — the store never lies about server state.
 */
async function setEnabled(id: string, enabled: boolean): Promise<void> {
  appStore.set(pluginsAtom, (list) =>
    (list ?? []).map((p) => (p.id === id ? { ...p, enabled } : p)),
  );
  try {
    const { plugin } = await setPluginEnabled(id, enabled);
    appStore.set(pluginsAtom, (list) => (list ?? []).map((p) => (p.id === id ? plugin : p)));
  } catch (err) {
    appStore.set(pluginsAtom, (list) =>
      (list ?? []).map((p) => (p.id === id ? { ...p, enabled: !enabled } : p)),
    );
    throw err;
  }
}

/** The store's values + actions. The hook subscribes to every atom it returns. */
export function usePlugins(): {
  plugins: PluginInfo[] | null;
  loaded: boolean;
  error: string | null;
  reloading: boolean;
  load: () => Promise<void>;
  reloadAll: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
} {
  return {
    plugins: useAtomValue(pluginsAtom),
    loaded: useAtomValue(pluginsLoadedAtom),
    error: useAtomValue(pluginsErrorAtom),
    reloading: useAtomValue(pluginsReloadingAtom),
    load,
    reloadAll,
    setEnabled,
  };
}
