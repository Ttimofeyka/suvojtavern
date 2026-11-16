/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { setTrigger, TRIGGER_OPTIONS, triggersAllTypes, unknownTriggers } from "./preset-triggers";

describe("TRIGGER_OPTIONS", () => {
  it("offers only the types Suvoj actually sends", () => {
    expect(TRIGGER_OPTIONS.map((o) => o.id)).toEqual(["normal", "continue", "regenerate", "swipe"]);
  });
});

describe("triggersAllTypes", () => {
  it("is true for an empty and for an absent list", () => {
    expect(triggersAllTypes([])).toBe(true);
    expect(triggersAllTypes(undefined)).toBe(true);
  });

  it("is false for any non-empty list", () => {
    expect(triggersAllTypes(["continue"])).toBe(false);
    expect(triggersAllTypes(["impersonate"])).toBe(false);
  });
});

describe("unknownTriggers", () => {
  it("returns [] when every value is a known option", () => {
    expect(unknownTriggers(["normal", "continue"])).toEqual([]);
  });

  it("surfaces imported / future values in order, duplicates included", () => {
    expect(unknownTriggers(["continue", "impersonate", "future", "quiet", "future"])).toEqual([
      "impersonate",
      "future",
      "quiet",
      "future",
    ]);
  });

  it("tolerates an absent list", () => {
    expect(unknownTriggers(undefined)).toEqual([]);
  });
});

describe("setTrigger", () => {
  it("appends a newly checked value", () => {
    expect(setTrigger([], "continue", true)).toEqual(["continue"]);
    expect(setTrigger(["normal"], "continue", true)).toEqual(["normal", "continue"]);
  });

  it("removes an unchecked value", () => {
    expect(setTrigger(["normal", "continue"], "normal", false)).toEqual(["continue"]);
  });

  it("preserves unknown strings when toggling known ones", () => {
    const withUnknown = ["impersonate", "continue", "future"];
    expect(setTrigger(withUnknown, "normal", true)).toEqual([
      "impersonate",
      "continue",
      "future",
      "normal",
    ]);
    expect(setTrigger(withUnknown, "continue", false)).toEqual(["impersonate", "future"]);
  });

  it("does not duplicate a value that is already present", () => {
    expect(setTrigger(["continue"], "continue", true)).toEqual(["continue"]);
  });

  it("does not mutate the input array", () => {
    const source = ["continue"];
    setTrigger(source, "normal", true);
    setTrigger(source, "continue", false);
    expect(source).toEqual(["continue"]);
  });

  it("tolerates an absent list on both paths", () => {
    expect(setTrigger(undefined, "normal", true)).toEqual(["normal"]);
    expect(setTrigger(undefined, "normal", false)).toEqual([]);
  });

  it("can clear a list back to empty (the all-types default)", () => {
    expect(setTrigger(["continue"], "continue", false)).toEqual([]);
    expect(triggersAllTypes(setTrigger(["continue"], "continue", false))).toBe(true);
  });
});
