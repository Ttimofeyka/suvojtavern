/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  clampTrackerIndicatorLabel,
  DEFAULT_TRACKER_INDICATOR,
  MAX_TRACKER_INDICATOR_LABEL,
  storedTrackerIndicator,
} from "./tracker-indicator";

describe("storedTrackerIndicator", () => {
  it("falls back to the default when the value is null", () => {
    expect(storedTrackerIndicator(null)).toEqual(DEFAULT_TRACKER_INDICATOR);
  });

  it("falls back to the default when the value is garbage", () => {
    expect(storedTrackerIndicator("nope")).toEqual(DEFAULT_TRACKER_INDICATOR);
    expect(storedTrackerIndicator([])).toEqual(DEFAULT_TRACKER_INDICATOR);
    expect(storedTrackerIndicator({})).toEqual(DEFAULT_TRACKER_INDICATOR);
    expect(storedTrackerIndicator({ show: "yes", label: 7, dot: 0 })).toEqual(
      DEFAULT_TRACKER_INDICATOR,
    );
  });

  it("returns a fresh object each call", () => {
    expect(storedTrackerIndicator({})).not.toBe(DEFAULT_TRACKER_INDICATOR);
  });

  it("round-trips a valid object", () => {
    expect(storedTrackerIndicator({ show: false, label: "Thinking", dot: false })).toEqual({
      show: false,
      label: "Thinking",
      dot: false,
    });
  });

  it("ignores wrong-typed fields while keeping valid siblings", () => {
    expect(storedTrackerIndicator({ show: "no", label: "Thinking", dot: false })).toEqual({
      show: DEFAULT_TRACKER_INDICATOR.show,
      label: "Thinking",
      dot: false,
    });
    expect(storedTrackerIndicator({ show: false, label: 7, dot: "no" })).toEqual({
      show: false,
      label: DEFAULT_TRACKER_INDICATOR.label,
      dot: DEFAULT_TRACKER_INDICATOR.dot,
    });
  });

  it("ignores a non-string label", () => {
    expect(storedTrackerIndicator({ label: 7 }).label).toBe(DEFAULT_TRACKER_INDICATOR.label);
  });

  it("truncates a label longer than the maximum", () => {
    const long = "x".repeat(MAX_TRACKER_INDICATOR_LABEL + 1);
    expect(storedTrackerIndicator({ label: long }).label).toHaveLength(MAX_TRACKER_INDICATOR_LABEL);
  });

  it("keeps a label exactly at the maximum length", () => {
    const boundary = "x".repeat(MAX_TRACKER_INDICATOR_LABEL);
    expect(storedTrackerIndicator({ label: boundary }).label).toBe(boundary);
  });
});

describe("clampTrackerIndicatorLabel", () => {
  it("truncates to the supported length", () => {
    const long = "x".repeat(MAX_TRACKER_INDICATOR_LABEL + 5);
    expect(clampTrackerIndicatorLabel(long)).toHaveLength(MAX_TRACKER_INDICATOR_LABEL);
    expect(clampTrackerIndicatorLabel(long)).toBe("x".repeat(MAX_TRACKER_INDICATOR_LABEL));
  });

  it("preserves a trailing space while typing", () => {
    expect(clampTrackerIndicatorLabel("Tracking ")).toBe("Tracking ");
  });
});
