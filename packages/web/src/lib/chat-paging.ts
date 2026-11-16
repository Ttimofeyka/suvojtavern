/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatSummaryInfo } from "./api-chats";

/**
 * Pure, React-free paging math for the chat sidebar's infinite scroll. Kept
 * out of the store so the append/dedup and end-of-list rules are unit-testable
 * without atoms or a DOM; the store owns the atoms and the network calls.
 */

/**
 * Appends `incoming` to `existing`, skipping ids already present. "First
 * occurrence wins", so newest-first order is preserved across pages and a row
 * already in the window — including the open chat's retained row (see the
 * store) — can never be duplicated by a later page that includes it.
 */
export function mergeChatPages(
  existing: ChatSummaryInfo[],
  incoming: ChatSummaryInfo[],
): ChatSummaryInfo[] {
  const seen = new Set(existing.map((chat) => chat.id));
  return existing.concat(incoming.filter((chat) => !seen.has(chat.id)));
}

/** The next page request, or "no more pages" once every server row is loaded. */
export interface ChatNextPage {
  /** True when another page can still be requested. */
  hasMore: boolean;
  /** Rows to request; never more than remain, and never 0 while more remain. */
  limit: number;
  /** Offset to request at — the loaded server-row boundary. */
  offset: number;
}

/**
 * Computes the next request from the number of SERVER rows already fetched and
 * the server total. `offset` equals the fetched-row boundary: server pages are
 * contiguous, so the next page starts exactly where the last one ended.
 *
 * `loadedServerRows` counts rows the server returned — NOT `chatsAtom.length`,
 * which may also carry the open chat's retained row and would otherwise skew
 * the offset past a real row.
 */
export function nextChatPage(
  loadedServerRows: number,
  pageLimit: number,
  total: number,
): ChatNextPage {
  const remaining = total - loadedServerRows;
  return {
    hasMore: remaining > 0,
    offset: loadedServerRows,
    // A short final page asks only for what is left; the guard keeps a
    // non-positive remaining from producing limit 0.
    limit: remaining > 0 ? Math.min(pageLimit, remaining) : pageLimit,
  };
}
