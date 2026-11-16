/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { DEFAULT_LAYOUT, type LayoutState, storedLayout } from "./layout";

describe("storedLayout", () => {
  it("falls back to the defaults when the value is null", () => {
    expect(storedLayout(null)).toEqual(DEFAULT_LAYOUT);
  });

  it("falls back to the defaults when the value is garbage", () => {
    expect(storedLayout("nope")).toEqual(DEFAULT_LAYOUT);
    expect(storedLayout(42)).toEqual(DEFAULT_LAYOUT);
    expect(storedLayout({})).toEqual(DEFAULT_LAYOUT);
    expect(storedLayout({ side: "up" })).toEqual(DEFAULT_LAYOUT);
    expect(storedLayout({ collapsed: 1 })).toEqual(DEFAULT_LAYOUT);
    expect(storedLayout({ chatsPaneHidden: 1 })).toEqual(DEFAULT_LAYOUT);
    expect(storedLayout({ compactStatus: "yes" })).toEqual(DEFAULT_LAYOUT);
    expect(storedLayout({ elements: "nope" })).toEqual(DEFAULT_LAYOUT);
  });

  it("preserves a fully valid stored object", () => {
    const stored: LayoutState = {
      side: "right",
      chatsPaneHidden: true,
      compactStatus: false,
      messageView: "flat",
      swipeGestures: false,
      elements: {
        avatars: false,
        timestamps: false,
        tokenCounter: true,
        gallery: false,
        lorebooks: false,
      },
    };
    expect(storedLayout(stored)).toEqual(stored);
  });

  it("ignores the removed sidebar `collapsed` key from legacy stored data", () => {
    // Old persisted layouts still carry `collapsed`; it must not survive the
    // merge (the rail is permanently icon-only now) and must never throw.
    const result = storedLayout({ side: "left", collapsed: true, compactStatus: false });
    expect(result).not.toHaveProperty("collapsed");
    expect(result).toEqual({ ...DEFAULT_LAYOUT, compactStatus: false });
  });

  it("round-trips lorebooks: false", () => {
    const result = storedLayout({ elements: { lorebooks: false } });
    expect(result.elements.lorebooks).toBe(false);
    // Every other element still comes from the defaults.
    expect(result.elements).toEqual({ ...DEFAULT_LAYOUT.elements, lorebooks: false });
  });

  it("falls back to the default lorebooks when it is missing or malformed", () => {
    expect(storedLayout({ elements: {} }).elements.lorebooks).toBe(true);
    expect(storedLayout({ elements: { lorebooks: "false" } }).elements.lorebooks).toBe(true);
    expect(storedLayout({ elements: { lorebooks: null } }).elements.lorebooks).toBe(true);
  });

  it("round-trips compactStatus: false", () => {
    const result = storedLayout({ compactStatus: false });
    expect(result.compactStatus).toBe(false);
    // The other top-level fields still come from the defaults.
    expect(result).toEqual({ ...DEFAULT_LAYOUT, compactStatus: false });
  });

  it("falls back to the default compactStatus when it is missing or malformed", () => {
    expect(storedLayout({}).compactStatus).toBe(true);
    expect(storedLayout({ compactStatus: "false" }).compactStatus).toBe(true);
    expect(storedLayout({ compactStatus: null }).compactStatus).toBe(true);
  });

  it("round-trips swipeGestures: false", () => {
    const result = storedLayout({ swipeGestures: false });
    expect(result.swipeGestures).toBe(false);
    // The other top-level fields still come from the defaults.
    expect(result).toEqual({ ...DEFAULT_LAYOUT, swipeGestures: false });
  });

  it("falls back to the default swipeGestures when it is missing or malformed", () => {
    expect(storedLayout({}).swipeGestures).toBe(true);
    expect(storedLayout({ swipeGestures: "false" }).swipeGestures).toBe(true);
    expect(storedLayout({ swipeGestures: null }).swipeGestures).toBe(true);
  });

  it("round-trips messageView: flat", () => {
    const result = storedLayout({ messageView: "flat" });
    expect(result.messageView).toBe("flat");
    // The other top-level fields still come from the defaults.
    expect(result).toEqual({ ...DEFAULT_LAYOUT, messageView: "flat" });
  });

  it("round-trips the transcript and bubbles views", () => {
    expect(storedLayout({ messageView: "transcript" }).messageView).toBe("transcript");
    expect(storedLayout({ messageView: "bubbles" }).messageView).toBe("bubbles");
  });

  it("falls back to the transcript view when messageView is missing or malformed", () => {
    expect(storedLayout({}).messageView).toBe("transcript");
    expect(storedLayout("nope").messageView).toBe("transcript");
    expect(storedLayout({ messageView: null }).messageView).toBe("transcript");
    expect(storedLayout({ messageView: "wide" }).messageView).toBe("transcript");
  });
});
