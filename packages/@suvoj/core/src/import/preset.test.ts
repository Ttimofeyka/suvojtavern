/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import { createTestDb } from "../test-utils";
import {
  importPreset,
  PresetConflictError,
  type PresetImportSource,
  parsePresetFile,
} from "./preset";

/** The shipped built-in preset (the seeded copy is the canonical source). */
const START_PRESET_URL = new URL(
  "../../../../../packages/server/seed/START_PRESET.json",
  import.meta.url,
);

let repos: Repositories;

beforeEach(() => {
  repos = createRepositories(createTestDb());
});

describe("parsePresetFile — native documents", () => {
  it("normalizes a native document and fills defaults", () => {
    const parsed = parsePresetFile({
      name: "Native",
      prompts: [{ id: "worldInfoBefore", name: "Lorebook", marker: "worldInfoBefore" }],
    });
    expect(parsed.source).toBe("suvoj");
    expect(parsed.preset.name).toBe("Native");
    expect(parsed.preset.description).toBe("");
    const prompt = parsed.preset.prompts[0];
    expect(prompt?.role).toBe("system");
    expect(prompt?.enabled).toBe(true);
    expect(prompt?.injection_position).toBe(0);
    expect(prompt?.injection_depth).toBe(4);
    expect(prompt?.injection_order).toBe(100);
    expect(parsed.preset.settings.scan_depth).toBe(2);
    expect(parsed.preset.settings.memory.strategy).toBe("trim");
  });

  it("heals a missing prompt id into a slug from its name", () => {
    const parsed = parsePresetFile({
      name: "Heal",
      prompts: [{ name: "Enhance Definitions", content: "x" }],
    });
    expect(parsed.preset.prompts[0]?.id).toBe("enhance-definitions");
  });

  it("never lets a derived slug shadow a marker id", () => {
    const parsed = parsePresetFile({
      name: "Shadow",
      prompts: [
        { name: "main", content: "a" },
        { name: "Main", content: "b" },
      ],
    });
    const ids = parsed.preset.prompts.map((prompt) => prompt.id);
    expect(ids).not.toContain("main");
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("main-2");
  });

  it("respects an explicit id and dedupes a later healed slug against it", () => {
    const parsed = parsePresetFile({
      name: "Mixed",
      prompts: [{ name: "Echo" }, { id: "echo", name: "Echo again" }],
    });
    const ids = parsed.preset.prompts.map((prompt) => prompt.id);
    expect(ids).toEqual(["echo-2", "echo"]);
  });

  it("throws on a non-object input", () => {
    expect(() => parsePresetFile(null)).toThrow("not a preset file");
    expect(() => parsePresetFile([])).toThrow("not a preset file");
    expect(() => parsePresetFile("nope")).toThrow("not a preset file");
    expect(() => parsePresetFile(42)).toThrow("not a preset file");
  });
});

describe("parsePresetFile — SillyTavern documents", () => {
  it("detects and converts START_PRESET.json", async () => {
    const parsed = parsePresetFile(await Bun.file(START_PRESET_URL).json());
    expect(parsed.source).toBe("sillytavern");
    expect(parsed.preset.prompts[0]?.id).toBe("main");
    const worldInfo = parsed.preset.prompts.find((prompt) => prompt.id === "worldInfoBefore");
    expect(worldInfo?.marker).toBe("worldInfoBefore");
    expect(parsed.preset.settings.new_chat_prompt).toBe("[Start a new Chat]");
  });
});

describe("importPreset", () => {
  const doc = {
    name: "Imported",
    prompts: [{ id: "main", name: "Main prompt", marker: "main" }],
    settings: { scan_depth: 5 },
  };

  it("creates a new row", () => {
    const result = importPreset(doc, repos.presets);
    expect(result.renamed).toBe(false);
    expect(result.replaced).toBe(false);
    expect(result.source).toBe("suvoj");
    expect(result.preset.id).toBeTruthy();
    expect(repos.presets.list()).toHaveLength(1);
  });

  it("throws PresetConflictError on a case-insensitive name clash by default", () => {
    importPreset(doc, repos.presets);
    expect(() => importPreset({ ...doc, name: "imported" }, repos.presets)).toThrow(
      PresetConflictError,
    );
    expect(repos.presets.list()).toHaveLength(1);
  });

  it("renames on conflict and leaves the original untouched", () => {
    const first = importPreset(doc, repos.presets);
    const second = importPreset({ ...doc, settings: { scan_depth: 9 } }, repos.presets, {
      onConflict: "rename",
    });
    expect(second.renamed).toBe(true);
    expect(second.replaced).toBe(false);
    expect(second.preset.name).toBe("Imported 2");
    expect(second.preset.id).not.toBe(first.preset.id);
    expect(repos.presets.list()).toHaveLength(2);
    const untouched = repos.presets.get(first.preset.id);
    expect(untouched?.settings.scan_depth).toBe(5);
  });

  it("replaces the same-name row in place", () => {
    const first = importPreset(doc, repos.presets);
    const second = importPreset(
      { ...doc, prompts: [{ id: "jailbreak", name: "Post", marker: "jailbreak" }] },
      repos.presets,
      { onConflict: "replace" },
    );
    expect(second.replaced).toBe(true);
    expect(second.renamed).toBe(false);
    expect(second.preset.id).toBe(first.preset.id);
    expect(second.preset.prompts.map((prompt) => prompt.id)).toEqual(["jailbreak"]);
    expect(repos.presets.list()).toHaveLength(1);
  });

  it("accepts an explicit source on the result", () => {
    const result = importPreset(doc, repos.presets);
    const source: PresetImportSource = result.source;
    expect(source).toBe("suvoj");
  });

  it("overrides the document name with the name option", () => {
    const result = importPreset(doc, repos.presets, { name: "Custom" });
    expect(result.preset.name).toBe("Custom");
    expect(repos.presets.get(result.preset.id)?.name).toBe("Custom");
  });

  it("imports a SillyTavern preset through the repository", async () => {
    const result = importPreset(await Bun.file(START_PRESET_URL).json(), repos.presets, {
      name: "ST Import",
    });
    expect(result.source).toBe("sillytavern");
    expect(result.preset.name).toBe("ST Import");
    expect(result.preset.prompts[0]?.id).toBe("main");
    expect(repos.presets.list()[0]?.prompts.length).toBeGreaterThan(10);
  });
});
