/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getDefaultStore } from "jotai";

/**
 * The one Jotai store shared by module-level setters and every component.
 *
 * No `<Provider>` is mounted, so React's `useAtomValue`/`useSetAtom` fall back
 * to this same default store: a write through a module-level action function
 * is immediately visible to a component, and vice versa. Jotai's `jotai`
 * entry also re-exports `getDefaultStore`, so there is a single source here.
 */
export const appStore = getDefaultStore();
