/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import { DEFAULT_LOREBOOK_GENERATION_PROMPT } from "../schema/lorebook-generation";
import { at, createTestDb } from "../test-utils";
import { getLorebookGenerationConfig, LOREBOOK_GENERATION_CONFIG_KEY } from "./config";
import { buildLorebookEntryMessages } from "./prompt";

describe("getLorebookGenerationConfig", () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(createTestDb());
  });

  it("returns the full default config when the key is missing", () => {
    expect(getLorebookGenerationConfig(repos)).toEqual({
      enabled: true,
      profile_id: "",
      system_prompt: DEFAULT_LOREBOOK_GENERATION_PROMPT,
      max_response_tokens: 2048,
    });
  });

  it("merges a partial stored object through the schema defaults", () => {
    repos.settings.set(LOREBOOK_GENERATION_CONFIG_KEY, { profile_id: "p1" });
    const config = getLorebookGenerationConfig(repos);
    expect(config.profile_id).toBe("p1");
    // Untouched fields stay at their defaults.
    expect(config.enabled).toBe(true);
    expect(config.system_prompt).toBe(DEFAULT_LOREBOOK_GENERATION_PROMPT);
    expect(config.max_response_tokens).toBe(2048);
  });

  it("falls back per-field on invalid stored values", () => {
    repos.settings.set(LOREBOOK_GENERATION_CONFIG_KEY, {
      enabled: "yes",
      system_prompt: 42,
      max_response_tokens: -1,
    });
    const config = getLorebookGenerationConfig(repos);
    expect(config.enabled).toBe(true);
    expect(config.system_prompt).toBe(DEFAULT_LOREBOOK_GENERATION_PROMPT);
    expect(config.max_response_tokens).toBe(2048);
  });

  it("preserves an explicit enabled: false", () => {
    repos.settings.set(LOREBOOK_GENERATION_CONFIG_KEY, { enabled: false });
    expect(getLorebookGenerationConfig(repos).enabled).toBe(false);
  });
});

describe("buildLorebookEntryMessages", () => {
  it("returns the passed system prompt as the system message", () => {
    const messages = buildLorebookEntryMessages({
      systemPrompt: "SYSTEM PROMPT",
      description: "The ruined cathedral.",
      instructions: "Keep it short.",
      currentContent: "An old entry.",
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: "SYSTEM PROMPT" });
    expect(messages[1]?.role).toBe("user");
  });

  it("labels DESCRIPTION, INSTRUCTIONS and CURRENT CONTENT in order", () => {
    const messages = buildLorebookEntryMessages({
      systemPrompt: "SYSTEM PROMPT",
      description: "The ruined cathedral.",
      instructions: "Keep it short.",
      currentContent: "An old entry.",
    });
    const user = at(messages, 1).content;
    expect(user).toContain("DESCRIPTION: The ruined cathedral.");
    expect(user).toContain("INSTRUCTIONS: Keep it short.");
    expect(user).toContain("CURRENT CONTENT: An old entry.");
    // Stable order: DESCRIPTION → INSTRUCTIONS → CURRENT CONTENT.
    const order = ["DESCRIPTION:", "INSTRUCTIONS:", "CURRENT CONTENT:"].map((label) =>
      user.indexOf(label),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("renders explicit placeholders for empty description, instructions and content", () => {
    const messages = buildLorebookEntryMessages({
      systemPrompt: "SYSTEM PROMPT",
      description: "   ",
      instructions: "",
      currentContent: "",
    });
    const user = at(messages, 1).content;
    expect(user).toContain(
      "DESCRIPTION: (none provided — write a fitting entry from the instructions)",
    );
    expect(user).toContain("INSTRUCTIONS: (none)");
    expect(user).toContain("CURRENT CONTENT: (none)");
  });
});

describe("DEFAULT_LOREBOOK_GENERATION_PROMPT", () => {
  it("carries the key behavioral phrases", () => {
    expect(DEFAULT_LOREBOOK_GENERATION_PROMPT).toContain("Return ONLY the entry content");
    expect(DEFAULT_LOREBOOK_GENERATION_PROMPT).toContain("uncensored");
    expect(DEFAULT_LOREBOOK_GENERATION_PROMPT).toContain("{{char}}");
  });
});
