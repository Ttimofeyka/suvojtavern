/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  BUILTIN_PIPELINE_STAGE_IDS,
  listPipelineStages,
  type PromptContext,
  resetPipelineStages,
} from "../engine/pipeline";
import { defaultPreset } from "../engine/preset";
import { buildPrompt } from "../engine/prompt";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import { createTestDb } from "../test-utils";
import { DEFAULT_TRACKER_SYSTEM_PROMPT } from "./defaults";
import {
  getTrackerConfig,
  isTrackerEnabledForChat,
  PLAIN_INJECTION_GUARD,
  TRACKER_CONFIG_KEY,
  trackerStage,
} from "./injection";

describe("getTrackerConfig", () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(createTestDb());
  });

  it("returns the full default config when the key is missing", () => {
    expect(getTrackerConfig(repos)).toEqual({
      enabled: false,
      mechanism: "suvoj-tracker",
      auto_mode: "after_reply",
      profile_id: "",
      system_prompt: DEFAULT_TRACKER_SYSTEM_PROMPT,
      include_last_messages: 6,
      include_last_trackers: 2,
      keep_last: 2,
      max_response_tokens: 8192,
      invisible: false,
      injection: { include_last: 1, role: "system", format: "plain", header: "Tracker:" },
      schema_presets: {},
      active_schema_key: "default",
    });
  });

  it("merges a partial stored object through zod defaults", () => {
    repos.settings.set(TRACKER_CONFIG_KEY, {
      enabled: false,
      mechanism: "custom",
      injection: { role: "system" },
      schema_presets: { mine: { name: "Mine", schema: { type: "object" } } },
    });
    const config = getTrackerConfig(repos);
    expect(config.enabled).toBe(false);
    expect(config.mechanism).toBe("custom");
    expect(config.auto_mode).toBe("after_reply");
    expect(config.keep_last).toBe(2);
    expect(config.injection).toEqual({
      include_last: 1,
      role: "system",
      format: "plain",
      header: "Tracker:",
    });
    expect(config.schema_presets.mine).toEqual({
      name: "Mine",
      schema: { type: "object" },
      html: "",
      css: "",
      parts: { count: 1, fields: {} },
    });
  });

  it("falls back per-field on invalid values, and wholesale on non-objects", () => {
    repos.settings.set(TRACKER_CONFIG_KEY, { keep_last: -3, mechanism: 7, enabled: "yes" });
    let config = getTrackerConfig(repos);
    expect(config.keep_last).toBe(2);
    expect(config.mechanism).toBe("suvoj-tracker");
    expect(config.enabled).toBe(false);

    repos.settings.set(TRACKER_CONFIG_KEY, "nonsense");
    config = getTrackerConfig(repos);
    expect(config).toEqual(getTrackerConfig(createRepositories(createTestDb())));
  });

  it("falls back to the plain format for an unknown injection format", () => {
    repos.settings.set(TRACKER_CONFIG_KEY, { injection: { format: "bogus" } });
    expect(getTrackerConfig(repos).injection.format).toBe("plain");
  });
});

describe("isTrackerEnabledForChat", () => {
  let repos: Repositories;
  let chatId: string;

  beforeEach(() => {
    repos = createRepositories(createTestDb());
    const character = repos.characters.create({ name: "Seraphina" });
    chatId = repos.chats.create({ character_id: character.id }).id;
  });

  it("requires the global master switch", () => {
    repos.settings.set(TRACKER_CONFIG_KEY, { enabled: false });
    expect(isTrackerEnabledForChat(repos, chatId)).toBe(false);
    repos.chats.update(chatId, { tracker_enabled: true });
    expect(isTrackerEnabledForChat(repos, chatId)).toBe(false);
  });

  it("requires this chat's own switch once the master is on", () => {
    repos.settings.set(TRACKER_CONFIG_KEY, { enabled: true });
    expect(isTrackerEnabledForChat(repos, chatId)).toBe(true);
    repos.chats.update(chatId, { tracker_enabled: false });
    expect(isTrackerEnabledForChat(repos, chatId)).toBe(false);
  });

  it("treats an unknown chat as on when the master is on", () => {
    repos.settings.set(TRACKER_CONFIG_KEY, { enabled: true });
    expect(isTrackerEnabledForChat(repos, "missing")).toBe(true);
  });
});

