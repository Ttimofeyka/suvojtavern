/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { appStore } from "./store";

export const chatsOpenAtom = atom(false);

/**
 * Actions live at module scope rather than being re-created inside the hook:
 * App.tsx lists them in effect deps, so a fresh closure per render would
 * re-fire those effects on every render and close the slide-over the instant
 * it opens. Stable identities keep the deps quiet.
 */
function openChats(): void {
  appStore.set(chatsOpenAtom, true);
}

function closeChats(): void {
  appStore.set(chatsOpenAtom, false);
}

function toggleChats(): void {
  appStore.set(chatsOpenAtom, (v) => !v);
}

/** Mobile-only chat-history slide-over visibility (session state). */
export function useMobileChats(): {
  chatsOpen: boolean;
  openChats: () => void;
  closeChats: () => void;
  toggleChats: () => void;
} {
  return {
    chatsOpen: useAtomValue(chatsOpenAtom),
    openChats,
    closeChats,
    toggleChats,
  };
}
