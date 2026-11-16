/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Last-used persona preference — a browser-local hint that pre-selects the
 * persona in the new-chat flows (the New Chat modal and the welcome wizard).
 *
 * Three deliberate properties, so future edits don't turn it into something
 * it isn't:
 *  - It is NOT the chat's persona. A chat stores its own `persona_id`
 *    server-side and reopening it never consults this; this only seeds the
 *    next *new* chat.
 *  - It is NOT per-chat. One remembered id is shared across every new chat
 *    in this browser.
 *  - Clearing a chat's persona must not forget the remembered one — "None"
 *    on an existing chat is a per-chat decision, not a reset of the
 *    preference — so `rememberPersonaId(null)` is a no-op by design.
 */

/** localStorage key holding the JSON-encoded last-used persona id. */
export const LAST_PERSONA_STORAGE_KEY = "suvoj.persona.lastUsed";

/** Coerces a stored/selected value to a usable persona id: a non-empty
 *  string passes through, everything else (empty string, null, numbers,
 *  objects, arrays) collapses to null. Shared by the read and write paths so
 *  what counts as "usable" can never drift between them. */
export function storedPersonaId(raw: unknown): string | null {
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/** The remembered persona id, or null when none was ever stored (or storage
 *  is unreadable). JSON.parse mirrors the write's JSON.stringify; a missing
 *  or corrupt value reads as absent. */
export function getLastPersonaId(): string | null {
  try {
    const raw = localStorage.getItem(LAST_PERSONA_STORAGE_KEY);
    return raw === null ? null : storedPersonaId(JSON.parse(raw));
  } catch {
    // Missing, unreadable, or corrupt storage — no remembered persona.
    return null;
  }
}

/** Remembers `id` for the next new chat. A null/empty id is a NO-OP: a
 *  persona-less chat (or clearing one) must not erase the preference the
 *  user may still want next time. Writes tolerate unwritable storage
 *  (private mode, quota) by staying silent — the preference is a hint, not
 *  state the app depends on. */
export function rememberPersonaId(id: string | null): void {
  const valid = storedPersonaId(id);
  if (valid === null) {
    return;
  }
  try {
    localStorage.setItem(LAST_PERSONA_STORAGE_KEY, JSON.stringify(valid));
  } catch {
    // Unwritable storage — the preference just isn't remembered this session.
  }
}
