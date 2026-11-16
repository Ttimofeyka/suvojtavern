/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import { exportPreset as exportPresetFile } from "../export/preset";
import { parsePresetFile } from "../import/preset";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import { createTestDb } from "../test-utils";
import {
  convertStPreset,
  defaultPreset,
  fromStoredPreset,
  type Preset,
  presetSchema,
  promptGroupSchema,
} from "./preset";

/** The shipped built-in preset (the seeded copy is the canonical source). */
const START_PRESET_URL = new URL(
  "../../../../../packages/server/seed/START_PRESET.json",
  import.meta.url,
);

describe("preset format (v2)", () => {
  it("builds a sane default preset", () => {
    const preset = defaultPreset();
    expect(preset.name).toBe("Default");
    expect(preset.description).toBe("");
    expect(preset.prompts[0]?.id).toBe("main");
    expect(preset.prompts[preset.prompts.length - 1]?.id).toBe("jailbreak");
    expect(preset.prompts.map((prompt) => prompt.id)).toContain("worldInfoBefore");
    expect(preset.prompts.map((prompt) => prompt.id)).toContain("chatHistory");
    // Friendly display names for the marker skeleton.
    expect(preset.prompts.find((prompt) => prompt.id === "main")?.name).toBe("Main prompt");
    expect(preset.prompts.find((prompt) => prompt.id === "jailbreak")?.name).toBe(
      "Post-history instructions",
    );
    expect(preset.settings.scan_depth).toBe(2);
    expect(preset.settings.memory.strategy).toBe("trim");
    // v2 presets carry no sampling at all.
    expect("sampling" in preset).toBe(false);
  });

  it("round-trips a native preset through the repository", () => {
    const repos: Repositories = createRepositories(createTestDb());
    const preset: Preset = presetSchema.parse({
      name: "Native",
      description: "a test preset",
      prompts: [
        { id: "main", name: "Main prompt", marker: "main" },
        {
          id: "injector",
          name: "Injector",
          role: "user",
          content: "at depth",
          injection_position: 1,
          injection_depth: 2,
          injection_order: 300,
        },
      ],
      settings: { scan_depth: 5, wi_budget: 256 },
    });
    const stored = repos.presets.create({
      name: preset.name,
      description: preset.description,
      prompts: preset.prompts,
      settings: preset.settings,
    });
    const restored = fromStoredPreset(stored);
    expect(restored.name).toBe("Native");
    expect(restored.description).toBe("a test preset");
    expect(restored.prompts.map((prompt) => prompt.id)).toEqual(["main", "injector"]);
    expect(restored.settings.scan_depth).toBe(5);
    expect(restored.settings.wi_budget).toBe(256);
    const injector = restored.prompts.find((prompt) => prompt.id === "injector");
    expect(injector?.injection_depth).toBe(2);
    expect(injector?.injection_order).toBe(300);
    expect(injector?.injection_position).toBe(1);
  });

  describe("prompt groups (metadata only)", () => {
    it("parses a prompt without a group", () => {
      const preset = presetSchema.parse({
        name: "No groups",
        prompts: [{ id: "main", name: "Main prompt", marker: "main" }],
      });
      expect(preset.prompts[0]?.group).toBeUndefined();
    });

    it("parses a valid group and fills its label default", () => {
      expect(promptGroupSchema.parse({ id: "pov" })).toEqual({ id: "pov", label: "" });
      const preset = presetSchema.parse({
        name: "Grouped",
        prompts: [
          { id: "1st-person-pov", name: "1st", group: { id: "pov", label: "Point of View" } },
        ],
      });
      expect(preset.prompts[0]?.group).toEqual({ id: "pov", label: "Point of View" });
    });

    it("round-trips a group through export → import unchanged", () => {
      const preset = presetSchema.parse({
        name: "Round-trip",
        prompts: [
          { id: "main", name: "Main prompt", marker: "main" },
          {
            id: "1st-person-pov",
            name: "1st person POV",
            enabled: true,
            group: { id: "pov", label: "Point of View" },
          },
        ],
      });
      const file = exportPresetFile(preset);
      // The export format stays version 1: groups are optional metadata, so an
      // older file without them still parses.
      expect(file.version).toBe(1);
      const parsed = parsePresetFile(structuredClone(file));
      expect(parsed.source).toBe("suvoj");
      const restored = parsed.preset.prompts.find((prompt) => prompt.id === "1st-person-pov");
      expect(restored?.group).toEqual({ id: "pov", label: "Point of View" });
      // A group-less prompt stays group-less.
      expect(parsed.preset.prompts.find((prompt) => prompt.id === "main")?.group).toBeUndefined();
    });

    it("persists a group through the repository", () => {
      const repos: Repositories = createRepositories(createTestDb());
      const preset: Preset = presetSchema.parse({
        name: "Stored group",
        prompts: [
          {
            id: "hybrid-pov",
            name: "Hybrid POV",
            group: { id: "pov", label: "Point of View" },
          },
        ],
      });
      const stored = repos.presets.create({
        name: preset.name,
        description: preset.description,
        prompts: preset.prompts,
        settings: preset.settings,
      });
      const restored = fromStoredPreset(stored);
      expect(restored.prompts[0]?.group).toEqual({ id: "pov", label: "Point of View" });
    });
  });

  describe("SillyTavern conversion (START_PRESET.json)", () => {
    let converted: Preset;

    beforeEach(async () => {
      converted = convertStPreset(await Bun.file(START_PRESET_URL).json());
    });

    it("uses the prompt_order sequence as the prompts array", () => {
      // The lean built-in: every ST prompt appears in prompt_order (no
      // leftovers) — 41 rows, 21 enabled / 20 disabled.
      expect(converted.prompts).toHaveLength(41);
      expect(converted.prompts.filter((prompt) => prompt.enabled)).toHaveLength(21);
      expect(converted.prompts[0]?.id).toBe("main");
      const ids = converted.prompts.map((prompt) => prompt.id);
      expect(ids.indexOf("main")).toBeLessThan(ids.indexOf("worldInfoBefore"));
      expect(ids.indexOf("worldInfoBefore")).toBeLessThan(ids.indexOf("chatHistory"));
      expect(ids.indexOf("chatHistory")).toBeLessThan(ids.indexOf("jailbreak"));
    });

    it("gives every row a unique, slug-shaped id that nests under any marker", () => {
      const ids = converted.prompts.map((prompt) => prompt.id);
      expect(new Set(ids).size).toBe(ids.length);
      // Every non-marker id is a lowercase slug — never a UUID.
      for (const prompt of converted.prompts) {
        if (!prompt.marker) {
          expect(prompt.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        }
      }
    });

    it("enables exactly the lean core set", () => {
      const enabled = converted.prompts
        .filter((prompt) => prompt.enabled)
        .map((prompt) => prompt.id)
        .sort();
      expect(enabled).toEqual(
        [
          "main",
          "worldInfoBefore",
          "personaDescription",
          "charDescription",
          "charPersonality",
          "scenario",
          "worldInfoAfter",
          "dialogueExamples",
          "chatHistory",
          "cinematic-realism",
          "hybrid-pov",
          "realism-mode-jailbreak",
          "anti-parrot-and-anti-echo",
          "total-output-length",
          "npc-voice-dialogue-output",
          "anti-omniscient-npcs-and-thoughts",
          "npc-instincts-vad-emotions",
          "realistic-npcs",
          "bolt-chain-of-thought",
          "identity",
          "knowledge-rule",
        ].sort(),
      );
    });

    it("never lets an enabled prompt read a variable nothing in the file sets", () => {
      // Regression guard for the original breakage: the preset used to read
      // {{getvar::…}} values produced by deleted internal-state rows. Producers
      // are collected from every converted prompt; consumers only from the
      // ENABLED ones (disabled rows never render).
      const producers = new Set<string>();
      for (const prompt of converted.prompts) {
        for (const match of prompt.content.matchAll(/\{\{setvar::([A-Za-z0-9_]+)::/g)) {
          producers.add(match[1] as string);
        }
      }
      const orphans = new Set<string>();
      for (const prompt of converted.prompts) {
        if (!prompt.enabled) {
          continue;
        }
        for (const match of prompt.content.matchAll(/\{\{getvar::([A-Za-z0-9_]+)/g)) {
          if (!producers.has(match[1] as string)) {
            orphans.add(match[1] as string);
          }
        }
      }
      expect([...orphans]).toEqual([]);
    });

    it("maps marker prompts and keeps main/jailbreak content", () => {
      const worldInfo = converted.prompts.find((prompt) => prompt.id === "worldInfoBefore");
      expect(worldInfo?.marker).toBe("worldInfoBefore");
      const main = converted.prompts.find((prompt) => prompt.id === "main");
      expect(main?.marker).toBe("main");
      expect(main?.content.length).toBeGreaterThan(0);
      // main's leading macro run is gone; only prose instructions remain.
      expect(main?.content.startsWith("{{setvar::")).toBe(false);
      const jailbreak = converted.prompts.find((prompt) => prompt.id === "jailbreak");
      expect(jailbreak?.marker).toBe("jailbreak");
      // Regular prompts stay regular (no marker field).
      const regular = converted.prompts.find((prompt) => prompt.id === "enhance-definitions");
      expect(regular?.marker).toBeUndefined();
    });

    it("carries no sampling and no description", () => {
      expect("sampling" in converted).toBe(false);
      expect(converted.description).toBe("");
    });

    it("carries ST prompt texts into settings", () => {
      expect(converted.settings.new_chat_prompt).toBe("[Start a new Chat]");
      // The key was dropped from the source, so the engine default applies.
      expect(converted.settings.new_example_chat_prompt).toBe("[Example Chat]");
      expect(converted.settings.personality_format).toBe("{{char}}'s personality: {{personality}}");
    });

    it("seeds as the stored built-in preset (name, prompts, settings)", async () => {
      const preset = convertStPreset(await Bun.file(START_PRESET_URL).json());
      preset.name = "Suvoj Default";
      const repos: Repositories = createRepositories(createTestDb());
      const saved = repos.presets.create({
        name: preset.name,
        description: "",
        prompts: preset.prompts,
        settings: preset.settings,
      });
      const restored = fromStoredPreset(saved);
      expect(restored.name).toBe("Suvoj Default");
      expect(restored.prompts.length).toBeGreaterThan(10);
      expect(restored.prompts[0]?.id).toBe("main");
      expect(restored.settings.new_chat_prompt).toBe("[Start a new Chat]");
    });
  });

  /**
   * Converter behaviour, exercised on small synthetic ST documents so the
   * assertions stay valid independently of the shipped preset file.
   */
  describe("SillyTavern conversion (synthetic fixtures)", () => {
    /** One ST prompt with overridable fields. */
    function stPrompt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        identifier: "p",
        name: "Prompt",
        role: "system",
        content: "CONTENT",
        ...overrides,
      };
    }

    /** A synthetic ST preset wrapping `prompts` + an all-enabled order. */
    function stPreset(prompts: Array<Record<string, unknown>>): Record<string, unknown> {
      return {
        name: "Synthetic",
        prompts,
        prompt_order: [{ order: orderOf(...prompts) }],
      };
    }

    /** `prompt_order` entries for the given ST prompts, all enabled. */
    function orderOf(...prompts: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
      return prompts.map((prompt) => ({
        identifier: String(prompt.identifier ?? ""),
        enabled: true,
      }));
    }

    it("slugifies non-marker ids from their names", () => {
      const converted = convertStPreset(
        stPreset([stPrompt({ identifier: "aaa", name: "Enhance Definitions" })]),
      );
      expect(converted.prompts[0]?.id).toBe("enhance-definitions");
    });

    it("deduplicates slug collisions with numeric suffixes", () => {
      const converted = convertStPreset(
        stPreset([
          stPrompt({ identifier: "a", name: "Story Mode" }),
          stPrompt({ identifier: "b", name: "story  mode" }),
          stPrompt({ identifier: "c", name: "STORY MODE!" }),
        ]),
      );
      expect(converted.prompts.map((prompt) => prompt.id)).toEqual([
        "story-mode",
        "story-mode-2",
        "story-mode-3",
      ]);
    });

    it("appends prompts missing from the order disabled at the end", () => {
      const main = stPrompt({ identifier: "main", name: "Main" });
      const leftover = stPrompt({ identifier: "leftover", name: "Leftover" });
      // Only `main` is ordered: the leftover must be appended disabled.
      const converted = convertStPreset({
        name: "Synthetic",
        prompts: [main, leftover],
        prompt_order: [{ order: orderOf(main) }],
      });
      expect(converted.prompts.map((prompt) => prompt.id)).toEqual(["main", "leftover"]);
      expect(converted.prompts[1]?.enabled).toBe(false);
    });

    it("detects ST's main/jailbreak markers by identifier even without ST's flag", () => {
      const converted = convertStPreset(
        stPreset([
          stPrompt({ identifier: "main", name: "Main prompt" }),
          stPrompt({ identifier: "jailbreak", name: "Post-History Instructions" }),
          stPrompt({ identifier: "worldInfoBefore", name: "Lorebook", marker: true }),
        ]),
      );
      expect(converted.prompts.find((prompt) => prompt.id === "main")?.marker).toBe("main");
      expect(converted.prompts.find((prompt) => prompt.id === "jailbreak")?.marker).toBe(
        "jailbreak",
      );
      expect(converted.prompts.find((prompt) => prompt.id === "worldInfoBefore")?.marker).toBe(
        "worldInfoBefore",
      );
    });
  });
});
