/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import { createTestDb } from "../test-utils";
import { prepareGeneration } from "./chat";
import { resolveMemorySettings } from "./memory/resolve";
import { summariesConfigSchema } from "./memory/summaries";
import { resetPipelineStages } from "./pipeline";
import { defaultPreset } from "./preset";

/**
 * The global memory settings (`memory_strategy` + `memory_config`,
 * Settings page) override the preset's memory wiring inside
 * `prepareGeneration`; absent/null/unknown values leave the preset as is.
 */
describe("global memory settings", () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(createTestDb());
    resetPipelineStages();
  });

  /** Chat with an over-budget history (same sizing as chat.test.ts). */
  function seedChat(): string {
    const character = repos.characters.create({ name: "Bot" });
    const chat = repos.chats.create({ character_id: character.id });
    for (let i = 0; i < 8; i++) {
      repos.messages.insertMessage(chat.id, { role: "user", content: `long history line ${i}` });
    }
    return chat.id;
  }

  /**
   * Stored level-0 row (a post-response artifact) covering messages 1–2:
   * with it, the summaries strategy elides the covered range even though
   * the history is over budget.
   */
  function seedSummary(chatId: string): void {
    repos.summaries.create(chatId, {
      level: 0,
      seq_from: 1,
      seq_to: 2,
      summary: "sum0",
      tokens: 5,
    });
  }

  /** Stores the only preset with the given memory settings. */
  function storePreset(strategy: string, config: Record<string, unknown> = {}): void {
    const preset = defaultPreset();
    preset.settings.memory = { strategy, config };
    repos.presets.create({
      name: preset.name,
      description: preset.description,
      prompts: preset.prompts,
      settings: preset.settings,
    });
  }

  /** prepareGeneration with the tiny test budget (200 − 150 tokens). */
  function prepare(
    chatId: string,
    summarizeFn: () => Promise<string>,
  ): ReturnType<typeof prepareGeneration> {
    return prepareGeneration({
      repos,
      chatId,
      sampling: { context_size: 200, max_tokens: 150 },
      summarizeFn,
    });
  }

  it("switches a trim preset to the summaries strategy when the setting says so", async () => {
    storePreset("trim", { keep_last: 1 });
    const chatId = seedChat();
    seedSummary(chatId);
    repos.settings.set("memory_strategy", "summaries");
    let calls = 0;
    const result = await prepare(chatId, async () => `sum${++calls}`);
    // The summaries path ran: the stored summary block was injected over
    // the covered range. Assembly never creates level-0 rows anymore, so
    // the summarizer stays silent.
    expect(calls).toBe(0);
    expect(result.summary).toBeDefined();
    expect(result.summary?.text.startsWith("[Summary of past events:")).toBe(true);
    // Only the strategy selection changed; the preset's memory config stayed.
    expect(result.preset.settings.memory.strategy).toBe("summaries");
    expect(result.preset.settings.memory.config).toEqual({ keep_last: 1 });
  });

  it("switches a summaries preset to the trim strategy when the setting says so", async () => {
    storePreset("summaries", { chunk_size: 2, keep_last: 1 });
    const chatId = seedChat();
    repos.settings.set("memory_strategy", "trim");
    let calls = 0;
    const result = await prepare(chatId, async () => `sum${++calls}`);
    // The summaries path was not taken: no summarizer call, no summary
    // block — trimming dropped the oldest messages instead.
    expect(calls).toBe(0);
    expect(result.summary).toBeUndefined();
    const contents = result.messages.map((message) => message.content);
    expect(contents).not.toContain("long history line 0");
    expect(contents).toContain("long history line 7");
    expect(result.preset.settings.memory.strategy).toBe("trim");
  });

  it("keeps the preset's strategy when no setting is stored", async () => {
    storePreset("summaries", { chunk_size: 2, keep_last: 1 });
    const chatId = seedChat();
    seedSummary(chatId);
    let calls = 0;
    const result = await prepare(chatId, async () => `sum${++calls}`);
    expect(result.summary).toBeDefined();
    expect(result.preset.settings.memory.strategy).toBe("summaries");
  });

  it("ignores null and unknown setting values", async () => {
    storePreset("summaries", { chunk_size: 2, keep_last: 1 });
    let calls = 0;
    const summarizeFn = async (): Promise<string> => `sum${++calls}`;

    repos.settings.set("memory_strategy", "banana");
    const chatA = seedChat();
    seedSummary(chatA);
    const unknown = await prepare(chatA, summarizeFn);
    expect(unknown.summary).toBeDefined();
    expect(unknown.preset.settings.memory.strategy).toBe("summaries");

    // The server expresses a null setting by deleting the key.
    repos.settings.delete("memory_strategy");
    const chatB = seedChat();
    seedSummary(chatB);
    const unset = await prepare(chatB, summarizeFn);
    expect(unset.summary).toBeDefined();
    expect(unset.preset.settings.memory.strategy).toBe("summaries");
  });

  it("merges the global memory_config over the preset's summaries config", async () => {
    storePreset("summaries", { chunk_size: 2, summarize_after: 2 });
    repos.settings.set("memory_config", { summaries: { chunk_size: 6 } });
    const chatId = seedChat();
    seedSummary(chatId);
    let calls = 0;
    const result = await prepare(chatId, async () => `sum${++calls}`);
    // Global wins per-field (chunk_size 6); the preset's summarize_after
    // stays; a removed key like keep_last would simply strip at parse.
    expect(result.preset.settings.memory.config).toEqual({
      chunk_size: 6,
      summarize_after: 2,
    });
    expect(result.summary).toBeDefined();
  });

  it("applies the global config of the globally-selected strategy", async () => {
    storePreset("trim", { keep_last: 1 });
    repos.settings.set("memory_strategy", "summaries");
    repos.settings.set("memory_config", { summaries: { chunk_size: 6 }, trim: { keep_last: 2 } });
    const chatId = seedChat();
    seedSummary(chatId);
    let calls = 0;
    const result = await prepare(chatId, async () => `sum${++calls}`);
    // The switch keeps the preset's (trim) config, and the global
    // summaries config merges over it; trim's global entry does not leak.
    expect(result.preset.settings.memory.strategy).toBe("summaries");
    expect(result.preset.settings.memory.config).toEqual({ keep_last: 1, chunk_size: 6 });
    expect(result.summary).toBeDefined();
  });

  it("strips keys the summaries schema no longer knows from a carried config", async () => {
    // A config written before the summaries schema rework (or carried
    // across a strategy switch) holds removed keys like keep_last,
    // trigger_messages, and prompt_template: parsing drops them and fills
    // the defaults instead of crashing the strategy. (The verbatim
    // default prompts are asserted in memory.test.ts.)
    storePreset("trim", { keep_last: 1, trigger_tokens: 100, trigger_messages: 5 });
    repos.settings.set("memory_strategy", "summaries");
    const chatId = seedChat();
    seedSummary(chatId);
    let calls = 0;
    const result = await prepare(chatId, async () => `sum${++calls}`);
    expect(result.preset.settings.memory.strategy).toBe("summaries");
    const defaults = summariesConfigSchema.parse({});
    expect(summariesConfigSchema.parse(result.preset.settings.memory.config)).toEqual({
      chunk_size: 8,
      summarize_after: 30,
      max_snippets_per_layer: 15,
      snippets_per_promotion: 3,
      max_layer_depth: 3,
      strip_patterns: "",
      system_prompt: defaults.system_prompt,
      user_prompt: defaults.user_prompt,
      injection_template: "[Summary of past events: {{summary}}]",
      mark_summarized: false,
    });
    expect(result.summary).toBeDefined();
  });

  it("resets a config that fails the strategy's own schema", () => {
    const preset = defaultPreset();
    preset.settings.memory = { strategy: "summaries", config: { chunk_size: -1 } };
    expect(resolveMemorySettings(repos, preset)).toEqual({ strategy: "summaries", config: {} });
  });

  it("falls back to the preset's config when the global one fails its schema", async () => {
    storePreset("summaries", { chunk_size: 6, keep_last: 1 });
    repos.settings.set("memory_config", { summaries: { chunk_size: -1 } });
    const chatId = seedChat();
    seedSummary(chatId);
    let calls = 0;
    const result = await prepare(chatId, async () => `sum${++calls}`);
    // The invalid override was ignored; the preset's config stands (an
    // applied chunk_size -1 would fail the strategy's own parse).
    expect(result.preset.settings.memory.config).toEqual({ chunk_size: 6, keep_last: 1 });
    expect(result.summary).toBeDefined();
  });

  it("ignores non-object memory_config values", async () => {
    storePreset("summaries", { chunk_size: 6, keep_last: 1 });
    repos.settings.set("memory_config", "nope");
    const chatId = seedChat();
    seedSummary(chatId);
    let calls = 0;
    const result = await prepare(chatId, async () => `sum${++calls}`);
    expect(result.preset.settings.memory.config).toEqual({ chunk_size: 6, keep_last: 1 });
    expect(result.summary).toBeDefined();
  });

  it("leaves the config of custom strategy ids untouched", () => {
    const preset = defaultPreset();
    preset.settings.memory = { strategy: "custom", config: { a: 1 } };
    repos.settings.set("memory_config", { custom: { a: 2 } });
    expect(resolveMemorySettings(repos, preset)).toEqual({
      strategy: "custom",
      config: { a: 1 },
    });
  });
});
