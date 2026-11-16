/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { continueSeparator, mergeContinue } from "./continue-text";

/**
 * The continue separator is the hand-kept twin of the server's
 * `continueSeparator` (packages/server/src/routes/generate-helpers.ts): one
 * space between the stored text and its continuation, none when there is
 * nothing to separate. That "nothing to separate" case is the refinement over
 * SillyTavern's rule, which always inserts its postfix when the text does not
 * end in a space (see lib/continue-text.ts). Kept hermetic — pure string work,
 * no Solid, no DOM.
 */
describe("continueSeparator", () => {
  it("inserts a single space when the previous text does not end in whitespace", () => {
    expect(continueSeparator("Hello!")).toBe(" ");
  });

  it("inserts no separator when the previous text is empty", () => {
    expect(continueSeparator("")).toBe("");
  });

  it("inserts no separator when the previous text already ends in a space", () => {
    expect(continueSeparator("Hello! ")).toBe("");
  });

  it("inserts no separator when the previous text already ends in a newline", () => {
    expect(continueSeparator("Hello!\n")).toBe("");
  });

  it("inserts no separator when the previous text already ends in a tab", () => {
    expect(continueSeparator("Hello!\t")).toBe("");
  });
});

describe("mergeContinue", () => {
  it("joins mid-word text with exactly one space", () => {
    expect(mergeContinue("Hello!", "Hi there")).toBe("Hello! Hi there");
  });

  it("joins empty previous text to the continuation bare", () => {
    expect(mergeContinue("", "Hi there")).toBe("Hi there");
  });

  it("leaves an already-whitespace-terminated previous text as-is", () => {
    expect(mergeContinue("Half a ", "Hi there")).toBe("Half a Hi there");
    expect(mergeContinue("Hello!\n", "Hi there")).toBe("Hello!\nHi there");
  });

  it("is idempotent on an already-separated pair — no second space is added", () => {
    // A pair whose previous half already ends in whitespace is already
    // separated; re-applying the rule must not double the gap.
    expect(mergeContinue("Hello! ", "Hi there")).toBe("Hello! Hi there");
    expect(mergeContinue("Hello!\n", "Hi there")).toBe("Hello!\nHi there");
  });
});
