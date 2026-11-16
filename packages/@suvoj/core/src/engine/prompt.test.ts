/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import type { RegexRule } from "../schema/regex";
import { createTestDb } from "../test-utils";
import { runLorebook } from "./lorebook";
import type { PromptContext } from "./pipeline";
import { registerPipelineStage, resetPipelineStages } from "./pipeline";
import { defaultPreset } from "./preset";
import { buildPrompt } from "./prompt";
import { REGEX_RULES_KEY } from "./regex";
import { countMessagesTokens } from "./tokens";

describe("prompt assembler", () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(createTestDb());
    resetPipelineStages();
  });

  /** Standard build context over a small scripted chat. */
  function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
    const character = repos.characters.create({
      name: "Seraphina",
      description: "{{char}} is a catgirl. Speaks to {{user}}.",
      personality: "playful",
      scenario: "the library",
      system_prompt: "You are {{char}}.",
      post_history_instructions: "Stay in character, {{user}}.",
      mes_example: "<START>\n{{char}}: Hello!\n{{user}}: Hi.\n<START>\n{{char}}: Books!",
    });
    const persona = repos.personas.create({ name: "Alex", description: "A traveler." });
    const chat = repos.chats.create({ character_id: character.id, persona_id: persona.id });
    for (let i = 0; i < 4; i++) {
      repos.messages.insertMessage(chat.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
      });
    }
    // The preset carries the main / jailbreak text; the character keeps its
    // own non-empty system_prompt / post_history_instructions (SillyTavern
    // round-trip fields) to prove they never override the preset.
    const preset = defaultPreset();
    const mainPrompt = preset.prompts.find((prompt) => prompt.id === "main");
    const jailbreakPrompt = preset.prompts.find((prompt) => prompt.id === "jailbreak");
    if (mainPrompt && jailbreakPrompt) {
      mainPrompt.content = "You are {{char}}.";
      jailbreakPrompt.content = "Stay in character, {{user}}.";
    }
    return {
      chat,
      character,
      persona,
      preset,
      history: repos.messages.listActive(chat.id),
      lorebook: null,
      macros: {
        char: character.name,
        user: persona.name ?? "User",
        persona: persona.description,
        chatId: chat.id,
        vars: repos.variables,
        lastMessage: "message 3",
      },
      rng: () => 0.5,
      repos,
      ...overrides,
    };
  }

  it("walks the default marker order", async () => {
    const result = await buildPrompt(makeContext());
    const contents = result.messages.map((message) => message.content);
    const index = (needle: string): number => contents.findIndex((c) => c.includes(needle));
    expect(index("You are Seraphina.")).toBeLessThan(index("A traveler."));
    expect(index("A traveler.")).toBeLessThan(index("Seraphina is a catgirl"));
    expect(index("Seraphina is a catgirl")).toBeLessThan(index("personality: playful"));
    expect(index("personality: playful")).toBeLessThan(index("the library"));
    expect(index("the library")).toBeLessThan(index("message 0"));
    expect(index("message 0")).toBeLessThan(index("Stay in character, Alex."));
  });

  it("renders the prompts array in array order (the array IS the layout)", async () => {
    const preset = defaultPreset();
    preset.prompts.reverse();
    const main = preset.prompts.find((prompt) => prompt.id === "main");
    const jailbreak = preset.prompts.find((prompt) => prompt.id === "jailbreak");
    if (main && jailbreak) {
      main.content = "You are {{char}}.";
      jailbreak.content = "Stay in character, {{user}}.";
    }
    const result = await buildPrompt(makeContext({ preset }));
    const contents = result.messages.map((message) => message.content);
    const index = (needle: string): number => contents.findIndex((c) => c.includes(needle));
    // Reversed: the history block now precedes the persona/description
    // blocks, and the jailbreak lands before main.
    expect(index("message 0")).toBeLessThan(index("A traveler."));
    expect(index("message 0")).toBeLessThan(index("Seraphina is a catgirl"));
    expect(index("Stay in character, Alex.")).toBeLessThan(index("You are Seraphina."));
  });

  it("evaluates macros in every rendered block and history message", async () => {
    const ctx = makeContext();
    const template = ctx.history[0];
    if (!template) {
      throw new Error("expected a history message");
    }
    ctx.history = [{ ...template, content: "inner {{user}} macro" }];
    const result = await buildPrompt(ctx);
    const contents = result.messages.map((message) => message.content);
    expect(contents).toContain("Seraphina is a catgirl. Speaks to Alex.");
    expect(contents).toContain("You are Seraphina.");
    expect(contents).toContain("Stay in character, Alex.");
    expect(contents).toContain("inner Alex macro");
  });

  it("renders preset main/jailbreak content; character fields never override", async () => {
    const preset = defaultPreset();
    const mainPrompt = preset.prompts.find((prompt) => prompt.id === "main");
    const jailbreakPrompt = preset.prompts.find((prompt) => prompt.id === "jailbreak");
    if (mainPrompt && jailbreakPrompt) {
      mainPrompt.content = "PRESET MAIN";
      jailbreakPrompt.content = "PRESET JAILBREAK";
    }
    // The character has non-empty system_prompt / post_history_instructions
    // (see makeContext) — the preset content must always win.
    const result = await buildPrompt(makeContext({ preset }));
    const contents = result.messages.map((message) => message.content);
    expect(contents).toContain("PRESET MAIN");
    expect(contents).toContain("PRESET JAILBREAK");
    expect(contents).not.toContain("You are Seraphina.");
    expect(contents).not.toContain("Stay in character, Alex.");
  });

  it("renders example dialogues with separators and speaker names", async () => {
    const result = await buildPrompt(makeContext());
    const contents = result.messages.map((message) => message.content);
    const examples = contents.filter((content) => content === "[Example Chat]");
    expect(examples.length).toBe(2);
    const hello = result.messages.find((message) => message.content.startsWith("Hello!"));
    expect(hello?.name).toBe("Seraphina");
    expect(hello?.role).toBe("system");
    const hi = result.messages.find((message) => message.content.startsWith("Hi."));
    expect(hi?.name).toBe("Alex");
  });

  it("prepends the new-chat marker at history start", async () => {
    const result = await buildPrompt(makeContext());
    const index = result.messages.findIndex((message) => message.content === "[Start a new chat]");
    expect(index).toBeGreaterThan(0);
    expect(result.messages[index + 1]?.content).toBe("message 0");
  });

  it("inserts depth injections N messages from the end", async () => {
    const preset = defaultPreset();
    const jailbreakPrompt = preset.prompts.find((prompt) => prompt.id === "jailbreak");
    if (jailbreakPrompt) {
      jailbreakPrompt.content = "Stay in character, {{user}}.";
    }
    preset.prompts.push({
      id: "injector",
      name: "Injector",
      role: "system",
      content: "DEPTH BLOCK",
      enabled: true,
      injection_position: 1,
      injection_depth: 2,
      injection_order: 100,
      injection_trigger: [],
    });
    const result = await buildPrompt(makeContext({ preset }));
    const index = result.messages.findIndex((message) => message.content === "DEPTH BLOCK");
    // Two messages follow the injection: message 2 and message 3.
    expect(result.messages[index + 1]?.content).toBe("message 2");
    expect(result.messages[index + 2]?.content).toBe("message 3");
    // After history comes the jailbreak block, not more history.
    expect(result.messages[index + 3]?.content).toBe("Stay in character, Alex.");
  });

  it("orders same-depth injections by injection_order (higher = closer to the end)", async () => {
    const preset = defaultPreset();
    preset.prompts.push(
      {
        id: "inj-low",
        name: "Low",
        role: "system",
        content: "LOW ORDER",
        enabled: true,
        injection_position: 1,
        injection_depth: 1,
        injection_order: 100,
        injection_trigger: [],
      },
      {
        id: "inj-high",
        name: "High",
        role: "system",
        content: "HIGH ORDER",
        enabled: true,
        injection_position: 1,
        injection_depth: 1,
        injection_order: 200,
        injection_trigger: [],
      },
    );
    const result = await buildPrompt(makeContext({ preset }));
    const low = result.messages.findIndex((message) => message.content === "LOW ORDER");
    const high = result.messages.findIndex((message) => message.content === "HIGH ORDER");
    expect(low).toBeGreaterThan(-1);
    expect(high).toBe(low + 1);
    expect(result.messages[high + 1]?.content).toBe("message 3");
  });

  it("ignores prompt groups when assembling (group never affects output)", async () => {
    // A grouped, ENABLED prompt still renders; a grouped, DISABLED prompt is
    // skipped — exactly as `enabled` alone dictates. `group` is pure editor
    // metadata and must never reach the assembler's inclusion decision.
    const grouped = defaultPreset();
    grouped.prompts.push(
      {
        id: "on-grouped",
        name: "On grouped",
        role: "system",
        content: "GROUPED ON",
        enabled: true,
        injection_position: 0,
        injection_depth: 4,
        injection_order: 100,
        injection_trigger: [],
        group: { id: "style", label: "Style" },
      },
      {
        id: "off-grouped",
        name: "Off grouped",
        role: "system",
        content: "GROUPED OFF",
        enabled: false,
        injection_position: 0,
        injection_depth: 4,
        injection_order: 100,
        injection_trigger: [],
        group: { id: "style", label: "Style" },
      },
    );
    const result = await buildPrompt(makeContext({ preset: grouped }));
    const contents = result.messages.map((message) => message.content);
    expect(contents).toContain("GROUPED ON");
    expect(contents).not.toContain("GROUPED OFF");

    // Stripping the group metadata yields byte-identical output.
    const stripped = structuredClone(grouped);
    for (const prompt of stripped.prompts) {
      delete (prompt as { group?: unknown }).group;
    }
    const withoutGroups = await buildPrompt(makeContext({ preset: stripped }));
    expect(withoutGroups.messages).toEqual(result.messages);
    expect(withoutGroups.tokenCount).toBe(result.tokenCount);
  });

  it("renders lorebook blocks position-aware (before/after character)", async () => {
    const ctx = makeContext();
    const book = repos.lorebooks.create({ name: "Book" });
    repos.lorebooks.addEntry(book.id, {
      keys: [],
      content: "CONSTANT BEFORE",
      constant: true,
      position: 0,
    });
    repos.lorebooks.addEntry(book.id, {
      keys: [],
      content: "CONSTANT AFTER",
      constant: true,
      position: 1,
    });
    repos.lorebooks.addEntry(book.id, {
      keys: [],
      content: "AT DEPTH WI",
      constant: true,
      position: 4,
      depth: 1,
    });
    const character = { name: ctx.character.name, tags: [] as string[] };
    ctx.lorebook = runLorebook({
      entries: repos.lorebooks.listEntries(book.id),
      scanText: [],
      settings: { scanDepth: 2, budgetTokens: 1000 },
      character,
    });
    const result = await buildPrompt(ctx);
    const contents = result.messages.map((message) => message.content);
    const before = contents.indexOf("CONSTANT BEFORE");
    const after = contents.indexOf("CONSTANT AFTER");
    expect(before).toBeGreaterThan(-1);
    // worldInfoBefore renders before the persona/description blocks.
    expect(before).toBeLessThan(contents.findIndex((c) => c.includes("catgirl")));
    expect(after).toBeGreaterThan(contents.findIndex((c) => c.includes("personality: playful")));
    expect(after).toBeLessThan(contents.indexOf("message 0"));
    const atDepth = result.messages.findIndex((message) => message.content === "AT DEPTH WI");
    expect(result.messages[atDepth + 1]?.content).toBe("message 3");
  });

  it("trims the oldest history messages when over budget", async () => {
    const result = await buildPrompt(
      makeContext({ options: { contextSize: 212, maxTokens: 100 } }),
    );
    const contents = result.messages.map((message) => message.content);
    expect(contents).not.toContain("message 0");
    expect(contents).toContain("message 3");
    expect(result.tokenCount).toBeLessThanOrEqual(112);
    expect(result.budget.remaining).toBeGreaterThanOrEqual(0);
  });

  it("trims multiple history rows by index, keeping an interleaved depth injection", async () => {
    const preset = defaultPreset();
    const mainPrompt = preset.prompts.find((prompt) => prompt.id === "main");
    if (mainPrompt) {
      mainPrompt.content = "You are {{char}}.";
    }
    // Depth 3 lands the injection between message 0 and message 1 in the
    // rendered history (history: false), i.e. between the two oldest rows
    // this budget forces out. A wrong trim that dropped the oldest items of
    // the whole history region — injection included — would therefore lose
    // DEPTH BLOCK, which the assertions below catch.
    preset.prompts.push({
      id: "injector",
      name: "Injector",
      role: "system",
      content: "DEPTH BLOCK",
      enabled: true,
      injection_position: 1,
      injection_depth: 3,
      injection_order: 100,
      injection_trigger: [],
    });

    // Unbounded build: total with nothing trimmed. The first two history rows
    // ("message 0" and "message 1") cost exactly this much together, so this
    // budget fits only after both are dropped — forcing precisely two drops.
    const full = await buildPrompt(
      makeContext({ preset, options: { contextSize: 100000, maxTokens: 0 } }),
    );
    const firstTwo = countMessagesTokens([{ content: "message 0" }, { content: "message 1" }]);
    const budget = full.tokenCount - firstTwo;

    const result = await buildPrompt(
      makeContext({ preset, options: { contextSize: budget, maxTokens: 0 } }),
    );
    const contents = result.messages.map((message) => message.content);
    // The two oldest history rows are gone...
    expect(contents).not.toContain("message 0");
    expect(contents).not.toContain("message 1");
    // ...but the non-history injection interleaved between them survives,
    // ahead of the later rows.
    expect(contents).toContain("DEPTH BLOCK");
    expect(contents).toContain("message 2");
    expect(contents).toContain("message 3");
    expect(contents.indexOf("DEPTH BLOCK")).toBeLessThan(contents.indexOf("message 2"));
    // Non-history blocks (main prompt) are never trimmed.
    expect(contents).toContain("You are Seraphina.");
    expect(result.tokenCount).toBe(budget);
    expect(result.budget.remaining).toBe(0);
  });

  it("defaults the budget without build options", async () => {
    const result = await buildPrompt(makeContext());
    expect(result.budget.context).toBe(128000);
    expect(result.budget.remaining).toBe(128000 - 4096 - result.tokenCount);
  });

  it("supports custom pipeline stages rewriting the context", async () => {
    registerPipelineStage({
      id: "tracker",
      run: async (ctx) => {
        ctx.history = ctx.history.filter((message) => message.role === "assistant");
      },
    });
    const result = await buildPrompt(makeContext());
    const contents = result.messages.map((message) => message.content);
    expect(contents).not.toContain("message 0");
    expect(contents).toContain("message 1");
    expect(contents).not.toContain("message 2");
    resetPipelineStages();
  });

  it("renders a memory strategy summary after the history, before the next block", async () => {
    const ctx = makeContext();
    registerPipelineStage(
      {
        id: "summary-setter",
        run: async (stageCtx) => {
          stageCtx.summary = {
            seqFrom: 1,
            seqTo: 2,
            text: "[Summary of earlier conversation]\nThey met in the library.",
          };
        },
      },
      { after: "memory" },
    );
    const result = await buildPrompt(ctx);
    const contents = result.messages.map((message) => message.content);
    const summaryIndex = contents.indexOf(
      "[Summary of earlier conversation]\nThey met in the library.",
    );
    expect(summaryIndex).toBeGreaterThan(-1);
    // Tail placement: after the whole live window, immediately before the
    // post-history instructions. The summary therefore never sits between the
    // canon prefix and the conversation, where a rewrite would invalidate the
    // cached prefix on every chunk boundary.
    const lastHistoryIndex = contents.indexOf("message 3");
    const jailbreakIndex = contents.findIndex((content) => content.includes("Stay in character"));
    expect(summaryIndex).toBeGreaterThan(lastHistoryIndex);
    expect(summaryIndex).toBeLessThan(jailbreakIndex);
    expect(contents[summaryIndex - 1]).toBe("message 3");
  });

  it("renders injected state rows after the summary, before the next block", async () => {
    const ctx = makeContext();
    registerPipelineStage(
      {
        id: "summary-setter",
        run: async (stageCtx) => {
          stageCtx.summary = { seqFrom: 1, seqTo: 2, text: "SUMMARY BLOCK" };
        },
      },
      { after: "memory" },
    );
    registerPipelineStage(
      {
        id: "tail-setter",
        run: async (stageCtx) => {
          const template = stageCtx.history[0];
          if (template) {
            stageCtx.tail = [
              {
                ...template,
                id: "state:1",
                role: "system",
                content: "STATE BLOCK",
              },
            ];
          }
        },
      },
      { after: "tracker" },
    );
    const result = await buildPrompt(ctx);
    const contents = result.messages.map((message) => message.content);
    const summaryIndex = contents.indexOf("SUMMARY BLOCK");
    const stateIndex = contents.indexOf("STATE BLOCK");
    const jailbreakIndex = contents.findIndex((content) => content.includes("Stay in character"));
    // Stable-to-dynamic: summary, then state, then the instructions.
    expect(summaryIndex).toBeLessThan(stateIndex);
    expect(stateIndex).toBeLessThan(jailbreakIndex);
  });

  it("never trims the summary or injected state rows as history", async () => {
    // A budget tight enough to drop the oldest live rows must still keep both
    // tail blocks: they are not conversation and never competed for the
    // history budget.
    const registerTail = (): void => {
      registerPipelineStage(
        {
          id: "summary-setter",
          run: async (stageCtx) => {
            stageCtx.summary = { seqFrom: 1, seqTo: 2, text: "SUMMARY BLOCK" };
          },
        },
        { after: "memory" },
      );
      registerPipelineStage(
        {
          id: "tail-setter",
          run: async (stageCtx) => {
            const template = stageCtx.history[0];
            if (template) {
              stageCtx.tail = [
                { ...template, id: "state:1", role: "system", content: "STATE BLOCK" },
              ];
            }
          },
        },
        { after: "tracker" },
      );
    };

    registerTail();
    // Unbounded build first; the budget below is exactly its total minus the
    // two oldest history rows, so trimming must drop precisely those two.
    const full = await buildPrompt(makeContext({ options: { contextSize: 100000, maxTokens: 0 } }));
    const firstTwo = countMessagesTokens([{ content: "message 0" }, { content: "message 1" }]);

    resetPipelineStages();
    registerTail();
    const result = await buildPrompt(
      makeContext({ options: { contextSize: full.tokenCount - firstTwo, maxTokens: 0 } }),
    );
    const contents = result.messages.map((message) => message.content);
    expect(contents).not.toContain("message 0");
    expect(contents).not.toContain("message 1");
    expect(contents).toContain("message 3");
    // The tail blocks survive the trim untouched.
    expect(contents).toContain("SUMMARY BLOCK");
    expect(contents).toContain("STATE BLOCK");
  });

  it("keeps the canon prefix and conversation byte-stable when the summary changes", async () => {
    // The whole point of the tail placement: a summary rewrite (a chunk
    // boundary landing) must not disturb the messages a provider has already
    // cached. Walk two builds that differ ONLY in the summary text and assert
    // everything up to (not including) the summary is identical.
    const build = async (summaryText: string) => {
      resetPipelineStages();
      registerPipelineStage(
        {
          id: "summary-setter",
          run: async (stageCtx) => {
            stageCtx.summary = { seqFrom: 1, seqTo: 2, text: summaryText };
          },
        },
        { after: "memory" },
      );
      return buildPrompt(makeContext());
    };

    const before = await build("SUMMARY ONE");
    const after = await build("SUMMARY TWO");

    const summaryIndex = before.messages.findIndex((message) => message.content === "SUMMARY ONE");
    expect(summaryIndex).toBeGreaterThan(0);
    expect(after.messages[summaryIndex]?.content).toBe("SUMMARY TWO");
    // Every message before the summary is byte-identical, in the same order.
    expect(after.messages.slice(0, summaryIndex)).toEqual(before.messages.slice(0, summaryIndex));
  });

  /** One stored rule with overridable fields (schema defaults applied inline). */
  function storeRule(overrides: Partial<RegexRule> = {}): void {
    repos.settings.set(REGEX_RULES_KEY, [
      {
        id: "test-rule",
        name: "Test rule",
        find: "/foo/g",
        replace: "bar",
        placement: ["ai"],
        enabled: true,
        ...overrides,
      },
    ]);
  }

  it("applies prompt-placement rules to preset blocks and character fields, recounting tokens", async () => {
    const baseline = await buildPrompt(makeContext());
    storeRule({
      find: "/Seraphina/g",
      replace: "Bartholomew Quackenbush the Third",
      placement: ["prompt"],
    });
    const result = await buildPrompt(makeContext());
    const contents = result.messages.map((message) => message.content);
    // Preset main block ("You are {{char}}.") and the character description
    // both went through the prompt pass, AFTER macro expansion.
    expect(contents).toContain("You are Bartholomew Quackenbush the Third.");
    expect(contents).toContain("Bartholomew Quackenbush the Third is a catgirl. Speaks to Alex.");
    expect(contents).not.toContain("You are Seraphina.");
    // The tokens reflect the transformed text (not the pre-regex content).
    expect(result.tokenCount).toBe(countMessagesTokens(result.messages));
    expect(result.tokenCount).toBeGreaterThan(baseline.tokenCount);
  });

  it("applies prompt-placement rules to lorebook activations and the summary", async () => {
    const ctx = makeContext();
    storeRule({ find: "/CONSTANT/g", replace: "REPLACED", placement: ["prompt"] });
    const book = repos.lorebooks.create({ name: "Book" });
    repos.lorebooks.addEntry(book.id, {
      keys: [],
      content: "{{char}} says CONSTANT",
      constant: true,
      position: 0,
    });
    ctx.lorebook = runLorebook({
      entries: repos.lorebooks.listEntries(book.id),
      scanText: [],
      settings: { scanDepth: 2, budgetTokens: 1000 },
      character: { name: ctx.character.name, tags: [] },
      macros: ctx.macros,
    });
    // Set the summary AFTER the memory stage runs (it owns ctx.summary).
    registerPipelineStage(
      {
        id: "summary-setter",
        run: async (stageCtx) => {
          stageCtx.summary = { seqFrom: 1, seqTo: 1, text: "SUMMARY CONSTANT" };
        },
      },
      { after: "memory" },
    );
    const result = await buildPrompt(ctx);
    const contents = result.messages.map((message) => message.content);
    // Macros ran inside the lorebook engine (Seraphina), then the prompt pass.
    expect(contents).toContain("Seraphina says REPLACED");
    expect(contents).toContain("SUMMARY REPLACED");
  });

  it("applies user-placement rules to user history rows only", async () => {
    storeRule({ find: "/message/g", replace: "MSG", placement: ["user"] });
    const result = await buildPrompt(makeContext());
    const contents = result.messages.map((message) => message.content);
    expect(contents).toContain("MSG 0");
    expect(contents).toContain("MSG 2");
    expect(contents).toContain("message 1");
    expect(contents).toContain("message 3");
  });

  it("applies assistant-placement rules to assistant history rows only", async () => {
    storeRule({ find: "/message/g", replace: "RESP", placement: ["ai"] });
    const result = await buildPrompt(makeContext());
    const contents = result.messages.map((message) => message.content);
    expect(contents).toContain("RESP 1");
    expect(contents).toContain("RESP 3");
    expect(contents).toContain("message 0");
    expect(contents).toContain("message 2");
  });

  it("skips the regex pass for assistant rows already marked regex_applied", async () => {
    storeRule({ find: "/message/g", replace: "RESP", placement: ["ai"] });
    const ctx = makeContext();
    const template = ctx.history[1];
    if (!template) {
      throw new Error("expected a history message");
    }
    ctx.history = [
      ...ctx.history.slice(0, 1),
      // Persisted reply: content already transformed, macros still expected.
      { ...template, content: "message 1 {{user}}", metadata: { regex_applied: true } },
      ...ctx.history.slice(2),
    ];
    const result = await buildPrompt(ctx);
    const contents = result.messages.map((message) => message.content);
    expect(contents).toContain("message 1 Alex");
    expect(contents).not.toContain("RESP 1 Alex");
    // An unmarked assistant row still takes the pass.
    expect(contents).toContain("RESP 3");
  });

  it("is a byte-for-byte no-op when no rules are configured", async () => {
    const withoutRules = await buildPrompt(makeContext());
    repos.settings.set(REGEX_RULES_KEY, []);
    const withEmptyRules = await buildPrompt(makeContext());
    expect(withEmptyRules.messages).toEqual(withoutRules.messages);
    expect(withEmptyRules.tokenCount).toBe(withoutRules.tokenCount);
    const contents = withoutRules.messages.map((message) => message.content);
    expect(contents).toContain("Seraphina is a catgirl. Speaks to Alex.");
    expect(contents).toContain("You are Seraphina.");
  });
});
