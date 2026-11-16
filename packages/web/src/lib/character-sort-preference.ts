/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CharacterSort } from "./api-characters";

/**
 * Last-used character ordering — a browser-local hint shared by exactly two
 * surfaces: the New Chat modal and the Characters management page. Each reads
 * it at mount to seed its own order and writes it when the user picks a new
 * one, so the two open in step.
 *
 * Other character pickers (WelcomeWizard, ImportExport, LorebookEditor) do not
 * use it: they call the bare `useCharacterPager()` and stay on the server's
 * default `name` order.
 *
 * What it deliberately is NOT, so future edits don't grow it into state the
 * app depends on:
 *  - It is NOT a server setting. The order is a query param, re-sent on every
 *    fetch; losing the preference only resets those two surfaces to their
 *    default.
 *  - It is NOT the full {@link CharacterSort} enum. The UI exposes only
 *    `created`/`recent`; the third server value `name` is the implicit default
 *    and is never written here, so a stored value always names a user choice.
 */

/** localStorage key holding the JSON-encoded last-used character order. */
export const CHARACTER_SORT_STORAGE_KEY = "suvoj.characters.sort";

/** Coerces a stored/selected value to a UI-choosable order: `created` and
 *  `recent` pass through, everything else (including `name`, empty strings,
 *  null, numbers, objects, arrays) collapses to null. Shared by the read and
 *  write paths so what counts as "choosable" can never drift between them. */
export function storedCharacterSort(raw: unknown): CharacterSort | null {
  return raw === "created" || raw === "recent" ? raw : null;
}

/** The last-used order, or `created` when none was ever stored (or storage is
 *  unreadable). JSON.parse mirrors the write's JSON.stringify; a missing or
 *  corrupt value reads as absent. */
export function getCharacterSort(): CharacterSort {
  try {
    const raw = localStorage.getItem(CHARACTER_SORT_STORAGE_KEY);
    return (raw === null ? null : storedCharacterSort(JSON.parse(raw))) ?? "created";
  } catch {
    // Missing, unreadable, or corrupt storage — the default order stands.
    return "created";
  }
}

/** Remembers `sort` for the next mount of those two surfaces. A value outside
 *  the UI choices is a NO-OP, so a programmatic `name` never leaks into
 *  storage. Writes tolerate unwritable storage (private mode, quota) by
 *  staying silent — the preference is a hint, not state the app depends on. */
export function rememberCharacterSort(sort: CharacterSort): void {
  const valid = storedCharacterSort(sort);
  if (valid === null) {
    return;
  }
  try {
    localStorage.setItem(CHARACTER_SORT_STORAGE_KEY, JSON.stringify(valid));
  } catch {
    // Unwritable storage — the preference just isn't remembered this session.
  }
}
