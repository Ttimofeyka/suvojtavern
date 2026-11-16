/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_TRACKER_HTML,
  effectivePartCount,
  groupFieldsByPart,
  MAX_TRACKER_PARTS,
  normalizeParts,
  normalizeTrackerConfig,
  presetFieldNames,
  readParts,
} from "./tracker-config";
import { renderTemplate } from "./tracker-template";

/** A schema with the given top-level field names (all required, in order). */
function objectSchema(names: string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const name of names) {
    properties[name] = { type: "string" };
  }
  return { title: "T", type: "object", properties, required: names };
}

describe("normalizeTrackerConfig injection format", () => {
  it("parses a stored plain format", () => {
    const config = normalizeTrackerConfig({ injection: { format: "plain" } });
    expect(config.injection.format).toBe("plain");
  });

  it("parses a stored json format", () => {
    const config = normalizeTrackerConfig({ injection: { format: "json" } });
    expect(config.injection.format).toBe("json");
  });

  it("defaults a missing format to plain", () => {
    const config = normalizeTrackerConfig({ injection: { role: "system" } });
    expect(config.injection.format).toBe("plain");
  });

  it("defaults an unknown format to plain", () => {
    const config = normalizeTrackerConfig({ injection: { format: "yaml" } });
    expect(config.injection.format).toBe("plain");
  });

  it("defaults a non-string format to plain", () => {
    const config = normalizeTrackerConfig({ injection: { format: 7 } });
    expect(config.injection.format).toBe("plain");
  });
});

describe("default tracker template", () => {
  it("renders a collapsible Secrets section containing one card per secret", () => {
    const html = renderTemplate(DEFAULT_TRACKER_HTML, {
      location: "Lisbon",
      characters: [],
      offstage: [],
      knownCast: ["Mira"],
      secrets: [
        { fact: "Mira hid the crate", knows: ["Mira"], suspects: ["Kael"] },
        { fact: "Kael owes money", knows: ["Kael"], suspects: [] },
      ],
    });
    // The outer block matches Off-stage: a section summary, collapsed by default.
    expect(html).toContain('<details class="tracker-section tracker-secrets">');
    expect(html).toContain('<summary class="tracker-section-name">Secrets</summary>');
    // Inside it, one collapsed card per secret, labelled by the fact.
    expect(html.match(/<details class="tracker-section tracker-secret">/g)).toHaveLength(2);
    expect(html).toContain("Mira hid the crate");
    expect(html).toContain("Kael owes money");
    expect(html).toContain('Knows</span><span class="tracker-value">Mira');
    // An empty suspects list renders no row; the other secret renders one.
    expect(html.match(/Suspects/g)).toHaveLength(1);
  });
});

