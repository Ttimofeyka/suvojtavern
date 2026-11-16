/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import { parsePresetFile } from "../import/preset";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import type { Preset } from "../schema/presets";
import { createTestDb } from "../test-utils";
import { exportPreset, PRESET_FILE_FORMAT, PRESET_FILE_VERSION } from "./preset";

let repos: Repositories;
let row: Preset;

beforeEach(() => {
  repos = createRepositories(createTestDb());
  row = repos.presets.create({
    name: "Export Me",
    description: "a test preset",
    prompts: [
      { id: "main", name: "Main prompt", role: "system", marker: "main" },
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
});

describe("exportPreset", () => {
  it("emits the document fields and omits id/timestamps", () => {
    const file = exportPreset(row);
    expect(file.format).toBe(PRESET_FILE_FORMAT);
    expect(file.version).toBe(PRESET_FILE_VERSION);
    expect(file.name).toBe("Export Me");
    expect(file.description).toBe("a test preset");
    expect(file.prompts).toHaveLength(2);
    expect(file.settings?.scan_depth).toBe(5);
    expect("id" in file).toBe(false);
    expect("created_at" in file).toBe(false);
    expect("updated_at" in file).toBe(false);
  });

  it("round-trips through parsePresetFile", () => {
    const parsed = parsePresetFile(exportPreset(row));
    expect(parsed.source).toBe("suvoj");
    expect(parsed.preset.name).toBe("Export Me");
    expect(parsed.preset.prompts.map((prompt) => prompt.id)).toEqual(["main", "injector"]);
    expect(parsed.preset.settings.scan_depth).toBe(5);
    expect(parsed.preset.settings.wi_budget).toBe(256);
    const injector = parsed.preset.prompts.find((prompt) => prompt.id === "injector");
    expect(injector?.injection_position).toBe(1);
    expect(injector?.injection_depth).toBe(2);
  });

  it("embeds nested prompt objects verbatim", () => {
    const file = exportPreset(row);
    expect(file.prompts).toEqual(row.prompts);
  });

  it("fills defaults for a bare input", () => {
    const file = exportPreset({ name: "Bare" });
    expect(file.description).toBe("");
    expect(file.prompts).toEqual([]);
    expect(file.settings).toEqual({});
  });
});
