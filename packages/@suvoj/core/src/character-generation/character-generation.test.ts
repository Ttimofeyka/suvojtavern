/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import { DEFAULT_CHARACTER_GENERATION_PROMPT } from "../schema/character-generation";
import { at, createTestDb } from "../test-utils";
import { CHARACTER_GENERATION_CONFIG_KEY, getCharacterGenerationConfig } from "./config";
import {
  buildCharacterDescriptionMessages,
  buildCharacterFieldMessages,
  CHARACTER_FIELD_PROMPTS,
} from "./prompt";

describe("getCharacterGenerationConfig", () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(createTestDb());
  });

  it("returns the full default config when the key is missing", () => {
    expect(getCharacterGenerationConfig(repos)).toEqual({
      enabled: true,
      profile_id: "",
      system_prompt: DEFAULT_CHARACTER_GENERATION_PROMPT,
      max_response_tokens: 2048,
    });
  });

  it("merges a partial stored object through the schema defaults", () => {
    repos.settings.set(CHARACTER_GENERATION_CONFIG_KEY, { profile_id: "p1" });
    const config = getCharacterGenerationConfig(repos);
    expect(config.profile_id).toBe("p1");
    // Untouched fields stay at their defaults.
    expect(config.system_prompt).toBe(DEFAULT_CHARACTER_GENERATION_PROMPT);
    expect(config.max_response_tokens).toBe(2048);
  });

  it("falls back per-field on an invalid stored value", () => {
    repos.settings.set(CHARACTER_GENERATION_CONFIG_KEY, {
      system_prompt: 42,
      max_response_tokens: -1,
    });
    const config = getCharacterGenerationConfig(repos);
    expect(config.system_prompt).toBe(DEFAULT_CHARACTER_GENERATION_PROMPT);
    expect(config.max_response_tokens).toBe(2048);
  });

  it("preserves an explicit enabled: false", () => {
    repos.settings.set(CHARACTER_GENERATION_CONFIG_KEY, { enabled: false });
    expect(getCharacterGenerationConfig(repos).enabled).toBe(false);
  });

  it("falls back to enabled: true on an invalid stored value", () => {
    repos.settings.set(CHARACTER_GENERATION_CONFIG_KEY, { enabled: "yes" });
    expect(getCharacterGenerationConfig(repos).enabled).toBe(true);
  });
});

describe("buildCharacterDescriptionMessages", () => {
  it("returns the passed system prompt as the system message", () => {
    const messages = buildCharacterDescriptionMessages({
      systemPrompt: "SYSTEM PROMPT",
      name: "Seraphina",
      tags: ["fantasy"],
      idea: "A secluded academy.",
      currentDescription: "An old description.",
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: "SYSTEM PROMPT" });
    expect(messages[1]?.role).toBe("user");
  });

  it("labels NAME, TAGS, IDEA and CURRENT DESCRIPTION in order", () => {
    const messages = buildCharacterDescriptionMessages({
      systemPrompt: "SYSTEM PROMPT",
      name: "Seraphina",
      tags: ["fantasy", "romance"],
      idea: "A secluded academy.",
      currentDescription: "A traveler.",
    });
    const user = at(messages, 1).content;
    expect(user).toContain("NAME: Seraphina");
    expect(user).toContain("TAGS: fantasy, romance");
    expect(user).toContain("IDEA: A secluded academy.");
    expect(user).toContain("CURRENT DESCRIPTION: A traveler.");
    // Stable order: NAME → TAGS → IDEA → CURRENT DESCRIPTION.
    const order = ["NAME:", "TAGS:", "IDEA:", "CURRENT DESCRIPTION:"].map((label) =>
      user.indexOf(label),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("renders explicit placeholders for empty tags, idea and description", () => {
    const messages = buildCharacterDescriptionMessages({
      systemPrompt: "SYSTEM PROMPT",
      name: "Seraphina",
      tags: [],
      idea: "   ",
      currentDescription: "",
    });
    const user = at(messages, 1).content;
    expect(user).toContain("TAGS: (none)");
    expect(user).toContain("IDEA: (none provided — invent a fitting concept)");
    expect(user).toContain("CURRENT DESCRIPTION: (none)");
  });
});

describe("buildCharacterFieldMessages", () => {
  it("returns the fixed prompt as the system message and labels the field", () => {
    const messages = buildCharacterFieldMessages({
      systemPrompt: CHARACTER_FIELD_PROMPTS.personality,
      field: "personality",
      name: "Seraphina",
      tags: ["fantasy"],
      idea: "Make her guarded.",
      currentText: "She is calm.",
      context: "DESCRIPTION:\nA floating academy.",
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: CHARACTER_FIELD_PROMPTS.personality });
    const user = at(messages, 1).content;
    expect(user).toContain("NAME: Seraphina");
    expect(user).toContain("TAGS: fantasy");
    expect(user).toContain("FIELD: personality");
    expect(user).toContain("DIRECTION: Make her guarded.");
    expect(user).toContain("CONTEXT:\nDESCRIPTION:\nA floating academy.");
    expect(user).toContain("CURRENT PERSONALITY:\nShe is calm.");
  });

  it("renders explicit placeholders for empty direction, context and text", () => {
    const messages = buildCharacterFieldMessages({
      systemPrompt: "SYSTEM",
      field: "scenario",
      name: "Aria",
      tags: [],
      idea: "   ",
      currentText: "",
      context: "\n",
    });
    const user = at(messages, 1).content;
    expect(user).toContain("TAGS: (none)");
    expect(user).toContain("DIRECTION: (none — follow the concept already in the context)");
    expect(user).toContain("CONTEXT:\n(none)");
    expect(user).toContain("CURRENT SCENARIO:\n(none)");
  });
});

describe("CHARACTER_FIELD_PROMPTS", () => {
  it("covers every generated field except description", () => {
    expect(Object.keys(CHARACTER_FIELD_PROMPTS).sort()).toEqual([
      "creator_notes",
      "first_mes",
      "mes_example",
      "personality",
      "scenario",
    ]);
  });

  it("keeps the house rules in every prompt", () => {
    for (const prompt of Object.values(CHARACTER_FIELD_PROMPTS)) {
      expect(prompt).toContain("Return ONLY");
    }
    expect(CHARACTER_FIELD_PROMPTS.first_mes).toContain("{{char}}");
    expect(CHARACTER_FIELD_PROMPTS.mes_example).toContain("<START>");
    expect(CHARACTER_FIELD_PROMPTS.creator_notes).toContain("never sent to the model");
  });
});

describe("DEFAULT_CHARACTER_GENERATION_PROMPT", () => {
  it("carries the key behavioral phrases", () => {
    expect(DEFAULT_CHARACTER_GENERATION_PROMPT).toContain("not a character but a world");
    expect(DEFAULT_CHARACTER_GENERATION_PROMPT).toContain("NPCs");
    expect(DEFAULT_CHARACTER_GENERATION_PROMPT).toContain("uncensored");
    expect(DEFAULT_CHARACTER_GENERATION_PROMPT).toContain("by the start of the scenario");
  });
});
