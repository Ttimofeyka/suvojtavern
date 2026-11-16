/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { appStore } from "./store";

/**
 * Drawer tab preferences — order, visibility, and the active tab of the
 * chat drawer (the tabbed right panel hosting tracker, summaries, and
 * plugin tabs). Follows the layout store's module-level singleton idiom;
 * persists to localStorage (browser-local UI state, unlike the layout's
 * server-side settings).
 */

/** One tab's saved preference: its id and whether the drawer shows it. */
export interface DrawerTabPref {
  id: string;
  visible: boolean;
}

export interface DrawerPrefs {
  /** Saved tab order (may lag the currently available tabs). */
  tabs: DrawerTabPref[];
  activeTabId: string | null;
}

const DRAWER_STORAGE_KEY = "suvoj.drawer";
const DEFAULT_PREFS: DrawerPrefs = { tabs: [], activeTabId: null };

export const drawerPrefsAtom = atom<DrawerPrefs>(DEFAULT_PREFS);

/** Per-field atoms for consumers that only care about the active tab or the list. */
export const drawerTabsAtom = atom((get) => get(drawerPrefsAtom).tabs);
export const drawerActiveTabIdAtom = atom((get) => get(drawerPrefsAtom).activeTabId);

let initialized = false;
/** The most recent order `orderedTabIds`/`orderedAllTabIds` computed —
 *  `moveTab`'s frame of reference, so reordering works before a tab was
 *  ever persisted (the effective order, not the saved one). */
let lastOrder: string[] = [];

/** Saved visibility of a tab; unknown ids default to visible. */
function visibleOf(id: string): boolean {
  return appStore.get(drawerPrefsAtom).tabs.find((tab) => tab.id === id)?.visible ?? true;
}

/** Merge an unknown stored value onto the defaults, tolerating bad shapes. */
function storedPrefs(value: unknown): DrawerPrefs {
  const next: DrawerPrefs = { tabs: [], activeTabId: null };
  if (typeof value !== "object" || value === null) {
    return next;
  }
  const stored = value as Record<string, unknown>;
  if (Array.isArray(stored.tabs)) {
    next.tabs = stored.tabs.filter(
      (row): row is DrawerTabPref =>
        typeof row === "object" &&
        row !== null &&
        typeof (row as Record<string, unknown>).id === "string" &&
        typeof (row as Record<string, unknown>).visible === "boolean",
    );
  }
  if (typeof stored.activeTabId === "string" || stored.activeTabId === null) {
    next.activeTabId = stored.activeTabId as string | null;
  }
  return next;
}

function persist(): void {
  const prefs = appStore.get(drawerPrefsAtom);
  try {
    localStorage.setItem(
      DRAWER_STORAGE_KEY,
      JSON.stringify({ tabs: prefs.tabs, activeTabId: prefs.activeTabId }),
    );
  } catch {
    // Unwritable storage (private mode, quota) — preferences stay in-memory.
  }
}

/** The effective tab order for `availableIds`: saved order first, then
 *  unknown/new ids appended in the given order. */
function orderOf(availableIds: string[]): string[] {
  const saved = appStore.get(drawerPrefsAtom).tabs.map((tab) => tab.id);
  const available = new Set(availableIds);
  const ordered = [
    ...saved.filter((id) => available.has(id)),
    ...availableIds.filter((id) => !saved.includes(id)),
  ];
  lastOrder = ordered;
  return ordered;
}

/**
 * Drawer store. The first call hydrates the stored preferences from
 * localStorage without blocking render; every mutation persists the whole
 * prefs object (fire-and-forget). The hook subscribes to `drawerPrefsAtom`,
 * so the ordering/active-tab reads below re-run when prefs change.
 */
export function useDrawerStore(): {
  orderedTabIds(availableIds: string[]): string[];
  orderedAllTabIds(availableIds: string[]): string[];
  isTabVisible(id: string): boolean;
  toggleTabVisible(id: string): void;
  moveTab(id: string, dir: -1 | 1): void;
  activeTabId(): string | null;
  setActiveTabId(id: string): void;
} {
  useAtomValue(drawerPrefsAtom);

  if (!initialized) {
    initialized = true;
    try {
      const raw = localStorage.getItem(DRAWER_STORAGE_KEY);
      if (raw !== null) {
        appStore.set(drawerPrefsAtom, storedPrefs(JSON.parse(raw)));
      }
    } catch {
      // Missing, unreadable, or corrupt storage — defaults apply.
    }
  }

  return {
    /** Saved order, unknown/new ids appended in given order, then
     *  visibility-filtered (the tabs the drawer actually renders). */
    orderedTabIds(availableIds: string[]): string[] {
      return orderOf(availableIds).filter((id) => visibleOf(id));
    },

    /** Like `orderedTabIds`, but keeps hidden tabs in place (the tab
     *  management list, which must offer hidden tabs for re-showing). */
    orderedAllTabIds(availableIds: string[]): string[] {
      return orderOf(availableIds);
    },

    /** Whether the drawer renders the tab; unknown ids default true. */
    isTabVisible(id: string): boolean {
      return visibleOf(id);
    },

    /** Flips a tab's visibility (new ids start hidden). */
    toggleTabVisible(id: string): void {
      const prefs = appStore.get(drawerPrefsAtom);
      const tabs = prefs.tabs.some((tab) => tab.id === id)
        ? prefs.tabs.map((tab) => (tab.id === id ? { ...tab, visible: !tab.visible } : tab))
        : [...prefs.tabs, { id, visible: false }];
      appStore.set(drawerPrefsAtom, { ...prefs, tabs });
      persist();
    },

    /** Swaps the tab with its neighbor in the effective order. */
    moveTab(id: string, dir: -1 | 1): void {
      const prefs = appStore.get(drawerPrefsAtom);
      const base = lastOrder.length > 0 ? [...lastOrder] : prefs.tabs.map((tab) => tab.id);
      const ids = base.includes(id) ? base : [...base, id];
      const from = ids.indexOf(id);
      const to = from + dir;
      if (from === -1 || to < 0 || to >= ids.length) {
        return;
      }
      const moved = ids.splice(from, 1)[0] ?? id;
      ids.splice(to, 0, moved);
      // The saved order becomes the effective one — untouched tabs keep
      // their visibility, absorbed ones start visible.
      appStore.set(drawerPrefsAtom, {
        ...appStore.get(drawerPrefsAtom),
        tabs: ids.map((tabId) => ({ id: tabId, visible: visibleOf(tabId) })),
      });
      persist();
    },

    /** The persisted active tab; null until a tab was picked. */
    activeTabId(): string | null {
      return appStore.get(drawerPrefsAtom).activeTabId;
    },

    /** Persists the drawer's selected tab. */
    setActiveTabId(id: string): void {
      appStore.set(drawerPrefsAtom, { ...appStore.get(drawerPrefsAtom), activeTabId: id });
      persist();
    },
  };
}