describe("normalizeTrackerConfig parts", () => {
  it("fills a legacy preset (no parts) with a single request", () => {
    const config = normalizeTrackerConfig({
      schema_presets: {
        old: { name: "Old", schema: objectSchema(["a", "b"]), html: "", css: "" },
      },
    });
    expect(config.schema_presets.old?.parts).toEqual({ count: 1, fields: {} });
  });

  it("keeps a valid split, clamping indices and dropping entries equal to 1", () => {
    const config = normalizeTrackerConfig({
      schema_presets: {
        p: {
          schema: objectSchema(["a", "b", "c"]),
          parts: { count: 3, fields: { a: 1, b: 3, c: 2 } },
        },
      },
    });
    // a → 1 is omitted (missing already means request 1).
    expect(config.schema_presets.p?.parts).toEqual({ count: 3, fields: { b: 3, c: 2 } });
  });

  it("falls back to a single request for an out-of-range count", () => {
    const config = normalizeTrackerConfig({
      schema_presets: {
        p: {
          schema: objectSchema(["a", "b"]),
          parts: { count: 99, fields: { a: 2 } },
        },
      },
    });
    // 99 is outside [1, MAX_TRACKER_PARTS] → 1, which then collapses the split.
    expect(config.schema_presets.p?.parts).toEqual({ count: 1, fields: {} });
  });

  it("clamps out-of-range indices into the legal range", () => {
    const config = normalizeTrackerConfig({
      schema_presets: {
        p: {
          schema: objectSchema(["a", "b"]),
          parts: { count: 3, fields: { a: 99, b: -5 } },
        },
      },
    });
    // count 3 capped at the field count (2); a's 99 → 2, b's -5 → 1 (omitted).
    expect(config.schema_presets.p?.parts).toEqual({ count: 2, fields: { a: 2 } });
  });

  it("falls back to a single request for a non-integer count", () => {
    const config = normalizeTrackerConfig({
      schema_presets: {
        p: { schema: objectSchema(["a", "b"]), parts: { count: 2.5, fields: { a: 2 } } },
      },
    });
    expect(config.schema_presets.p?.parts).toEqual({ count: 1, fields: {} });
  });

  it("drops entries whose name is not a top-level field", () => {
    const config = normalizeTrackerConfig({
      schema_presets: {
        p: {
          schema: objectSchema(["a", "b"]),
          parts: { count: 2, fields: { a: 2, stale: 2 } },
        },
      },
    });
    expect(config.schema_presets.p?.parts).toEqual({ count: 2, fields: { a: 2 } });
  });

  it("drops non-numeric field entries", () => {
    const config = normalizeTrackerConfig({
      schema_presets: {
        p: {
          schema: objectSchema(["a", "b"]),
          parts: { count: 2, fields: { a: "2", b: 2 } },
        },
      },
    });
    expect(config.schema_presets.p?.parts).toEqual({ count: 2, fields: { b: 2 } });
  });

  it("falls back for a malformed parts value", () => {
    const config = normalizeTrackerConfig({
      schema_presets: { p: { schema: objectSchema(["a"]), parts: "nope" } },
    });
    expect(config.schema_presets.p?.parts).toEqual({ count: 1, fields: {} });
  });
});

describe("readParts", () => {
  // The same per-entry tolerance table core's `trackerPresetPartsSchema`
  // pins in packages/@suvoj/core/src/schema/tracker.test.ts. Failures here
  // mean the two implementations have drifted — fix both together.
  it("clamps an out-of-range sibling without discarding the other entries", () => {
    expect(readParts({ count: 2, fields: { a: 99, b: 2 } })).toEqual({
      count: 2,
      fields: { a: 8, b: 2 },
    });
  });

  it("falls back to 1 (omitted) for a non-integer field value, keeping siblings", () => {
    expect(readParts({ count: 2, fields: { a: 1.5, b: 2 } })).toEqual({
      count: 2,
      fields: { b: 2 },
    });
  });

  it("falls back to 1 (omitted) for a string field value, keeping siblings", () => {
    expect(readParts({ count: 2, fields: { a: "2", b: 2 } })).toEqual({
      count: 2,
      fields: { b: 2 },
    });
  });

  it("keeps valid assignments and omits those equal to 1", () => {
    expect(readParts({ count: 2, fields: { a: 1, b: 2 } })).toEqual({ count: 2, fields: { b: 2 } });
  });

  it("clamps zero and negative values up to 1 (omitted)", () => {
    expect(readParts({ count: 2, fields: { a: 0, b: 2 } })).toEqual({ count: 2, fields: { b: 2 } });
    expect(readParts({ count: 2, fields: { a: -3, b: 2 } })).toEqual({
      count: 2,
      fields: { b: 2 },
    });
  });

  it("keeps the maximum legal part index", () => {
    expect(readParts({ count: 8, fields: { a: 8, b: 2 } })).toEqual({
      count: 8,
      fields: { a: 8, b: 2 },
    });
  });

  it("collapses non-object fields to an empty map", () => {
    expect(readParts({ count: 2, fields: [1, 2] })).toEqual({ count: 2, fields: {} });
    expect(readParts({ count: 2, fields: "nope" })).toEqual({ count: 2, fields: {} });
    expect(readParts({ count: 2, fields: null })).toEqual({ count: 2, fields: {} });
  });

  it("falls back to a whole-schema plan for a malformed parts value", () => {
    expect(readParts("nope")).toEqual({ count: 1, fields: {} });
  });
});