describe("trackerStage", () => {
  let repos: Repositories;
  let chatId: string;
  let userMessageId: string;
  let assistantMessageId: string;
  let ctx: PromptContext;

  beforeEach(() => {
    repos = createRepositories(createTestDb());
    resetPipelineStages();
    // The tests below exercise injection, not the enabled default —
    // enable the tracker explicitly (the default is off).
    repos.settings.set(TRACKER_CONFIG_KEY, { enabled: true });
    const character = repos.characters.create({ name: "Seraphina" });
    const persona = repos.personas.create({ name: "Alex", description: "A traveler." });
    const chat = repos.chats.create({ character_id: character.id, persona_id: persona.id });
    chatId = chat.id;
    userMessageId = repos.messages.insertMessage(chat.id, {
      role: "user",
      content: "message 0",
    }).id;
    assistantMessageId = repos.messages.insertMessage(chat.id, {
      role: "assistant",
      content: "message 1",
    }).id;
    ctx = {
      chat,
      character,
      persona,
      preset: defaultPreset(),
      history: repos.messages.listActive(chat.id),
      lorebook: null,
      macros: {
        char: character.name,
        user: persona.name ?? "User",
        persona: persona.description,
        chatId: chat.id,
        vars: repos.variables,
        lastMessage: "message 1",
      },
      rng: () => 0.5,
      repos,
    };
  });

  it("is registered as the last built-in stage, after history", () => {
    expect(BUILTIN_PIPELINE_STAGE_IDS[BUILTIN_PIPELINE_STAGE_IDS.length - 1]).toBe("tracker");
    expect(listPipelineStages().map((stage) => stage.id)).toEqual([
      "lorebook",
      "memory",
      "persona",
      "history",
      "tracker",
    ]);
  });

  it("is a no-op when disabled", async () => {
    repos.settings.set(TRACKER_CONFIG_KEY, { enabled: false });
    const before = [...ctx.history];
    await trackerStage.run(ctx);
    expect(ctx.history).toEqual(before);
    expect(ctx.tail).toBeUndefined();
  });

  it("is a no-op when this chat's own switch is off, even with the global switch on", async () => {
    repos.trackers.create(chatId, { message_id: assistantMessageId, data: { time: "10:00:00" } });
    repos.chats.update(chatId, { tracker_enabled: false });
    const before = [...ctx.history];
    await trackerStage.run(ctx);
    expect(ctx.history).toEqual(before);
    expect(ctx.tail).toBeUndefined();

    // Flipping the chat back on restores injection without touching the config.
    repos.chats.update(chatId, { tracker_enabled: true });
    await trackerStage.run(ctx);
    expect(ctx.tail).toHaveLength(1);
  });

  it("is a no-op when injection is off or there are no snapshots", async () => {
    repos.settings.set(TRACKER_CONFIG_KEY, { enabled: true, injection: { include_last: 0 } });
    await trackerStage.run(ctx);
    expect(ctx.history).toHaveLength(2);
    expect(ctx.tail).toBeUndefined();

    repos.settings.set(TRACKER_CONFIG_KEY, { enabled: true, injection: { include_last: 5 } });
    await trackerStage.run(ctx);
    expect(ctx.history).toHaveLength(2);
    expect(ctx.tail).toBeUndefined();
  });

  it("renders the latest snapshot into the state tail, leaving history untouched (json format)", async () => {
    // Placement test, pinned to the json format so the fenced assertion holds.
    repos.settings.set(TRACKER_CONFIG_KEY, {
      enabled: true,
      injection: { format: "json" },
    });
    const snapshot = repos.trackers.create(chatId, {
      message_id: assistantMessageId,
      data: { time: "10:00:00", location: "library" },
    });
    await trackerStage.run(ctx);
    // State is NOT conversation: the live window is untouched and the snapshot
    // lands in its own sink.
    expect(ctx.history).toHaveLength(2);
    expect(ctx.tail).toHaveLength(1);
    const injected = ctx.tail?.[0];
    if (!injected) {
      throw new Error("expected an injected message");
    }
    expect(injected.id).toBe(`tracker:${snapshot.id}`);
    expect(injected.role).toBe("system");
    expect(injected.chat_id).toBe(chatId);
    expect(injected.active).toBe(true);
    expect(injected.content).toBe(
      `Tracker:\n\`\`\`json\n${JSON.stringify({ time: "10:00:00", location: "library" }, null, 2)}\n\`\`\``,
    );
    expect(ctx.history).toEqual(repos.messages.listActive(chatId));
  });

  it("renders the json format byte-identically to the generator's fenced block", async () => {
    repos.settings.set(TRACKER_CONFIG_KEY, {
      enabled: true,
      injection: { format: "json" },
    });
    const data = { time: "10:00:00", characters: [{ name: "Mira", mood: "calm" }] };
    repos.trackers.create(chatId, { message_id: assistantMessageId, data });
    await trackerStage.run(ctx);
    expect(ctx.tail?.[0]?.content).toBe(
      `Tracker:\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``,
    );
  });

  it("renders the plain format by default (guard line, no json fence)", async () => {
    // No injection.format is stored: the default is plain.
    repos.trackers.create(chatId, { message_id: assistantMessageId, data: { time: "10:00:00" } });
    await trackerStage.run(ctx);
    const content = ctx.tail?.[0]?.content ?? "";
    expect(content).not.toContain("```");
    expect(content).toContain(PLAIN_INJECTION_GUARD);
    expect(content).toBe(`Tracker:\n${PLAIN_INJECTION_GUARD}\ntime: 10:00:00`);
  });

  it("renders plain text with the guard line and no json fence", async () => {
    repos.settings.set(TRACKER_CONFIG_KEY, {
      enabled: true,
      injection: { include_last: 1, format: "plain" },
    });
    const data = {
      time: "10:00:00",
      ok: true,
      note: null,
      present: ["Mira", "the stranger"],
      empty: [],
      characters: [
        { name: "Mira", mood: "calm" },
        // No name/id/uid/key → positional `item2` fallback label.
        { mood: "wary" },
      ],
      location: { district: "Riverside", building: { name: "Gilded Boar" } },
    };
    repos.trackers.create(chatId, { message_id: assistantMessageId, data });
    await trackerStage.run(ctx);
    const content = ctx.tail?.[0]?.content ?? "";
    expect(content).not.toContain("```");
    expect(content).toContain(PLAIN_INJECTION_GUARD);
    expect(content).toBe(
      `Tracker:\n${PLAIN_INJECTION_GUARD}\n` +
        [
          "time: 10:00:00",
          "ok: true",
          "note: null",
          "present: Mira, the stranger",
          "empty: (empty)",
          "characters:",
          "  - Mira",
          "    mood: calm",
          "  - item2",
          "    mood: wary",
          "location:",
          "  district: Riverside",
          "  building:",
          "    name: Gilded Boar",
        ].join("\n"),
    );
  });

  it("labels a secrets array by `fact` and skips the repeated label key", async () => {
    repos.settings.set(TRACKER_CONFIG_KEY, { enabled: true });
    repos.trackers.create(chatId, {
      message_id: assistantMessageId,
      data: {
        secrets: [{ fact: "Mira hid the crate", knows: ["Mira"], suspects: ["Kael"] }],
      },
    });
    await trackerStage.run(ctx);
    expect(ctx.tail?.[0]?.content).toBe(
      `Tracker:\n${PLAIN_INJECTION_GUARD}\n` +
        ["secrets:", "  - Mira hid the crate", "    knows: Mira", "    suspects: Kael"].join("\n"),
    );
  });

  it("renders plain text without a header line when the header is empty", async () => {
    repos.settings.set(TRACKER_CONFIG_KEY, {
      enabled: true,
      injection: { include_last: 1, format: "plain", header: "" },
    });
    repos.trackers.create(chatId, { message_id: assistantMessageId, data: { time: "10:00:00" } });
    await trackerStage.run(ctx);
    expect(ctx.tail?.[0]?.content).toBe(`${PLAIN_INJECTION_GUARD}\ntime: 10:00:00`);
  });

  it("injects the newest snapshot per position, oldest → newest, up to include_last", async () => {
    repos.settings.set(TRACKER_CONFIG_KEY, {
      enabled: true,
      injection: { include_last: 2, role: "system" },
    });
    const thirdId = repos.messages.insertMessage(chatId, {
      role: "assistant",
      content: "message 2",
    }).id;
    repos.trackers.create(chatId, { message_id: userMessageId, data: { time: "10:00:00" } });
    repos.trackers.create(chatId, { message_id: assistantMessageId, data: { time: "10:00:05" } });
    // The assistant position regenerated: only its NEWEST snapshot counts.
    repos.trackers.create(chatId, { message_id: assistantMessageId, data: { time: "10:00:10" } });
    repos.trackers.create(chatId, { message_id: thirdId, data: { time: "10:00:15" } });
    // Unattached rows are never injected.
    repos.trackers.create(chatId, { data: { time: "unattached" } });

    await trackerStage.run(ctx);
    // `ctx.history` is the snapshot from beforeEach (two rows); the stage
    // appends nothing to it, and the inserted third row is irrelevant here.
    expect(ctx.history).toHaveLength(2);
    expect(ctx.tail).toHaveLength(2);
    // The newest two POSITIONS, one snapshot each, oldest → newest.
    expect(ctx.tail?.[0]?.content).toContain("10:00:10");
    expect(ctx.tail?.[1]?.content).toContain("10:00:15");
    expect(ctx.tail?.[0]?.content).not.toContain("10:00:05");
    expect(ctx.tail?.[1]?.content).not.toContain("unattached");
    expect(ctx.tail?.[0]?.role).toBe("system");
    expect(ctx.tail?.[1]?.role).toBe("system");
  });

  it("injects only the selected swipe's snapshot, never an inactive sibling's", async () => {
    const swipe = repos.messages.addVariant(chatId, assistantMessageId, "message 1 alt");
    repos.trackers.create(chatId, {
      message_id: assistantMessageId,
      data: { time: "root-snapshot" },
    });
    repos.trackers.create(chatId, { message_id: swipe.id, data: { time: "swipe-snapshot" } });

    // The root is the active swipe, so its snapshot is injected.
    await trackerStage.run(ctx);
    expect(ctx.tail).toHaveLength(1);
    expect(ctx.tail?.[0]?.content).toContain("root-snapshot");

    // Selecting the swipe flips which snapshot the prompt receives. A rebuild
    // starts from a FRESH context (the stage appends to `tail`), so this
    // drops the previous run's tail rather than spreading it in.
    repos.messages.setActiveVariant(swipe.id);
    const { tail: _previousTail, ...fresh } = ctx;
    const rebuilt: PromptContext = {
      ...fresh,
      history: repos.messages.listActive(chatId),
    };
    await trackerStage.run(rebuilt);
    expect(rebuilt.tail).toHaveLength(1);
    expect(rebuilt.tail?.[0]?.content).toContain("swipe-snapshot");
    expect(rebuilt.tail?.[0]?.content).not.toContain("root-snapshot");
  });

  it("does not inject snapshots that are not attached to a message", async () => {
    repos.trackers.create(chatId, { data: { time: "10:00:00" } });
    const before = [...ctx.history];
    await trackerStage.run(ctx);
    expect(ctx.history).toEqual(before);
    expect(ctx.tail).toBeUndefined();
  });

  it("omits snapshots at the replaced seq — the whole sibling group is excluded", async () => {
    // A tracker on the position BEFORE the replaced one still injects…
    const earlier = repos.trackers.create(chatId, {
      message_id: userMessageId,
      data: { time: "10:00:00" },
    });
    // …while the replaced swipe's own tracker is invisible to its replacement.
    repos.trackers.create(chatId, {
      message_id: assistantMessageId,
      data: { time: "10:00:05" },
    });
    const replacedSeq = repos.messages.get(assistantMessageId)?.seq;
    expect(replacedSeq).toBeNumber();
    ctx.replacedSeq = replacedSeq;

    await trackerStage.run(ctx);
    expect(ctx.tail).toHaveLength(1);
    expect(ctx.tail?.[0]?.id).toBe(`tracker:${earlier.id}`);
    expect(ctx.tail?.[0]?.content).toContain("10:00:00");
    expect(ctx.tail?.[0]?.content).not.toContain("10:00:05");
  });

  it("injects the trailing position's snapshot when replacedSeq is unset (existing behaviour)", async () => {
    repos.trackers.create(chatId, { message_id: assistantMessageId, data: { time: "10:00:00" } });
    await trackerStage.run(ctx);
    expect(ctx.tail).toHaveLength(1);
    expect(ctx.tail?.[0]?.content).toContain("10:00:00");
  });

  it("omits the header line from the json fence when the header is empty", async () => {
    repos.settings.set(TRACKER_CONFIG_KEY, {
      enabled: true,
      injection: { include_last: 1, format: "json", header: "" },
    });
    repos.trackers.create(chatId, { message_id: assistantMessageId, data: { time: "10:00:00" } });
    await trackerStage.run(ctx);
    expect(ctx.tail?.[0]?.content.startsWith("```json\n")).toBe(true);
  });

  it("renders through the full pipeline after the last chat message", async () => {
    const preset = defaultPreset();
    const jailbreak = preset.prompts.find((prompt) => prompt.id === "jailbreak");
    if (jailbreak) {
      jailbreak.content = "Stay in character, {{user}}.";
    }
    repos.trackers.create(chatId, { message_id: assistantMessageId, data: { time: "10:00:00" } });
    const result = await buildPrompt({ ...ctx, preset });
    const contents = result.messages.map((message) => message.content);
    // Format-agnostic: the snapshot's value is unique to the tracker message
    // (plain renders `time: 10:00:00`, json `"time": "10:00:00"`).
    const trackerIndex = contents.findIndex((content) => content.includes("10:00:00"));
    const historyIndex = contents.indexOf("message 1");
    const jailbreakIndex = contents.findIndex((content) => content.includes("Stay in character"));
    expect(trackerIndex).toBeGreaterThan(historyIndex);
    expect(jailbreakIndex).toBeGreaterThan(trackerIndex);
  });
});
