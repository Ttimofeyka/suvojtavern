/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import { createTestDb } from "../test-utils";
import type { PromptContext } from "./pipeline";
import { resetPipelineStages } from "./pipeline";
import type { Preset, PresetPrompt } from "./preset";
import { convertStPreset, defaultPreset } from "./preset";
import { buildPrompt } from "./prompt";

/**
 * `injection_trigger` gating (ST parity). A trigger list gates a prompt to a
 * generation type; an EMPTY list means "all types" (today's behaviour), so
 * every new assertion here is anchored to the empty-list case staying a
 * no-op.
 */

/** One ST prompt entry with an overridable trigger, for conversion tests. */
function stPrompt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identifier: "gate-me",
    name: "Gate Me",
    role: "system",
    content: "GATED CONTENT",
    injection_trigger: [],
    ...overrides,
  };
}

/** A minimal ST chat-completion preset wrapping `prompts` + `prompt_order`. */
function stPreset(prompts: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    name: "Trigger Test",
    prompts,
    prompt_order: [
      {
        order: prompts.map((prompt, index) => ({
          identifier: String(prompt.identifier ?? `p${index}`),
          enabled: true,
        })),
      },
    ],
  };
}

describe("injection_trigger — SillyTavern conversion", () => {
  it("carries ST's trigger array through convertStPreset", () => {
    const converted = convertStPreset(
      stPreset([stPrompt({ identifier: "gated", name: "Gated", injection_trigger: ["continue"] })]),
    );
    const gated = converted.prompts.find((prompt) => prompt.id === "gated");
    expect(gated?.injection_trigger).toEqual(["continue"]);
  });

  it("treats an absent or malformed trigger as the empty (all-types) list", () => {
    const converted = convertStPreset(
      stPreset([
        stPrompt({ identifier: "absent", name: "Absent", injection_trigger: undefined }),
        stPrompt({ identifier: "bad", name: "Bad", injection_trigger: "continue" }),
      ]),
    );
    expect(converted.prompts.find((prompt) => prompt.id === "absent")?.injection_trigger).toEqual(
      [],
    );
    expect(converted.prompts.find((prompt) => prompt.id === "bad")?.injection_trigger).toEqual([]);
  });

  it("drops non-string entries but keeps unknown trigger strings", () => {
    const converted = convertStPreset(
      stPreset([
        stPrompt({
          identifier: "mixed",
          name: "Mixed",
          injection_trigger: ["continue", 42, null, "future-type"],
        }),
      ]),
    );
    expect(converted.prompts.find((prompt) => prompt.id === "mixed")?.injection_trigger).toEqual([
      "continue",
      "future-type",
    ]);
  });

  it("does not throw on an unknown trigger string", () => {
    expect(() =>
      convertStPreset(
        stPreset([stPrompt({ identifier: "x", name: "X", injection_trigger: ["never-seen"] })]),
      ),
    ).not.toThrow();
  });

  it("defaults the native schema's trigger to an empty array", () => {
    const preset = defaultPreset();
    for (const prompt of preset.prompts) {
      expect(prompt.injection_trigger).toEqual([]);
    }
  });
});

describe("injection_trigger — prompt assembly gating", () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(createTestDb());
    resetPipelineStages();
  });

  /** Build context over a one-message chat; mirrors prompt.test.ts's helper. */
  function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
    const character = repos.characters.create({
      name: "Seraphina",
      description: "{{char}} is a catgirl.",
      personality: "playful",
      scenario: "the library",
      mes_example: "",
    });
    const chat = repos.chats.create({ character_id: character.id });
    repos.messages.insertMessage(chat.id, { role: "user", content: "message 0" });
    return {
      chat,
      character,
      persona: null,
      preset: defaultPreset(),
      history: repos.messages.listActive(chat.id),
      lorebook: null,
      macros: {
        char: character.name,
        user: "User",
        persona: "",
        chatId: chat.id,
        vars: repos.variables,
        lastMessage: "message 0",
      },
      rng: () => 0.5,
      repos,
      ...overrides,
    };
  }

  /** A regular (non-marker) prompt gated to `trigger`. */
  function gatedPrompt(trigger: string[]): PresetPrompt {
    return {
      id: "gated",
      name: "Gated",
      role: "system",
      content: "GATED CONTENT",
      enabled: true,
      injection_position: 0,
      injection_depth: 4,
      injection_order: 100,
      injection_trigger: trigger,
    };
  }

  const withPrompt = (prompt: PresetPrompt): Preset => {
    const preset = defaultPreset();
    preset.prompts.push(prompt);
    return preset;
  };

  it("includes an empty-trigger prompt in every generation type", async () => {
    const preset = withPrompt(gatedPrompt([]));
    for (const generationType of ["normal", "continue", "regenerate", "swipe"] as const) {
      const result = await buildPrompt(makeContext({ preset, generationType }));
      expect(result.messages.map((message) => message.content)).toContain("GATED CONTENT");
    }
  });

  it("includes a prompt with no generation type on the context (defaults to normal)", async () => {
    const result = await buildPrompt(makeContext({ preset: withPrompt(gatedPrompt([])) }));
    expect(result.messages.map((message) => message.content)).toContain("GATED CONTENT");
  });

  it("excludes a continue-gated prompt from a normal build", async () => {
    const preset = withPrompt(gatedPrompt(["continue"]));
    const result = await buildPrompt(makeContext({ preset }));
    expect(result.messages.map((message) => message.content)).not.toContain("GATED CONTENT");
  });

  it("includes a continue-gated prompt in a continue build", async () => {
    const preset = withPrompt(gatedPrompt(["continue"]));
    const result = await buildPrompt(makeContext({ preset, generationType: "continue" }));
    expect(result.messages.map((message) => message.content)).toContain("GATED CONTENT");
  });

  it("never matches quiet/impersonate (no Suvoj equivalent)", async () => {
    const preset = withPrompt(gatedPrompt(["quiet", "impersonate"]));
    const result = await buildPrompt(makeContext({ preset }));
    expect(result.messages.map((message) => message.content)).not.toContain("GATED CONTENT");
  });

  it("does not throw on an unknown trigger string", async () => {
    const preset = withPrompt(gatedPrompt(["future-type"]));
    const result = await buildPrompt(makeContext({ preset }));
    expect(result.messages.map((message) => message.content)).not.toContain("GATED CONTENT");
  });

  it("gates in-chat depth injections too", async () => {
    const preset = withPrompt({ ...gatedPrompt(["continue"]), injection_position: 1 });
    const normal = await buildPrompt(makeContext({ preset }));
    expect(normal.messages.map((message) => message.content)).not.toContain("GATED CONTENT");
    const cont = await buildPrompt(makeContext({ preset, generationType: "continue" }));
    expect(cont.messages.map((message) => message.content)).toContain("GATED CONTENT");
  });
});
