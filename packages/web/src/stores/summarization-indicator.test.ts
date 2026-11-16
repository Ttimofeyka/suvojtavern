/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  clampSummarizationIndicatorLabel,
  DEFAULT_SUMMARIZATION_INDICATOR,
  MAX_SUMMARIZATION_INDICATOR_LABEL,
  storedSummarizationIndicator,
} from "./summarization-indicator";

describe("storedSummarizationIndicator", () => {
  it("falls back to the default when the value is null", () => {
    expect(storedSummarizationIndicator(null)).toEqual(DEFAULT_SUMMARIZATION_INDICATOR);
  });

  it("falls back to the default when the value is garbage", () => {
    expect(storedSummarizationIndicator("nope")).toEqual(DEFAULT_SUMMARIZATION_INDICATOR);
    expect(storedSummarizationIndicator([])).toEqual(DEFAULT_SUMMARIZATION_INDICATOR);
    expect(storedSummarizationIndicator({})).toEqual(DEFAULT_SUMMARIZATION_INDICATOR);
    expect(storedSummarizationIndicator({ show: "yes", label: 7, dot: 0 })).toEqual(
      DEFAULT_SUMMARIZATION_INDICATOR,
    );
  });

  it("returns a fresh object each call", () => {
    expect(storedSummarizationIndicator({})).not.toBe(DEFAULT_SUMMARIZATION_INDICATOR);
  });

  it("round-trips a valid object", () => {
    expect(storedSummarizationIndicator({ show: false, label: "Thinking", dot: false })).toEqual({
      show: false,
      label: "Thinking",
      dot: false,
    });
  });

  it("ignores wrong-typed fields while keeping valid siblings", () => {
    expect(storedSummarizationIndicator({ show: "no", label: "Thinking", dot: false })).toEqual({
      show: DEFAULT_SUMMARIZATION_INDICATOR.show,
      label: "Thinking",
      dot: false,
    });
    expect(storedSummarizationIndicator({ show: false, label: 7, dot: "no" })).toEqual({
      show: false,
      label: DEFAULT_SUMMARIZATION_INDICATOR.label,
      dot: DEFAULT_SUMMARIZATION_INDICATOR.dot,
    });
  });

  it("ignores a non-string label", () => {
    expect(storedSummarizationIndicator({ label: 7 }).label).toBe(
      DEFAULT_SUMMARIZATION_INDICATOR.label,
    );
  });

  it("truncates a label longer than the maximum", () => {
    const long = "x".repeat(MAX_SUMMARIZATION_INDICATOR_LABEL + 1);
    expect(storedSummarizationIndicator({ label: long }).label).toHaveLength(
      MAX_SUMMARIZATION_INDICATOR_LABEL,
    );
  });

  it("keeps a label exactly at the maximum length", () => {
    const boundary = "x".repeat(MAX_SUMMARIZATION_INDICATOR_LABEL);
    expect(storedSummarizationIndicator({ label: boundary }).label).toBe(boundary);
  });
});

describe("clampSummarizationIndicatorLabel", () => {
  it("truncates to the supported length", () => {
    const long = "x".repeat(MAX_SUMMARIZATION_INDICATOR_LABEL + 5);
    expect(clampSummarizationIndicatorLabel(long)).toHaveLength(MAX_SUMMARIZATION_INDICATOR_LABEL);
    expect(clampSummarizationIndicatorLabel(long)).toBe(
      "x".repeat(MAX_SUMMARIZATION_INDICATOR_LABEL),
    );
  });

  it("preserves a trailing space while typing", () => {
    expect(clampSummarizationIndicatorLabel("Summarizing ")).toBe("Summarizing ");
  });
});
