/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  countMessagesTokens,
  countTokens,
  disableTokenizer,
  estimateTokens,
  resetTokenizer,
  trimToBudget,
} from "./tokens";

describe("tokens", () => {
  it("counts tokens as positive and monotonic", () => {
    const short = countTokens("hello");
    const medium = countTokens("hello world, this is a sentence");
    const long = countTokens("hello world, this is a sentence ".repeat(50));
    expect(short).toBeGreaterThan(0);
    expect(medium).toBeGreaterThan(short);
    expect(long).toBeGreaterThan(medium);
  });

  it("counts empty text as zero tokens", () => {
    expect(countTokens("")).toBe(0);
  });

  it("does not leak cached counts into the heuristic fallback", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const real = countTokens(text);
    expect(real).toBeGreaterThan(0);
    disableTokenizer();
    expect(countTokens(text)).toBe(estimateTokens(text));
    resetTokenizer();
  });

  it("adds per-message overhead", () => {
    const one = countMessagesTokens([{ content: "hello world foo bar" }]);
    const two = countMessagesTokens([{ content: "hello world foo bar" }, { content: "" }]);
    expect(two - one).toBe(4);
  });

  it("falls back to the chars/3.6 heuristic when the tokenizer is unavailable", () => {
    disableTokenizer();
    expect(countTokens("x".repeat(36))).toBe(10);
    expect(estimateTokens("x".repeat(360))).toBe(100);
    expect(trimToBudget("x".repeat(360), 18)).toBe("x".repeat(64));
    resetTokenizer();
  });

  it("trims to a budget greedily from the start", () => {
    const text = "one two three four five six seven eight nine ten";
    const tokens = countTokens(text);
    const trimmed = trimToBudget(text, Math.floor(tokens / 2));
    expect(trimmed.length).toBeGreaterThan(0);
    expect(trimmed.length).toBeLessThan(text.length);
    expect(text.startsWith(trimmed.slice(0, 10))).toBe(true);
    expect(trimToBudget(text, 0)).toBe("");
    expect(trimToBudget("tiny", 1000)).toBe("tiny");
  });
});
