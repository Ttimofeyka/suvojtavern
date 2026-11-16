/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { appStore } from "./store";

export const navOpenAtom = atom(false);

/**
 * Actions live at module scope rather than being re-created inside the hook:
 * App.tsx lists them in effect deps (`closeNav`), so a fresh closure per
 * render would re-fire those effects on every render and close the drawer
 * the instant it opens. Stable identities keep the deps quiet.
 */
function openNav(): void {
  appStore.set(navOpenAtom, true);
}

function closeNav(): void {
  appStore.set(navOpenAtom, false);
}

function toggleNav(): void {
  appStore.set(navOpenAtom, (v) => !v);
}

/** Mobile-only off-canvas sidebar visibility (session state, not persisted). */
export function useMobileNav(): {
  navOpen: boolean;
  openNav: () => void;
  closeNav: () => void;
  toggleNav: () => void;
} {
  return {
    navOpen: useAtomValue(navOpenAtom),
    openNav,
    closeNav,
    toggleNav,
  };
}
