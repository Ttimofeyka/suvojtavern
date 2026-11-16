/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { DEFAULT_TRACKER_SCHEMA } from "./defaults";
import { schemaToExample } from "./schema-to-example";

describe("schemaToExample", () => {
  it("produces the expected nested example from the default schema", () => {
    expect(schemaToExample(DEFAULT_TRACKER_SCHEMA)).toEqual({
      location: "Specific scene location with increasing specificity",
      characters: [
        {
          name: "Character name",
          pronouns:
            "Pronouns copied verbatim from the previous tracker or the card (e.g. she/her). Never re-inferred.",
          outfit: "Complete outfit including underwear when the scene establishes it",
          posture:
            "Physical posture and interaction, plus how put-together or disheveled the character appears",
          wants: "One goal this scene. Write 'N/A' for {{user}}",
          knows:
            "What this character witnessed, was told, or found as evidence. Short fact tags. Write 'N/A' for {{user}}",
          voice:
            "One line of speech style: register, rhythm, vocabulary. Copy verbatim once established.",
        },
      ],
      offstage: [
        {
          name: "Character name",
          pronouns: "Copied verbatim; never re-inferred",
          doing: "One line: current activity. Update only on evidence; otherwise copy verbatim.",
        },
      ],
      knownCast: ["string"],
      secrets: [
        {
          fact: "The fact, stated plainly",
          knows: ["string"],
          suspects: ["string"],
          misled: ["string"],
        },
      ],
    });
  });

  it("prefers example, then const, then the first enum value", () => {
    expect(schemaToExample({ type: "string", example: "kept" })).toBe("kept");
    expect(schemaToExample({ type: "string", example: "kept", description: "ignored" })).toBe(
      "kept",
    );
    expect(schemaToExample({ const: 7, type: "number" })).toBe(7);
    expect(schemaToExample({ enum: ["a", "b"], type: "string" })).toBe("a");
    // An empty enum falls through to the type-based value.
    expect(schemaToExample({ enum: [], type: "string" })).toBe("string");
  });

  it("maps the primitive types and handles missing types", () => {
    expect(schemaToExample({ type: "string" })).toBe("string");
    expect(schemaToExample({ type: "number" })).toBe(0);
    expect(schemaToExample({ type: "integer" })).toBe(0);
    expect(schemaToExample({ type: "boolean" })).toBe(false);
    expect(schemaToExample({})).toBe(null);
    expect(schemaToExample({ type: "array" })).toEqual([]);
    expect(schemaToExample({ type: "array", items: { type: "number" } })).toEqual([0]);
    // Missing type with properties behaves as an object; declaration order
    // is preserved.
    expect(
      schemaToExample({ properties: { b: { type: "string" }, a: { type: "number" } } }),
    ).toEqual({ b: "string", a: 0 });
  });
});
