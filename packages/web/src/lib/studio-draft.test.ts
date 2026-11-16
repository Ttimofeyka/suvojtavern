/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { Character } from "./api-characters";
import {
  applyGeneratedFields,
  auraFrom,
  coerceStudioDraft,
  countWords,
  draftContext,
  draftFromCharacter,
  draftStats,
  draftsEqual,
  draftToInput,
  emptyStudioDraft,
  normalizeStudioTags,
  writeField,
} from "./studio-draft";

const character: Character = {
  id: "c1",
  name: "Aria",
  description: "A floating city.",
  personality: "Guarded.",
  scenario: "The docks at dawn.",
  first_mes: "You made it.",
  mes_example: "<START>\n{{user}}: Hello.\n{{char}}: You are late.",
  creator_notes: "Play her wary.",
  system_prompt: "SYSTEM",
  post_history_instructions: "POST",
  alternate_greetings: ["Another opening."],
  tags: ["fantasy", "mage"],
  avatar_path: "data/blobs/a.webp",
  card_raw: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("emptyStudioDraft", () => {
  it("returns independent arrays", () => {
    const a = emptyStudioDraft();
    const b = emptyStudioDraft();
    a.tags.push("x");
    a.alternate_greetings.push("hi");
    expect(b.tags).toEqual([]);
    expect(b.alternate_greetings).toEqual([]);
  });
});

describe("draftFromCharacter", () => {
  it("copies every stored field without sharing arrays", () => {
    const draft = draftFromCharacter(character);
    expect(draft.name).toBe("Aria");
    expect(draft.system_prompt).toBe("SYSTEM");
    expect(draft.post_history_instructions).toBe("POST");
    draft.tags.push("new");
    expect(character.tags).toEqual(["fantasy", "mage"]);
    draft.alternate_greetings.push("new");
    expect(character.alternate_greetings).toEqual(["Another opening."]);
  });
});

describe("draftToInput", () => {
  it("trims the name and greetings, drops blank greetings, and normalizes tags", () => {
    const draft = {
      ...draftFromCharacter(character),
      name: "  Aria  ",
      first_mes: "  You made it.  ",
      alternate_greetings: ["  Second.  ", "   ", "Second."],
      tags: [" fantasy ", "fantasy", "", "mage"],
    };
    const input = draftToInput(draft);
    expect(input.name).toBe("Aria");
    expect(input.first_mes).toBe("You made it.");
    expect(input.alternate_greetings).toEqual(["Second.", "Second."]);
    expect(input.tags).toEqual(["fantasy", "mage"]);
  });
});

describe("normalizeStudioTags", () => {
  it("preserves first-seen order", () => {
    expect(normalizeStudioTags(["b", "a", "b", " "])).toEqual(["b", "a"]);
  });
});

describe("draftsEqual", () => {
  it("is true for the same content and false for an array/order change", () => {
    expect(draftsEqual(emptyStudioDraft(), emptyStudioDraft())).toBe(true);
    const a = { ...emptyStudioDraft(), tags: ["a", "b"] };
    const b = { ...emptyStudioDraft(), tags: ["b", "a"] };
    expect(draftsEqual(a, b)).toBe(false);
  });
});

describe("countWords", () => {
  it("counts prose and treats whitespace as zero", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n ")).toBe(0);
    expect(countWords("one two   three")).toBe(3);
  });
});

describe("draftStats", () => {
  it("counts filled fields, tags and greetings", () => {
    const stats = draftStats(draftFromCharacter(character));
    // name, description, personality, scenario, first_mes, mes_example,
    // creator_notes, tags = 8 of 8.
    expect(stats.filledFields).toBe(8);
    expect(stats.totalFields).toBe(8);
    expect(stats.percent).toBe(100);
    expect(stats.tags).toBe(2);
    expect(stats.greetings).toBe(2);
    expect(stats.words).toBeGreaterThan(0);
  });

  it("is 0% for an empty draft", () => {
    expect(draftStats(emptyStudioDraft())).toMatchObject({
      filledFields: 0,
      percent: 0,
      words: 0,
      greetings: 0,
    });
  });
});

