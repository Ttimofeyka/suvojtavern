/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import { createTestDb } from "../test-utils";
import { prepareGeneration } from "./chat";
import { GLOBAL_LOREBOOKS_KEY, resetPipelineStages } from "./pipeline";
import { defaultPreset, type Preset, promptSchema } from "./preset";

describe("prepareGeneration", () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(createTestDb());
    resetPipelineStages();
  });

  /** Stores a preset row from a native preset; returns its id. */
  function storePreset(preset: Preset = defaultPreset()): string {
    return repos.presets.create({
      name: preset.name,
      description: preset.description,
      prompts: preset.prompts,
      settings: preset.settings,
    }).id;
  }

  function seed(): { chatId: string; characterName: string } {
    const character = repos.characters.create({
      name: "Seraphina",
      description: "{{char}} is a catgirl.",
      system_prompt: "System prompt for {{char}}.",
      post_history_instructions: "End note.",
    });
    const persona = repos.personas.create({ name: "Alex", description: "A traveler." });
    const chat = repos.chats.create({ character_id: character.id, persona_id: persona.id });
    const book = repos.lorebooks.create({ name: "Book" });
    repos.lorebooks.addEntry(book.id, {
      keys: [],
      content: "The world lore is always active.",
      constant: true,
      position: 0,
    });
    repos.lorebooks.attachToCharacter(character.id, book.id);
    for (let i = 0; i < 3; i++) {
      repos.messages.insertMessage(chat.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i}`,
      });
    }
    return { chatId: chat.id, characterName: character.name };
  }

  it("assembles a full prompt from repository state", async () => {
    const { chatId } = seed();
    const result = await prepareGeneration({ repos, chatId });
    const contents = result.messages.map((message) => message.content);
    // Lorebook (constant, before char defs) + history. The character's
    // system_prompt / post_history_instructions never render — main and
    // jailbreak content comes from the preset only (empty in the default).
    expect(contents).toContain("The world lore is always active.");
    expect(contents).not.toContain("System prompt for Seraphina.");
    expect(contents).toContain("turn 0");
    expect(contents).toContain("turn 2");
    expect(contents).not.toContain("End note.");
    // Macro context is wired from chat + persona.
    expect(contents).toContain("Seraphina is a catgirl.");
    const firstUser = result.messages.find((message) => message.role === "user");
    expect(firstUser?.name).toBe("Alex");
    // No profile → empty sampling and the default budget.
    expect(result.sampling).toEqual({});
    expect(result.budget.context).toBe(128000);
    expect(result.lorebook?.activatedIds.size).toBe(1);
  });

  it("scans only enabled character links and global lorebooks", async () => {
    const { chatId } = seed();
    const characterId = repos.chats.get(chatId)?.character_id;
    expect(characterId).toBeString();

    // Attached but disabled — the link exists yet must never inject.
    const disabled = repos.lorebooks.create({ name: "Disabled" });
    repos.lorebooks.addEntry(disabled.id, {
      keys: [],
      content: "Disabled-link lore.",
      constant: true,
      position: 0,
    });
    repos.lorebooks.attachToCharacter(characterId as string, disabled.id);
    expect(repos.lorebooks.setAttachmentEnabled(characterId as string, disabled.id, false)).toBe(
      true,
    );

    // Global — attached to no character, injected everywhere.
    const global = repos.lorebooks.create({ name: "Global" });
    repos.lorebooks.addEntry(global.id, {
      keys: [],
      content: "Global lore.",
      constant: true,
      position: 0,
    });
    repos.settings.set(GLOBAL_LOREBOOKS_KEY, { ids: [global.id] });

    const result = await prepareGeneration({ repos, chatId });
    // Constant entries may share one system message — assert on the joined
    // text so the assembler's grouping doesn't matter.
    const text = result.messages.map((message) => message.content).join("\n");
    expect(text).toContain("The world lore is always active."); // enabled link
    expect(text).toContain("Global lore."); // global
    expect(text).not.toContain("Disabled-link lore."); // disabled link
  });

  it("throws on unknown chats and presets", async () => {
    const { chatId } = seed();
    await expect(prepareGeneration({ repos, chatId: "does-not-exist" })).rejects.toThrow(
      "chat does-not-exist not found",
    );
    await expect(prepareGeneration({ repos, chatId, presetId: "nope" })).rejects.toThrow(
      "preset nope not found",
    );
  });

  it("uses the stored preset when one exists", async () => {
    const storedId = storePreset();
    const { chatId } = seed();
    const result = await prepareGeneration({ repos, chatId });
    expect(result.preset.id).toBe(storedId);
    const byId = await prepareGeneration({ repos, chatId, presetId: storedId });
    expect(byId.preset.id).toBe(storedId);
    expect(byId.messages.length).toBeGreaterThan(0);
  });

  it("resolves the default_preset_id setting when no explicit id is given", async () => {
    const firstId = storePreset();
    const second = defaultPreset();
    second.name = "Second";
    const secondMain = second.prompts.find((prompt) => prompt.id === "main");
    if (secondMain) {
      secondMain.content = "SECOND MAIN";
    }
    const secondId = storePreset(second);
    const { chatId } = seed();

    // The setting wins over the first stored preset…
    repos.settings.set("default_preset_id", secondId);
    const bySetting = await prepareGeneration({ repos, chatId });
    expect(bySetting.preset.id).toBe(secondId);
    expect(bySetting.messages.map((message) => message.content)).toContain("SECOND MAIN");

    // …a stale setting id falls back to the first stored preset…
    repos.settings.set("default_preset_id", "deleted-preset");
    const stale = await prepareGeneration({ repos, chatId });
    expect(stale.preset.id).toBe(firstId);

    // …and an explicit id still beats the setting.
    const explicit = await prepareGeneration({ repos, chatId, presetId: secondId });
    expect(explicit.preset.id).toBe(secondId);
  });

  it("resolves {{#has:…}} against the enabled rows of the effective preset", async () => {
    // One row defines `<optional>`; another cites it conditionally. With the
    // defining row ON the citation renders; switching it off must remove the
    // citation from the prompt entirely — the tag never reaches the model.
    const preset = defaultPreset();
    const main = preset.prompts.find((prompt) => prompt.id === "main");
    if (main) {
      main.content = "MAIN {{#has:optional}}CITED{{/has}}{{^has:optional}}ABSENT{{/has}}";
    }
    const definer = promptSchema.parse({
      id: "definer",
      name: "Definer",
      content: "<optional>payload</optional>",
      enabled: true,
    });
    preset.prompts.push(definer);
    storePreset(preset);
    const { chatId } = seed();

    const on = await prepareGeneration({ repos, chatId });
    const onText = on.messages.map((message) => message.content).join("\n");
    expect(onText).toContain("MAIN CITED");
    expect(onText).not.toContain("ABSENT");
    expect(onText).not.toContain("{{#has:");

    // Disable the defining row through the control machinery's own switch.
    const off = defaultPreset();
    const offMain = off.prompts.find((prompt) => prompt.id === "main");
    if (offMain) {
      offMain.content = "MAIN {{#has:optional}}CITED{{/has}}{{^has:optional}}ABSENT{{/has}}";
    }
    off.prompts.push(promptSchema.parse({ ...definer, enabled: false }));
    repos.presets.delete(repos.presets.list()[0]?.id ?? "");
    storePreset(off);

    const disabled = await prepareGeneration({ repos, chatId });
    const disabledText = disabled.messages.map((message) => message.content).join("\n");
    expect(disabledText).toContain("MAIN ABSENT");
    expect(disabledText).not.toContain("CITED");
    expect(disabledText).not.toContain("payload");
    expect(disabledText).not.toContain("{{#has:");
  });

  it("drives the budget from the connection-profile samplers", async () => {
    storePreset();
    const { chatId } = seed();
    const result = await prepareGeneration({
      repos,
      chatId,
      sampling: { temperature: 0.5, context_size: 32000, max_tokens: 2000 },
    });
    expect(result.sampling).toEqual({ temperature: 0.5, context_size: 32000, max_tokens: 2000 });
    expect(result.budget.context).toBe(32000);
    // Omitted again → empty sampling and the default budget.
    const fallback = await prepareGeneration({ repos, chatId });
    expect(fallback.sampling).toEqual({});
    expect(fallback.budget.context).toBe(128000);
  });

  it("applies stored control choices to the prompts and the {{ui}} macro", async () => {
    const preset = defaultPreset();
    const main = preset.prompts.find((prompt) => prompt.id === "main");
    if (main) {
      main.content = "POV: {{ui:pov}}.";
    }
    // Two mutually exclusive rows plus the control that switches them.
    preset.prompts.push(
      promptSchema.parse({
        id: "pov-first",
        name: "First person",
        content: "FIRST PERSON ROW",
        enabled: true,
      }),
      promptSchema.parse({
        id: "pov-third",
        name: "Third person",
        content: "THIRD PERSON ROW",
        enabled: false,
      }),
    );
    preset.settings.controls = [
      {
        id: "pov",
        label: "Point of view",
        type: "select",
        default: "third",
        options: [
          { id: "first", label: "First", value: "first person", prompts: ["pov-first"] },
          { id: "third", label: "Third", value: "third person", prompts: ["pov-third"] },
        ],
      },
    ];
    // Stored choice wins over the control's own default.
    preset.settings.control_values = { pov: "third" };
    storePreset(preset);
    const { chatId } = seed();

    const chosen = await prepareGeneration({ repos, chatId });
    const texts = chosen.messages.map((message) => message.content);
    expect(texts).toContain("POV: third person.");
    expect(texts).toContain("THIRD PERSON ROW");
    expect(texts).not.toContain("FIRST PERSON ROW");
    // `loadPreset` exposes the EFFECTIVE pipeline to every consumer.
    expect(chosen.preset.prompts.find((row) => row.id === "pov-first")?.enabled).toBe(false);
    expect(chosen.preset.prompts.find((row) => row.id === "pov-third")?.enabled).toBe(true);

    // A preset storing NO choice resolves to the control's `default`
    // (here "first"), both for the flags and for the macro text.
    const noChoice = defaultPreset();
    const noChoiceMain = noChoice.prompts.find((row) => row.id === "main");
    if (noChoiceMain) {
      noChoiceMain.content = "POV: {{ui:pov}}.";
    }
    noChoice.prompts.push(
      promptSchema.parse({ id: "pov-first", name: "First", content: "FIRST PERSON ROW" }),
      promptSchema.parse({
        id: "pov-third",
        name: "Third",
        content: "THIRD PERSON ROW",
        enabled: false,
      }),
    );
    noChoice.settings.controls = [
      {
        id: "pov",
        type: "select",
        default: "first",
        options: [
          { id: "first", label: "First", value: "first person", prompts: ["pov-first"] },
          { id: "third", label: "Third", value: "third person", prompts: ["pov-third"] },
        ],
      },
    ];
    repos.settings.set("default_preset_id", storePreset(noChoice));
    const flipped = await prepareGeneration({ repos, chatId });
    const flippedTexts = flipped.messages.map((message) => message.content);
    expect(flippedTexts).toContain("POV: first person.");
    expect(flippedTexts).toContain("FIRST PERSON ROW");
    expect(flippedTexts).not.toContain("THIRD PERSON ROW");
  });

  it("merges caller-supplied uiValues over the preset's own control values", async () => {
    const preset = defaultPreset();
    const main = preset.prompts.find((prompt) => prompt.id === "main");
    if (main) {
      main.content = "POV: {{ui:pov}} / tone: {{ui:plugin:mood:tone}}.";
    }
    preset.settings.controls = [
      {
        id: "pov",
        type: "select",
        default: "first",
        options: [
          { id: "first", label: "First", value: "first person", prompts: [] },
          { id: "third", label: "Third", value: "third person", prompts: [] },
        ],
      },
    ];
    preset.settings.control_values = { pov: "third" };
    storePreset(preset);
    const { chatId } = seed();

    // Plugin-contributed values arrive under a namespaced key; core knows
    // nothing about plugins, it just merges the plain map OVER its own.
    const result = await prepareGeneration({
      repos,
      chatId,
      uiValues: { "plugin:mood:tone": "warm" },
    });
    const text = result.messages.map((message) => message.content).join("\n");
    expect(text).toContain("POV: third person / tone: warm.");

    // The plugin key can also shadow a bare preset id without breaking the
    // other preset controls: spread order means the input map wins.
    const shadowed = await prepareGeneration({
      repos,
      chatId,
      uiValues: { pov: "overridden" },
    });
    expect(shadowed.messages.map((message) => message.content).join("\n")).toContain(
      "POV: overridden",
    );
  });

  it("passes the summarizeFn through to the summaries strategy", async () => {
    const character = repos.characters.create({ name: "Bot" });
    const chat = repos.chats.create({ character_id: character.id });
    for (let i = 0; i < 8; i++) {
      repos.messages.insertMessage(chat.id, { role: "user", content: `long history line ${i}` });
    }
    const preset = defaultPreset();
    preset.settings.memory = {
      strategy: "summaries",
      config: { snippets_per_promotion: 2, summarize_after: 2 },
    };
    storePreset(preset);
    // Stored level-0 rows (post-response artifacts) covering 1–4.
    repos.summaries.create(chat.id, {
      level: 0,
      seq_from: 1,
      seq_to: 2,
      summary: "sum1",
      tokens: 5,
    });
    repos.summaries.create(chat.id, {
      level: 0,
      seq_from: 3,
      seq_to: 4,
      summary: "sum2",
      tokens: 5,
    });
    let calls = 0;
    const result = await prepareGeneration({
      repos,
      chatId: chat.id,
      sampling: { context_size: 200, max_tokens: 170 },
      summarizeFn: async () => `sum${++calls}`,
    });
    // Over budget: the two level-0 rows rolled up through the injected
    // summarizer (assembly-time level-0 creation is gone).
    expect(calls).toBe(1);
    const summaryMessage = result.messages.find((message) =>
      message.content.startsWith("[Summary of past events:"),
    );
    expect(summaryMessage).toBeDefined();
    expect(result.summary).toBeDefined();
  });

  it("drops the trailing assistant turn for regenerate/swipe, but keeps it for normal/continue", async () => {
    const { chatId } = seed();
    repos.messages.insertMessage(chatId, { role: "assistant", content: "old option" });
    const contents = (result: { messages: { content: string }[] }) =>
      result.messages.map((message) => message.content);

    // Regenerate replaces the trailing assistant row, so the prompt ends on
    // the user turn instead of continuing the option it drops.
    const regenerated = await prepareGeneration({ repos, chatId, generationType: "regenerate" });
    expect(contents(regenerated)).not.toContain("old option");
    expect(contents(regenerated)).toContain("turn 2");

    // A swipe is a regenerate server-side; treat the raw type the same.
    const swipe = await prepareGeneration({ repos, chatId, generationType: "swipe" });
    expect(contents(swipe)).not.toContain("old option");

    // Normal replies and continuations still see the trailing assistant turn:
    // a continuation extends it in place.
    const normal = await prepareGeneration({ repos, chatId, generationType: "normal" });
    expect(contents(normal)).toContain("old option");
    const continued = await prepareGeneration({ repos, chatId, generationType: "continue" });
    expect(contents(continued)).toContain("old option");
  });

  it("keeps a trailing user turn under regenerate (persistence appends, not replaces)", async () => {
    const { chatId } = seed(); // seed leaves the tail on the user "turn 2"
    const result = await prepareGeneration({ repos, chatId, generationType: "regenerate" });
    expect(result.messages.map((message) => message.content)).toContain("turn 2");
  });

  it("renders {{lastMessage}} from the visible tail, not the replaced assistant turn", async () => {
    const preset = defaultPreset();
    const main = preset.prompts.find((prompt) => prompt.id === "main");
    if (main) {
      main.content = "LAST:{{lastMessage}}";
    }
    storePreset(preset);
    const { chatId } = seed();
    repos.messages.insertMessage(chatId, { role: "assistant", content: "old option" });

    const result = await prepareGeneration({ repos, chatId, generationType: "regenerate" });
    const text = result.messages.map((message) => message.content).join("\n");
    expect(text).toContain("LAST:turn 2");
    expect(text).not.toContain("LAST:old option");
  });
});
