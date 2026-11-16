/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  clampStreamingIndicatorLabel,
  DEFAULT_STREAMING_INDICATOR,
  MAX_STREAMING_INDICATOR_LABEL,
  storedStreamingIndicator,
} from "./streaming-indicator";

describe("storedStreamingIndicator", () => {
  it("falls back to the default when the value is null", () => {
    expect(storedStreamingIndicator(null)).toEqual(DEFAULT_STREAMING_INDICATOR);
  });

  it("falls back to the default when the value is garbage", () => {
    expect(storedStreamingIndicator("nope")).toEqual(DEFAULT_STREAMING_INDICATOR);
    expect(storedStreamingIndicator([])).toEqual(DEFAULT_STREAMING_INDICATOR);
    expect(storedStreamingIndicator({})).toEqual(DEFAULT_STREAMING_INDICATOR);
    expect(storedStreamingIndicator({ show: "yes", label: 7, dot: 0 })).toEqual(
      DEFAULT_STREAMING_INDICATOR,
    );
  });

  it("returns a fresh object each call", () => {
    expect(storedStreamingIndicator({})).not.toBe(DEFAULT_STREAMING_INDICATOR);
  });

  it("round-trips a valid object", () => {
    expect(storedStreamingIndicator({ show: false, label: "Thinking", dot: false })).toEqual({
      show: false,
      label: "Thinking",
      dot: false,
    });
  });

  it("ignores wrong-typed fields while keeping valid siblings", () => {
    expect(storedStreamingIndicator({ show: "no", label: "Thinking", dot: false })).toEqual({
      show: DEFAULT_STREAMING_INDICATOR.show,
      label: "Thinking",
      dot: false,
    });
    expect(storedStreamingIndicator({ show: false, label: 7, dot: "no" })).toEqual({
      show: false,
      label: DEFAULT_STREAMING_INDICATOR.label,
      dot: DEFAULT_STREAMING_INDICATOR.dot,
    });
  });

  it("ignores a non-string label", () => {
    expect(storedStreamingIndicator({ label: 7 }).label).toBe(DEFAULT_STREAMING_INDICATOR.label);
  });

  it("truncates a label longer than the maximum", () => {
    const long = "x".repeat(MAX_STREAMING_INDICATOR_LABEL + 1);
    expect(storedStreamingIndicator({ label: long }).label).toHaveLength(
      MAX_STREAMING_INDICATOR_LABEL,
    );
  });

  it("keeps a label exactly at the maximum length", () => {
    const boundary = "x".repeat(MAX_STREAMING_INDICATOR_LABEL);
    expect(storedStreamingIndicator({ label: boundary }).label).toBe(boundary);
  });
});

describe("clampStreamingIndicatorLabel", () => {
  it("truncates to the supported length", () => {
    const long = "x".repeat(MAX_STREAMING_INDICATOR_LABEL + 5);
    expect(clampStreamingIndicatorLabel(long)).toHaveLength(MAX_STREAMING_INDICATOR_LABEL);
    expect(clampStreamingIndicatorLabel(long)).toBe("x".repeat(MAX_STREAMING_INDICATOR_LABEL));
  });

  it("preserves a trailing space while typing", () => {
    expect(clampStreamingIndicatorLabel("Streaming ")).toBe("Streaming ");
  });
});
