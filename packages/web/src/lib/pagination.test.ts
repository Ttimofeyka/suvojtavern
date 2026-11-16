/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { clampPage, pageCount, pageSlice } from "./pagination";

describe("pageCount", () => {
  it("always reports at least one page", () => {
    expect(pageCount(0, 24)).toBe(1);
    expect(pageCount(1, 24)).toBe(1);
  });

  it("rounds partial pages up", () => {
    expect(pageCount(24, 24)).toBe(1);
    expect(pageCount(25, 24)).toBe(2);
    expect(pageCount(48, 24)).toBe(2);
    expect(pageCount(49, 24)).toBe(3);
  });
});

describe("clampPage", () => {
  it("keeps a page that still exists", () => {
    expect(clampPage(2, 30, 24)).toBe(2);
    expect(clampPage(2, 48, 24)).toBe(2);
  });

  it("falls back to page 1 when the page no longer exists", () => {
    // Deleting the only entry on page 2 of a 25-entry list.
    expect(clampPage(2, 24, 24)).toBe(1);
    // Shrinking a 49-entry list (3 pages) to 24 entries (1 page).
    expect(clampPage(3, 24, 24)).toBe(1);
  });

  it("never returns a page below 1", () => {
    expect(clampPage(0, 10, 24)).toBe(1);
    expect(clampPage(-5, 10, 24)).toBe(1);
  });

  it("handles the empty list", () => {
    expect(clampPage(1, 0, 24)).toBe(1);
    expect(clampPage(4, 0, 24)).toBe(1);
  });
});

describe("pageSlice", () => {
  const items = Array.from({ length: 30 }, (_, i) => i + 1);

  it("returns the requested page and its 1-based range", () => {
    expect(pageSlice(items, 1, 12)).toEqual({ items: items.slice(0, 12), start: 1, end: 12 });
    expect(pageSlice(items, 2, 12)).toEqual({ items: items.slice(12, 24), start: 13, end: 24 });
    // Last page is partial: 30 items, 12/page → page 3 holds 6.
    expect(pageSlice(items, 3, 12)).toEqual({ items: items.slice(24, 30), start: 25, end: 30 });
  });

  it("reports a 0–0 range for an empty list", () => {
    expect(pageSlice([], 1, 24)).toEqual({ items: [], start: 0, end: 0 });
  });

  it("resets an out-of-range page to page 1 instead of returning nothing", () => {
    // Page 5 of a 30-item list does not exist, so the slice resets to page 1
    // (the spec's "reset when the list no longer fits" rule) rather than
    // rendering an empty grid.
    expect(pageSlice(items, 5, 12)).toEqual({ items: items.slice(0, 12), start: 1, end: 12 });
  });
});
