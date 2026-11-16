/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { trackerConfigSchema } from "./tracker";

/**
 * Pins `trackerConfigSchema`'s tolerance for the active preset's split
 * config. Each passing case is the source of truth the web mirror
 * (`readParts` / `normalizePreset` in @suvoj/web) is verified against — the
 * two implementations must not diverge (see tracker-config.test.ts).
 */

/** Parses one `parts` value through the full config schema and returns it. */
function parseParts(parts: unknown): { count: number; fields: Record<string, number> } {
  const parsed = trackerConfigSchema.parse({
    schema_presets: { p: { schema: {}, parts } },
  });
  return parsed.schema_presets.p?.parts ?? { count: 1, fields: {} };
}

describe("trackerConfigSchema parts", () => {
  it("clamps an out-of-range sibling without discarding the other entries", () => {
    expect(parseParts({ count: 2, fields: { a: 99, b: 2 } })).toEqual({
      count: 2,
      fields: { a: 8, b: 2 },
    });
  });

  it("falls back to 1 for a non-integer field value, keeping siblings", () => {
    expect(parseParts({ count: 2, fields: { a: 1.5, b: 2 } })).toEqual({
      count: 2,
      fields: { a: 1, b: 2 },
    });
  });

  it("falls back to 1 for a string field value, keeping siblings", () => {
    expect(parseParts({ count: 2, fields: { a: "2", b: 2 } })).toEqual({
      count: 2,
      fields: { a: 1, b: 2 },
    });
  });

  it("keeps a valid assignment table unchanged", () => {
    expect(parseParts({ count: 2, fields: { a: 1, b: 2 } })).toEqual({
      count: 2,
      fields: { a: 1, b: 2 },
    });
  });

  it("clamps zero and negative values up to 1", () => {
    expect(parseParts({ count: 2, fields: { a: 0, b: 2 } })).toEqual({
      count: 2,
      fields: { a: 1, b: 2 },
    });
    expect(parseParts({ count: 2, fields: { a: -3, b: 2 } })).toEqual({
      count: 2,
      fields: { a: 1, b: 2 },
    });
  });

  it("keeps the maximum legal part index", () => {
    expect(parseParts({ count: 8, fields: { a: 8, b: 2 } })).toEqual({
      count: 8,
      fields: { a: 8, b: 2 },
    });
  });

  it("collapses non-object fields to an empty map", () => {
    expect(parseParts({ count: 2, fields: [1, 2] })).toEqual({ count: 2, fields: {} });
    expect(parseParts({ count: 2, fields: "nope" })).toEqual({ count: 2, fields: {} });
    expect(parseParts({ count: 2, fields: null })).toEqual({ count: 2, fields: {} });
  });

  it("falls back to a whole-schema plan for a malformed parts value", () => {
    expect(parseParts("nope")).toEqual({ count: 1, fields: {} });
  });

  it("falls back to count 1 for an out-of-range count", () => {
    expect(parseParts({ count: 99, fields: { a: 2 } })).toEqual({ count: 1, fields: { a: 2 } });
  });
});
