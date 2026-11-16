/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { at } from "../test-utils";
import {
  buildCharacterSeedMessages,
  CHARACTER_SEED_PROMPT,
  type CharacterSeedPromptInput,
  parseCharacterSeedResponse,
} from "./seed";

const input: CharacterSeedPromptInput = {
  notes: "A drowned cathedral city.",
  name: "",
  tags: [],
  description: "",
  personality: "",
  scenario: "",
  firstMes: "",
  alternateGreetings: [],
  mesExample: "",
  creatorNotes: "",
  generate: ["name", "description", "alternate_greetings"],
  directions: { description: "Lean into the tides." },
  alternateCount: 3,
};

describe("buildCharacterSeedMessages", () => {
  it("uses the fixed seed prompt as the system message", () => {
    const messages = buildCharacterSeedMessages(input);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: CHARACTER_SEED_PROMPT });
    expect(CHARACTER_SEED_PROMPT).toContain("GENERATE");
    expect(CHARACTER_SEED_PROMPT).toContain("JSON object");
  });

  it("labels every knowledge field and renders explicit placeholders", () => {
    const user = at(buildCharacterSeedMessages(input), 1).content;
    expect(user).toContain("CONCEPT NOTES:\nA drowned cathedral city.");
    expect(user).toContain("NAME: (none)");
    expect(user).toContain("TAGS: (none)");
    expect(user).toContain("DESCRIPTION:\n(none)");
    expect(user).toContain("PERSONALITY:\n(none)");
    expect(user).toContain("SCENARIO:\n(none)");
    expect(user).toContain("FIRST MESSAGE:\n(none)");
    expect(user).toContain("ALTERNATE GREETINGS:\n(none)");
    expect(user).toContain("EXAMPLE DIALOGUE:\n(none)");
    expect(user).toContain("CREATOR NOTES:\n(none)");
  });

  it("carries the alternate count, canonical generate order and directions", () => {
    const user = at(buildCharacterSeedMessages(input), 1).content;
    expect(user).toContain("ALTERNATE GREETINGS COUNT: 3");
    expect(user).toContain("GENERATE: name, description, alternate_greetings");
    expect(user).toContain("DESCRIPTION: Lean into the tides.");
    expect(user).toContain("NAME: (none — follow the concept and the other fields)");
  });

  it("formats existing tags and alternates as context", () => {
    const user = at(
      buildCharacterSeedMessages({
        ...input,
        tags: ["flooded", "gothic"],
        alternateGreetings: ["One opening.", "Another opening."],
      }),
      1,
    ).content;
    expect(user).toContain("TAGS: flooded, gothic");
    expect(user).toContain("ALTERNATE GREETINGS:\n#2\nOne opening.\n\n#3\nAnother opening.");
  });

  it("drops unknown generate keys and keeps the canonical order", () => {
    const user = at(
      buildCharacterSeedMessages({
        ...input,
        generate: ["creator_notes", "name", "not_a_field" as "name"],
      }),
      1,
    ).content;
    expect(user).toContain("GENERATE: name, creator_notes");
  });
});

describe("parseCharacterSeedResponse", () => {
  it("parses a fenced object and keeps only requested fields", () => {
    const fields = parseCharacterSeedResponse(
      '```json\n{"name":"Aria","description":" A city. ","creator_notes":"ignored"}\n```',
      ["name", "description"],
    );
    expect(fields).toEqual({ name: "Aria", description: "A city." });
  });

  it("normalizes tags and alternate greetings", () => {
    const fields = parseCharacterSeedResponse(
      JSON.stringify({
        tags: [" fantasy ", "fantasy", "", "mage"],
        alternate_greetings: [" One. ", "  ", "Two.", "One."],
      }),
      ["tags", "alternate_greetings"],
    );
    expect(fields).toEqual({
      tags: ["fantasy", "mage"],
      alternate_greetings: ["One.", "Two."],
    });
  });

  it("repairs smart quotes and trailing commas through the shared parser", () => {
    const fields = parseCharacterSeedResponse(
      '{"name": “Aria”, "description": "The city wakes,",}',
      ["name", "description"],
    );
    expect(fields).toEqual({ name: "Aria", description: "The city wakes," });
  });

  it("drops wrong types, blank strings and unrequested keys", () => {
    const fields = parseCharacterSeedResponse(
      JSON.stringify({
        name: "Aria",
        description: 42,
        tags: "not-an-array",
        creator_notes: "Not requested.",
      }),
      ["name", "description", "tags"],
    );
    expect(fields).toEqual({ name: "Aria" });
  });

  it("throws when nothing usable was returned", () => {
    expect(() => parseCharacterSeedResponse('{"other":"x"}', ["name"])).toThrow(
      /did not return any of the marked fields/,
    );
    expect(() =>
      parseCharacterSeedResponse('{"name":42,"description":"  "}', ["name", "description"]),
    ).toThrow(/did not return any of the marked fields/);
    expect(() => parseCharacterSeedResponse("not json", ["name"])).toThrow(
      /Failed to parse JSON object:/,
    );
  });
});