describe("effectivePartCount", () => {
  it("counts non-empty groups", () => {
    expect(effectivePartCount(["a", "b", "c"], { count: 2, fields: { c: 2 } })).toBe(2);
  });

  it("is 1 when a split collapses into one group", () => {
    expect(effectivePartCount(["a", "b"], { count: 3, fields: { a: 2, b: 2 } })).toBe(1);
  });

  it("is 1 when count is 1", () => {
    expect(effectivePartCount(["a", "b"], { count: 1, fields: {} })).toBe(1);
  });

  it("is floored at 1 for an empty schema", () => {
    expect(effectivePartCount([], { count: 1, fields: {} })).toBe(1);
  });
});

describe("presetFieldNames", () => {
  it("returns top-level property names in order", () => {
    expect(presetFieldNames(objectSchema(["time", "location", "weather"]))).toEqual([
      "time",
      "location",
      "weather",
    ]);
  });

  it("treats a missing type as an object", () => {
    expect(presetFieldNames({ properties: { a: {}, b: {} } })).toEqual(["a", "b"]);
  });

  it("returns [] for a non-object schema", () => {
    expect(presetFieldNames({ type: "array", items: { type: "string" } })).toEqual([]);
  });

  it("returns [] when properties is missing or not a plain object", () => {
    expect(presetFieldNames({ type: "object" })).toEqual([]);
    expect(presetFieldNames({ type: "object", properties: ["a", "b"] })).toEqual([]);
  });
});

describe("normalizeParts", () => {
  it("clamps the count to the field count", () => {
    expect(normalizeParts({ count: 8, fields: { a: 2 } }, ["a", "b"])).toEqual({
      count: 2,
      fields: { a: 2 },
    });
  });

  it("caps the count at MAX_TRACKER_PARTS", () => {
    const names = Array.from({ length: MAX_TRACKER_PARTS + 2 }, (_, i) => `f${i}`);
    expect(normalizeParts({ count: 99, fields: {} }, names).count).toBe(MAX_TRACKER_PARTS);
  });

  it("forces a single request for 0 or 1 fields", () => {
    expect(normalizeParts({ count: 4, fields: { a: 4 } }, ["a"])).toEqual({
      count: 1,
      fields: {},
    });
    expect(normalizeParts({ count: 4, fields: {} }, [])).toEqual({ count: 1, fields: {} });
  });

  it("drops stale names and out-of-range parts", () => {
    expect(normalizeParts({ count: 2, fields: { a: 2, b: 9, stale: 2 } }, ["a", "b"])).toEqual({
      count: 2,
      fields: { a: 2, b: 2 },
    });
  });
});

describe("groupFieldsByPart", () => {
  it("assigns unassigned fields to request 1", () => {
    const groups = groupFieldsByPart(["a", "b", "c"], { count: 2, fields: { c: 2 } });
    expect(groups).toEqual([
      { part: 1, fields: ["a", "b"] },
      { part: 2, fields: ["c"] },
    ]);
  });

  it("preserves empty groups (the UI flags them)", () => {
    const groups = groupFieldsByPart(["a", "b"], { count: 3, fields: { a: 2, b: 2 } });
    expect(groups).toEqual([
      { part: 1, fields: [] },
      { part: 2, fields: ["a", "b"] },
      { part: 3, fields: [] },
    ]);
  });

  it("clamps out-of-range assignments into the last group", () => {
    const groups = groupFieldsByPart(["a"], { count: 2, fields: { a: 5 } });
    expect(groups).toEqual([
      { part: 1, fields: [] },
      { part: 2, fields: ["a"] },
    ]);
  });
});
