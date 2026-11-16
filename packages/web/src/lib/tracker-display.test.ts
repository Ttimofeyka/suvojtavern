/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { capitalizeSnapshot } from "./tracker-display";

describe("capitalizeSnapshot", () => {
  it("capitalizes an all-lowercase word", () => {
    expect(capitalizeSnapshot({ name: "alice" })).toEqual({ name: "Alice" });
  });

  it("capitalizes only the first letter of a lowercase phrase", () => {
    expect(capitalizeSnapshot({ outfit: "blue cotton shirt" })).toEqual({
      outfit: "Blue cotton shirt",
    });
  });

  it("leaves strings that already carry an uppercase letter untouched", () => {
    // Acronyms, camel case and all-caps are treated as deliberate casing.
    expect(capitalizeSnapshot({ a: "N/A", b: "iPhone", c: "ALICE" })).toEqual({
      a: "N/A",
      b: "iPhone",
      c: "ALICE",
    });
  });

  it("leaves strings whose first character is not a lowercase letter untouched", () => {
    expect(capitalizeSnapshot({ a: "3 apples", b: "" })).toEqual({ a: "3 apples", b: "" });
  });

  it("leaves prose-like guard characters (URLs, emails, paths) untouched", () => {
    expect(
      capitalizeSnapshot({
        url: "https://example.com/x",
        email: "user@example.com",
        path: "assets/hero.png",
      }),
    ).toEqual({
      url: "https://example.com/x",
      email: "user@example.com",
      path: "assets/hero.png",
    });
  });

  it("leaves n/a-style values untouched (the slash marks them non-prose)", () => {
    expect(capitalizeSnapshot({ ratio: "n/a" })).toEqual({ ratio: "n/a" });
  });

  it("capitalizes a lowercased word whose lead letter is non-ASCII", () => {
    // Unicode-aware lead test: "école" must become "École", not stay lowercase.
    expect(capitalizeSnapshot({ word: "école" })).toEqual({ word: "École" });
  });

  it("recurses into nested objects and arrays", () => {
    expect(capitalizeSnapshot({ characters: [{ name: "alice", outfit: "red dress" }] })).toEqual({
      characters: [{ name: "Alice", outfit: "Red dress" }],
    });
  });

  it("recurses into arrays of strings", () => {
    expect(capitalizeSnapshot({ tags: ["brave", "iPhone", "N/A"] })).toEqual({
      tags: ["Brave", "iPhone", "N/A"],
    });
  });

  it("passes non-string scalars through unchanged", () => {
    expect(capitalizeSnapshot({ n: 3, b: true, nil: null, u: undefined })).toEqual({
      n: 3,
      b: true,
      nil: null,
      u: undefined,
    });
  });

  it("does not mutate its input", () => {
    const input = { characters: [{ name: "alice" }], tags: ["brave"] };
    const before = structuredClone(input);
    const result = capitalizeSnapshot(input);
    expect(input).toEqual(before);
    expect(result).not.toBe(input);
    expect(result.characters).not.toBe(input.characters);
  });

  it("preserves keys and their order", () => {
    const input = { zebra: "one", apple: "two", mango: "three" };
    const result = capitalizeSnapshot(input);
    expect(Object.keys(result)).toEqual(["zebra", "apple", "mango"]);
    expect(Object.keys(result)).toEqual(Object.keys(input));
  });
});
