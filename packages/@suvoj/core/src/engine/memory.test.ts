/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import { createTestDb } from "../test-utils";
import {
  getMemoryStrategy,
  listMemoryStrategies,
  registerMemoryStrategy,
  resetMemoryStrategies,
  summariesStrategy,
  trimStrategy,
} from "./memory";
import { summariesConfigSchema } from "./memory/summaries";

describe("memory strategies", () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(createTestDb());
  });
  afterEach(() => {
    // Restore the shared registry for other test files in this process.
    resetMemoryStrategies();
    registerMemoryStrategy(trimStrategy);
    registerMemoryStrategy(summariesStrategy);
  });

  const seedChat = (count: number, content = "filler"): string => {
    const character = repos.characters.create({ name: "Hero" });
    const chat = repos.chats.create({ character_id: character.id });
    for (let i = 0; i < count; i++) {
      repos.messages.insertMessage(chat.id, { role: "user", content });
    }
    return chat.id;
  };

  it("registers and looks up strategies", () => {
    expect(listMemoryStrategies().map((strategy) => strategy.id)).toContain("trim");
    expect(listMemoryStrategies().map((strategy) => strategy.id)).toContain("summaries");
    expect(getMemoryStrategy("trim")?.name).toBe(trimStrategy.name);
    expect(getMemoryStrategy("nope")).toBeUndefined();
    registerMemoryStrategy({
      id: "custom",
      name: "Custom",
      apply: async (history) => ({ history: [...history].slice(-1) }),
    });
    expect(getMemoryStrategy("custom")).toBeDefined();
    resetMemoryStrategies();
    expect(getMemoryStrategy("custom")).toBeUndefined();
  });

  describe("trim", () => {
    it("drops the oldest messages until under budget", async () => {
      const chatId = seedChat(6, "filler text here");
      const history = repos.messages.listActive(chatId);
      const result = await trimStrategy.apply(history, 12, {
        chatId,
        config: { keep_last: 1 },
        summaries: repos.summaries,
      });
      expect(result.history.length).toBe(1);
      expect(result.history[0]?.seq).toBe(6);
      expect(result.summary).toBeUndefined();
    });

    it("always keeps the configured floor", async () => {
      const chatId = seedChat(6, "filler text here");
      const history = repos.messages.listActive(chatId);
      const result = await trimStrategy.apply(history, 1, {
        chatId,
        config: { keep_last: 2 },
        summaries: repos.summaries,
      });
      expect(result.history.length).toBe(2);
      expect(result.history.map((message) => message.seq)).toEqual([5, 6]);
    });
  });

  describe("summaries (Layered Summaries)", () => {
    it("defaults the full config shape, prompts verbatim, and strips removed keys", () => {
      const parsed = summariesConfigSchema.parse({
        trigger_tokens: 500,
        trigger_messages: 10,
        keep_last: 4,
        prompt_template: "removed field",
      });
      // The authoritative default-shape guard: the two prompt defaults
      // are spec-exact and must not drift silently.
      expect(parsed).toEqual({
        chunk_size: 8,
        summarize_after: 30,
        max_snippets_per_layer: 15,
        snippets_per_promotion: 3,
        max_layer_depth: 3,
        strip_patterns: "",
        system_prompt:
          "You are a precise narrative-state tracker. Condense the core plot progression, changing dynamics, character motivations, and situational context into a single, high-density line. Output only this summary line, no preamble, no commentary, no markdown.",
        user_prompt: `<player_name>{{player_name}}</player_name>
<prior_context>{{context_str}}</prior_context>
<passage_in_question>{{story_txt}}</passage_in_question>

You are a Narrative Compression Specialist. Your task is to condense the <passage_in_question> into a dense, coherent summary that seamlessly continues from <prior_context>.

CRITICAL FILTERING RULES:
1. IGNORE all <details> and <summary>blocks. Do not summarize technical data or hidden mechanics.
2. IGNORE empty passages or repetitive sensory details already present in <prior_context>.

SUMMARIZATION PRIORITIES (Preserve in this order):
1. PLOT & ACTION: Key physical events, decisions made, and their immediate consequences.
2. RELATIONSHIP SHIFTS: Any change in relationships between NPCs including love, hate, friendship and other specifics.
3. CHARACTER STATE: Significant changes in NPC mood or revealed motivations.
4. ATMOSPHERIC ANCHORS: 2-3 most distinctive sensory details (smell, sound, lighting) that define the scene's tone. Avoid generic descriptions.
5. DIALOGUE ESSENCE: Paraphrase key exchanges. Preserve direct quotes ONLY if they reveal character voice or contain critical information.

OUTPUT GUIDELINES:
- Write as a single, fluid paragraph (not bullet points).
- Target length: 50-100 words for standard passages; up to 175 words for complex scenes.
- Use specific names, locations, and time references.
- Maintain the original narrative tone (e.g., gritty, romantic, tense).
- If the passage contains no significant new information, output exactly: [NO SIGNIFICANT CONTENT]

Output only the summary text. No preamble, no markdown, no commentary.`,
        injection_template: "[Summary of past events: {{summary}}]",
        mark_summarized: false,
      });
      expect(parsed).not.toHaveProperty("trigger_tokens");
      expect(parsed).not.toHaveProperty("trigger_messages");
      expect(parsed).not.toHaveProperty("keep_last");
      expect(parsed).not.toHaveProperty("prompt_template");
    });

    it("round-trips profile_id through parsing", () => {
      expect(summariesConfigSchema.parse({ profile_id: "p1" }).profile_id).toBe("p1");
      expect(summariesConfigSchema.parse({}).profile_id).toBeUndefined();
    });

    it("always elides covered ranges, even under budget", async () => {
      const chatId = seedChat(6, "one");
      // Stored level-0 rows as the server's post-response step would have
      // created them: 1–2 and 3–4 summarized.
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 1,
        seq_to: 2,
        summary: "first",
        tokens: 5,
      });
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 3,
        seq_to: 4,
        summary: "second",
        tokens: 5,
      });
      let calls = 0;
      const history = repos.messages.listActive(chatId);
      const result = await summariesStrategy.apply(history, 1000, {
        chatId,
        config: {},
        summaries: repos.summaries,
        summarizeFn: async () => `${++calls}`,
      });
      // Ghosted-by-summary turns never render verbatim again — even
      // though the assembly is comfortably within the budget.
      expect(result.history.map((message) => message.seq)).toEqual([5, 6]);
      expect(result.summary?.seqFrom).toBe(1);
      expect(result.summary?.seqTo).toBe(4);
      expect(result.summary?.text).toBe(
        "[Summary of past events: first]\n\n[Summary of past events: second]",
      );
      expect(calls).toBe(0);
    });

    it("keeps uncovered messages before the window live too", async () => {
      const chatId = seedChat(10, "one");
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 1,
        seq_to: 4,
        summary: "old",
        tokens: 5,
      });
      const history = repos.messages.listActive(chatId);
      const result = await summariesStrategy.apply(history, 1000, {
        chatId,
        config: { summarize_after: 2 },
        summaries: repos.summaries,
        summarizeFn: async () => "unused",
      });
      // Messages 5–8 are uncovered but outside the newest-2 window —
      // they stay verbatim; assembly never summarizes.
      expect(result.history.map((message) => message.seq)).toEqual([5, 6, 7, 8, 9, 10]);
      expect(result.summary?.text).toBe("[Summary of past events: old]");
    });

    it("sends mid-gap survivors verbatim once their covering row is gone", async () => {
      // The reviewer's repro, post-cascade state: [1-4], [5-8], [9-12]
      // summarized, then message 6 deleted — the cascade (not wired over
      // this test's repo set) would drop [5-8] with it, so the row is
      // removed here the same way.
      const chatId = seedChat(12, "one");
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 1,
        seq_to: 4,
        summary: "a",
        tokens: 5,
      });
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 5,
        seq_to: 8,
        summary: "b",
        tokens: 5,
      });
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 9,
        seq_to: 12,
        summary: "c",
        tokens: 5,
      });
      const gone = repos.messages.listActive(chatId).find((message) => message.seq === 6);
      if (!gone) {
        throw new Error("fixture message missing");
      }
      repos.messages.deleteMessage(gone.id);
      repos.summaries.deleteIntersecting(chatId, 6);

      let calls = 0;
      const history = repos.messages.listActive(chatId);
      const result = await summariesStrategy.apply(history, 1000, {
        chatId,
        config: {},
        summaries: repos.summaries,
        summarizeFn: async () => `${++calls}`,
      });
      // Positions 5, 7, 8 lost their covering row: they render verbatim
      // again — never silently dropped, never re-summarized at assembly
      // time — alongside nothing else (1–4 and 9–12 stay covered).
      expect(result.history.map((message) => message.seq)).toEqual([5, 7, 8]);
      expect(result.summary?.text).toBe(
        "[Summary of past events: a]\n\n[Summary of past events: c]",
      );
      // The block's span is the included rows' combined range.
      expect(result.summary).toMatchObject({ seqFrom: 1, seqTo: 12 });
      expect(calls).toBe(0);
    });

    it("renders the summary block when the oldest message is exactly covered", async () => {
      const chatId = seedChat(3, "one");
      // A stored row covering ONLY the first message — the history's
      // oldest position is covered, and coverage renders through the
      // summary block.
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 1,
        seq_to: 1,
        summary: "covered",
        tokens: 5,
      });
      const history = repos.messages.listActive(chatId);
      const result = await summariesStrategy.apply(history, 1000, {
        chatId,
        config: {},
        summaries: repos.summaries,
        summarizeFn: async () => "unused",
      });
      // Message 1 is ghosted by the summary row — the summary block must
      // keep it instead of silently dropping it from the prompt.
      expect(result.history.map((message) => message.seq)).toEqual([2, 3]);
      expect(result.summary?.seqFrom).toBe(1);
      expect(result.summary?.seqTo).toBe(1);
      expect(result.summary?.text).toBe("[Summary of past events: covered]");
    });

    it("never creates level-0 summaries during assembly", async () => {
      const chatId = seedChat(6, "one");
      let calls = 0;
      const history = repos.messages.listActive(chatId);
      const result = await summariesStrategy.apply(history, 9, {
        chatId,
        config: { chunk_size: 2, summarize_after: 1 },
        summaries: repos.summaries,
        summarizeFn: async () => `${++calls}`,
      });
      // Over budget with no stored summaries: nothing to roll up, so the
      // oldest live messages are hard-trimmed instead — no summarizer
      // call, no summary rows, no summary block.
      expect(calls).toBe(0);
      expect(repos.summaries.list(chatId)).toEqual([]);
      expect(result.summary).toBeUndefined();
      expect(result.history.map((message) => message.seq)).toEqual([6]);
    });

    it("rolls level-0 summaries up and then hard-trims when over budget", async () => {
      const chatId = seedChat(8, "one");
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 1,
        seq_to: 2,
        summary: "a",
        tokens: 5,
      });
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 3,
        seq_to: 4,
        summary: "b",
        tokens: 5,
      });
      let calls = 0;
      const history = repos.messages.listActive(chatId);
      const result = await summariesStrategy.apply(history, 12, {
        chatId,
        config: { snippets_per_promotion: 2, summarize_after: 2 },
        summaries: repos.summaries,
        summarizeFn: async () => `${++calls}`,
      });
      // The two level-0 rows rolled up into one level-1 row…
      expect(calls).toBe(1);
      expect(repos.summaries.list(chatId).filter((row) => row.level === 1).length).toBe(1);
      // …then, still over budget, the live tail hard-trimmed down to the
      // summarize_after floor (never below it).
      expect(result.history.map((message) => message.seq)).toEqual([7, 8]);
      expect(result.summary?.text).toBe("[Summary of past events: 1]");
    });

    it("reuses stored summaries without regenerating them", async () => {
      const chatId = seedChat(6, "one");
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 1,
        seq_to: 4,
        summary: "kept",
        tokens: 5,
      });
      let calls = 0;
      const ctx = {
        chatId,
        config: {},
        summaries: repos.summaries,
        summarizeFn: async (): Promise<string> => `${++calls}`,
      };
      const first = await summariesStrategy.apply(repos.messages.listActive(chatId), 1000, ctx);
      const second = await summariesStrategy.apply(repos.messages.listActive(chatId), 1000, ctx);
      expect(calls).toBe(0);
      expect(first.history.map((message) => message.seq)).toEqual([5, 6]);
      expect(second.summary?.text).toBe(first.summary?.text);
    });

    it("degrades to keeping the newest summarize_after without a summarizeFn", async () => {
      const chatId = seedChat(6, "filler text here");
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 1,
        seq_to: 4,
        summary: "old",
        tokens: 5,
      });
      const history = repos.messages.listActive(chatId);
      const result = await summariesStrategy.apply(history, 12, {
        chatId,
        config: { summarize_after: 2 },
        summaries: repos.summaries,
      });
      expect(result.history.map((message) => message.seq)).toEqual([5, 6]);
      expect(result.summary).toBeUndefined();
    });

    it("returns the full history when nothing is covered yet", async () => {
      const chatId = seedChat(3, "tiny");
      const history = repos.messages.listActive(chatId);
      const result = await summariesStrategy.apply(history, 1000, {
        chatId,
        config: {},
        summaries: repos.summaries,
        summarizeFn: async () => "unused",
      });
      expect(result.history.length).toBe(3);
      expect(result.summary).toBeUndefined();
    });

    it("wraps every snippet with the injection template, every occurrence", async () => {
      const chatId = seedChat(6, "one");
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 1,
        seq_to: 2,
        summary: "first$1",
        tokens: 5,
      });
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 3,
        seq_to: 4,
        summary: "second",
        tokens: 5,
      });
      const history = repos.messages.listActive(chatId);
      const result = await summariesStrategy.apply(history, 1000, {
        chatId,
        // Multiple {{summary}} occurrences per template, and a snippet
        // containing `$` (a regex replace would mangle it).
        config: { injection_template: "<s>{{summary}}</s>|{{summary}}" },
        summaries: repos.summaries,
        summarizeFn: async () => "unused",
      });
      expect(result.summary?.text).toBe("<s>first$1</s>|first$1\n\n<s>second</s>|second");
    });

    it("falls back to template + text when the injection template lacks the placeholder", async () => {
      const chatId = seedChat(4, "one");
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 1,
        seq_to: 2,
        summary: "first",
        tokens: 5,
      });
      const history = repos.messages.listActive(chatId);
      const result = await summariesStrategy.apply(history, 1000, {
        chatId,
        config: { injection_template: "CONTEXT:" },
        summaries: repos.summaries,
        summarizeFn: async () => "unused",
      });
      expect(result.summary?.text).toBe("CONTEXT:\nfirst");
    });

    it("stores but never injects no-content marker rows", async () => {
      const chatId = seedChat(6, "one");
      // The marker covers messages 1–2 (they never render verbatim
      // again) but injects nothing; only the real row renders.
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 1,
        seq_to: 2,
        summary: "[NO SIGNIFICANT CONTENT]",
        tokens: 5,
      });
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 3,
        seq_to: 4,
        summary: "real",
        tokens: 5,
      });
      const history = repos.messages.listActive(chatId);
      const result = await summariesStrategy.apply(history, 1000, {
        chatId,
        config: {},
        summaries: repos.summaries,
        summarizeFn: async () => "unused",
      });
      expect(result.history.map((message) => message.seq)).toEqual([5, 6]);
      expect(result.summary?.text).toBe("[Summary of past events: real]");
    });

    it("produces empty summary text when every covered row is a marker", async () => {
      const chatId = seedChat(3, "one");
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 1,
        seq_to: 2,
        summary: "[NO SIGNIFICANT CONTENT]",
        tokens: 5,
      });
      const history = repos.messages.listActive(chatId);
      const result = await summariesStrategy.apply(history, 1000, {
        chatId,
        config: {},
        summaries: repos.summaries,
        summarizeFn: async () => "unused",
      });
      // The covered range ghosts its messages, and with no visible row
      // the block itself renders as empty text.
      expect(result.history.map((message) => message.seq)).toEqual([3]);
      expect(result.summary).toMatchObject({ seqFrom: 1, seqTo: 2, text: "" });
    });

    it("never rolls up beyond max_layer_depth", async () => {
      const chatId = seedChat(8, "one");
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 1,
        seq_to: 2,
        summary: "a",
        tokens: 5,
      });
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 3,
        seq_to: 4,
        summary: "b",
        tokens: 5,
      });
      let calls = 0;
      const history = repos.messages.listActive(chatId);
      const result = await summariesStrategy.apply(history, 12, {
        chatId,
        // Depth 1: level 0 is the only allowed layer, so no roll-up can
        // happen — the assembly hard-trims instead.
        config: { max_layer_depth: 1, snippets_per_promotion: 2, summarize_after: 2 },
        summaries: repos.summaries,
        summarizeFn: async () => `${++calls}`,
      });
      expect(calls).toBe(0);
      expect(repos.summaries.list(chatId).every((row) => row.level === 0)).toBe(true);
      expect(result.history.map((message) => message.seq)).toEqual([7, 8]);
      expect(result.summary?.text).toBe(
        "[Summary of past events: a]\n\n[Summary of past events: b]",
      );
    });

    it("excludes marker rows from roll-up batches", async () => {
      const chatId = seedChat(8, "one");
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 1,
        seq_to: 2,
        summary: "[NO SIGNIFICANT CONTENT]",
        tokens: 5,
      });
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 3,
        seq_to: 4,
        summary: "b",
        tokens: 5,
      });
      repos.summaries.create(chatId, {
        level: 0,
        seq_from: 5,
        seq_to: 6,
        summary: "c",
        tokens: 5,
      });
      const seen: string[] = [];
      const history = repos.messages.listActive(chatId);
      await summariesStrategy.apply(history, 12, {
        chatId,
        config: { snippets_per_promotion: 2, summarize_after: 2 },
        summaries: repos.summaries,
        summarizeFn: async (rangeText) => {
          seen.push(rangeText);
          return "rolled";
        },
      });
      // The marker row is covered-but-empty: it stays out of the batch.
      expect(seen).toEqual(["b\n\nc"]);
    });
  });
});
