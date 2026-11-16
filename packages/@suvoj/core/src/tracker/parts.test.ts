/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { buildTrackerParts, MAX_TRACKER_PARTS, type TrackerPartsConfig } from "./parts";

/** A schema with the given top-level field names (all required, in order). */
function objectSchema(names: string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const name of names) {
    properties[name] = { type: "string" };
  }
  return { title: "T", type: "object", properties, required: names };
}

describe("buildTrackerParts", () => {
  it("returns the original schema by reference when unsplittable", () => {
    const schema: Record<string, unknown> = { type: "array", items: { type: "string" } };
    const parts = buildTrackerParts(schema, { count: 4, fields: {} });
    expect(parts).toHaveLength(1);
    expect(parts[0]?.index).toBe(1);
    expect(parts[0]?.fields).toEqual([]);
    expect(parts[0]?.schema).toBe(schema);
  });

  it("treats a missing type as an object and returns the original for count <= 1", () => {
    const schema: Record<string, unknown> = {
      properties: { a: { type: "string" }, b: { type: "string" } },
    };
    const parts = buildTrackerParts(schema, { count: 1, fields: { a: 2 } });
    expect(parts).toEqual([{ index: 1, fields: ["a", "b"], schema }]);
    expect(parts[0]?.schema).toBe(schema);
  });

  it("splits into disjoint subset schemas with filtered required and title", () => {
    const schema = objectSchema(["time", "location", "weather"]);
    const parts = buildTrackerParts(schema, {
      count: 2,
      fields: { time: 1, location: 2, weather: 2 },
    });

    expect(parts.map((part) => part.fields)).toEqual([["time"], ["location", "weather"]]);
    expect(parts.map((part) => part.index)).toEqual([1, 2]);

    expect(parts[0]?.schema).toEqual({
      title: "T",
      type: "object",
      properties: { time: { type: "string" } },
      required: ["time"],
    });
    expect(parts[1]?.schema).toEqual({
      title: "T",
      type: "object",
      properties: { location: { type: "string" }, weather: { type: "string" } },
      required: ["location", "weather"],
    });
    // Subset properties keep the ORIGINAL node objects by reference.
    const properties = schema.properties as Record<string, unknown>;
    const firstProperties = parts[0]?.schema.properties as Record<string, unknown>;
    expect(firstProperties.time).toBe(properties.time);
  });

  it("omits title when it is missing or empty and drops other schema-level keys", () => {
    const schema: Record<string, unknown> = {
      $schema: "http://json-schema.org/draft-07/schema#",
      additionalProperties: false,
      description: "drop me",
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    };
    const [first] = buildTrackerParts(schema, { count: 2, fields: { a: 1, b: 2 } });
    expect(first?.schema).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
    expect(first?.schema).not.toHaveProperty("$schema");
    expect(first?.schema).not.toHaveProperty("additionalProperties");
    expect(first?.schema).not.toHaveProperty("description");
  });

  it("defaults missing and unknown field assignments to part 1", () => {
    const schema = objectSchema(["a", "b", "c"]);
    const parts = buildTrackerParts(schema, { count: 2, fields: { c: 2 } });
    expect(parts.map((part) => part.fields)).toEqual([["a", "b"], ["c"]]);
  });

  it("clamps out-of-range indices and non-integer values to a legal part", () => {
    const schema = objectSchema(["a", "b", "c"]);
    const config: TrackerPartsConfig = { count: 2, fields: { a: 99, b: -1, c: 1.5 } };
    const parts = buildTrackerParts(schema, config);
    // 99 → 2, -1 and 1.5 (non-integer) → 1.
    expect(parts.map((part) => part.fields)).toEqual([["b", "c"], ["a"]]);
  });

  it("drops empty parts and re-numbers survivors from 1", () => {
    const schema = objectSchema(["a", "b", "c"]);
    // All fields land on part 2; parts 1 and 3 are empty.
    const parts = buildTrackerParts(schema, { count: 3, fields: { a: 2, b: 2, c: 2 } });
    expect(parts).toHaveLength(1);
    expect(parts[0]?.index).toBe(1);
    expect(parts[0]?.fields).toEqual(["a", "b", "c"]);
  });

  it("returns the ORIGINAL schema reference when a split collapses to one group", () => {
    // count > 1 but every field lands in request 2: the plan is one request,
    // so a mechanism reading `part.schema` must see the full original schema
    // (description, $schema, …), not a degraded subset.
    const schema: Record<string, unknown> = {
      $schema: "http://json-schema.org/draft-07/schema#",
      description: "keep me",
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    };
    const parts = buildTrackerParts(schema, { count: 2, fields: { a: 2, b: 2 } });
    expect(parts).toHaveLength(1);
    expect(parts[0]?.index).toBe(1);
    expect(parts[0]?.fields).toEqual(["a", "b"]);
    expect(parts[0]?.schema).toBe(schema);
  });

  it("clamps the count to the number of fields", () => {
    const schema = objectSchema(["a", "b"]);
    const parts = buildTrackerParts(schema, { count: 8, fields: { a: 1, b: 2 } });
    expect(parts).toHaveLength(2);
  });

  it("clamps the count to MAX_TRACKER_PARTS", () => {
    const names = Array.from({ length: MAX_TRACKER_PARTS + 2 }, (_, i) => `f${i}`);
    const schema = objectSchema(names);
    const fields: Record<string, number> = {};
    names.forEach((name, i) => {
      fields[name] = i + 1;
    });
    const parts = buildTrackerParts(schema, { count: MAX_TRACKER_PARTS + 4, fields });
    expect(parts).toHaveLength(MAX_TRACKER_PARTS);
    // Out-of-range assignments (f8, f9) land on the last legal part.
    expect(parts.at(-1)?.fields).toEqual(["f7", "f8", "f9"]);
  });

  it("falls back to a single original-schema part for a non-integer count", () => {
    const schema = objectSchema(["a", "b"]);
    const parts = buildTrackerParts(schema, { count: 0.5, fields: {} });
    expect(parts).toEqual([{ index: 1, fields: ["a", "b"], schema }]);
    expect(parts[0]?.schema).toBe(schema);
  });
});
