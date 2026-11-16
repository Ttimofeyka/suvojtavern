/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure, framework-free pagination math shared by the list UIs (the lorebook
 * entry editor, the character pickers). Kept out of the components so the
 * clamp/range rules — the off-by-one-prone part — are directly testable
 * without rendering.
 */

/** Total number of pages; an empty or short list still has page 1 so the UI
 *  always has a valid page to point at. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * The page a stored page number should settle on: unchanged when it still
 * exists, otherwise page 1. Page 1 always exists, so a delete on the last
 * page can never strand the grid on an empty page — and, because the result
 * is written back to state, regaining entries later does not resurrect the
 * old page.
 */
export function clampPage(page: number, total: number, pageSize: number): number {
  return page > pageCount(total, pageSize) ? 1 : Math.max(1, page);
}

export interface PageSlice<T> {
  /** Entries of the requested (already clamped) page, in list order. */
  items: T[];
  /** 1-based inclusive range of `items` within the full list, for the
   *  "Showing A–B of N" caption. Both are 0 when the list is empty. */
  start: number;
  end: number;
}

/** Slices `items` to the requested page. */
export function pageSlice<T>(items: readonly T[], page: number, pageSize: number): PageSlice<T> {
  const safePage = clampPage(page, items.length, pageSize);
  const offset = (safePage - 1) * pageSize;
  const slice = items.slice(offset, offset + pageSize);
  return {
    items: slice,
    start: slice.length === 0 ? 0 : offset + 1,
    end: offset + slice.length,
  };
}