describe("applyGeneratedFields", () => {
  it("merges the generated subset and normalizes lists", () => {
    const base = {
      ...emptyStudioDraft(),
      description: "Kept until replaced.",
      system_prompt: "SYSTEM",
    };
    const next = applyGeneratedFields(base, {
      name: "  Aria  ",
      tags: [" fantasy ", "fantasy", "", "mage"],
      description: "  A drowned city.  ",
      personality: "Guarded.",
      alternate_greetings: [" One. ", "  ", "Two.", "One."],
    });
    expect(next.name).toBe("Aria");
    expect(next.tags).toEqual(["fantasy", "mage"]);
    expect(next.description).toBe("A drowned city.");
    expect(next.personality).toBe("Guarded.");
    expect(next.alternate_greetings).toEqual(["One.", "Two."]);
    // Untouched and advanced fields survive.
    expect(next.system_prompt).toBe("SYSTEM");
    expect(next.scenario).toBe("");
  });

  it("does not share arrays with the source draft or the result", () => {
    const base = { ...emptyStudioDraft(), tags: ["old"], alternate_greetings: ["old"] };
    const tags = ["new"];
    const greetings = ["new greeting"];
    const next = applyGeneratedFields(base, { tags, alternate_greetings: greetings });
    expect(base.tags).toEqual(["old"]);
    expect(next.tags).toEqual(["new"]);
    expect(next.tags).not.toBe(tags);
    expect(next.alternate_greetings).not.toBe(greetings);
  });

  it("ignores blank strings and wrong types", () => {
    const base = { ...emptyStudioDraft(), name: "Kept" };
    expect(
      applyGeneratedFields(base, {
        name: "   ",
        description: 42 as unknown as string,
        tags: "not-a-list" as unknown as string[],
      }),
    ).toEqual(base);
  });
});

describe("writeField", () => {
  it("replaces a scalar immutably", () => {
    const base = emptyStudioDraft();
    const next = writeField(base, "scenario", "A storm.");
    expect(next.scenario).toBe("A storm.");
    expect(base.scenario).toBe("");
  });
});

describe("draftContext", () => {
  it("omits the target field and labels the others", () => {
    const context = draftContext(draftFromCharacter(character), "personality");
    expect(context).toContain("DESCRIPTION:\nA floating city.");
    expect(context).not.toContain("PERSONALITY:");
    expect(context).toContain("SCENARIO:\nThe docks at dawn.");
    expect(context).toContain("ALTERNATE GREETINGS:");
  });

  it("is empty when the only content is the target field", () => {
    const draft = { ...emptyStudioDraft(), description: "Only this." };
    expect(draftContext(draft, "description")).toBe("");
  });

  it("caps a very large context", () => {
    const draft = { ...emptyStudioDraft(), description: "x".repeat(6000) };
    const context = draftContext(draft, "scenario");
    expect(context.length).toBeLessThanOrEqual(5000);
    expect(context.endsWith("...")).toBe(true);
  });
});

describe("auraFrom", () => {
  it("is deterministic and differs by name", () => {
    expect(auraFrom("Aria")).toEqual(auraFrom("Aria"));
    expect(auraFrom("Aria").angle).not.toBe(auraFrom("Bram").angle);
  });

  it("uses the first letter or a fallback glyph", () => {
    expect(auraFrom("aria").initial).toBe("A");
    expect(auraFrom("   ", "the city").initial).toBe("T");
    expect(auraFrom("").initial).toBe("U");
  });

  it("keeps its numeric ranges", () => {
    const aura = auraFrom("A character with a very long name");
    expect(aura.angle).toBeGreaterThanOrEqual(0);
    expect(aura.angle).toBeLessThan(360);
    expect(aura.x).toBeGreaterThanOrEqual(18);
    expect(aura.y).toBeGreaterThanOrEqual(8);
    expect(aura.mixA).toBeGreaterThanOrEqual(42);
    expect(aura.mixB).toBeGreaterThanOrEqual(16);
  });
});

describe("coerceStudioDraft", () => {
  it("fills missing fields and rejects unrelated values", () => {
    const draft = coerceStudioDraft({ name: "Aria", tags: ["a", 2] });
    expect(draft?.name).toBe("Aria");
    expect(draft?.tags).toEqual(["a"]);
    expect(draft?.description).toBe("");
    expect(coerceStudioDraft({ nothing: true })).toBeNull();
    expect(coerceStudioDraft(null)).toBeNull();
    expect(coerceStudioDraft("nope")).toBeNull();
  });
});
