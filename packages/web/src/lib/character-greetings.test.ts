/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { greetingFields, greetingsFromCharacter, moveGreeting } from "./character-greetings";

describe("greetingsFromCharacter", () => {
  it("puts the default first, then the alternates in stored order", () => {
    expect(greetingsFromCharacter({ first_mes: "Hello", alternate_greetings: ["A", "B"] })).toEqual(
      ["Hello", "A", "B"],
    );
  });

  it("keeps the default as-is, untrimmed", () => {
    expect(greetingsFromCharacter({ first_mes: "  Hello  ", alternate_greetings: [] })).toEqual([
      "  Hello  ",
    ]);
  });

  it("still yields one editable card for an empty character", () => {
    expect(greetingsFromCharacter({ first_mes: "", alternate_greetings: [] })).toEqual([""]);
  });
});

describe("greetingFields", () => {
  it("round-trips a character with a default and alternates", () => {
    const character = { first_mes: "Hello", alternate_greetings: ["A", "B"] };
    expect(greetingFields(greetingsFromCharacter(character))).toEqual(character);
  });

  it("turns an empty editor list back into empty fields", () => {
    expect(greetingFields([""])).toEqual({ first_mes: "", alternate_greetings: [] });
  });

  it("drops blank cards and promotes the first survivor to the default", () => {
    expect(greetingFields(["", "B", "A"])).toEqual({ first_mes: "B", alternate_greetings: ["A"] });
  });

  it("trims each kept card", () => {
    expect(greetingFields(["  Hello  ", "  A  "])).toEqual({
      first_mes: "Hello",
      alternate_greetings: ["A"],
    });
  });

  it("drops whitespace-only cards", () => {
    expect(greetingFields(["A", "   ", "\n\t"])).toEqual({
      first_mes: "A",
      alternate_greetings: [],
    });
  });

  it("returns empty fields for an all-blank list", () => {
    expect(greetingFields(["", "   "])).toEqual({ first_mes: "", alternate_greetings: [] });
    expect(greetingFields([])).toEqual({ first_mes: "", alternate_greetings: [] });
  });
});

describe("moveGreeting", () => {
  it("moves a card forward", () => {
    expect(moveGreeting(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("moves a card backward", () => {
    expect(moveGreeting(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("returns the same reference for a no-op move", () => {
    const list = ["a", "b", "c"];
    expect(moveGreeting(list, 1, 1)).toBe(list);
  });

  it("returns the same reference for out-of-range indices", () => {
    const list = ["a", "b"];
    expect(moveGreeting(list, -1, 1)).toBe(list);
    expect(moveGreeting(list, 0, -1)).toBe(list);
    expect(moveGreeting(list, 2, 0)).toBe(list);
    expect(moveGreeting(list, 0, 2)).toBe(list);
  });

  it("returns the same reference for an empty list", () => {
    const empty: string[] = [];
    expect(moveGreeting(empty, 0, 1)).toBe(empty);
  });

  it("does not mutate its input", () => {
    const list = ["a", "b", "c"];
    const next = moveGreeting(list, 0, 2);
    expect(list).toEqual(["a", "b", "c"]);
    expect(next).not.toBe(list);
  });
});
