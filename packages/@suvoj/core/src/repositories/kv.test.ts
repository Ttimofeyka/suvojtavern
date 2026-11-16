/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import { createTestDb } from "../test-utils";
import { CharactersRepository } from "./characters";
import { ChatsRepository } from "./chats";
import { SettingsRepository } from "./kv";
import { PresetsRepository } from "./presets";
import { SummariesRepository } from "./summaries";

let settings: SettingsRepository;
let presets: PresetsRepository;
let summaries: SummariesRepository;
let chats: ChatsRepository;
let characterId: string;

beforeEach(() => {
  const db = createTestDb();
  const characters = new CharactersRepository(db);
  chats = new ChatsRepository(db);
  settings = new SettingsRepository(db);
  presets = new PresetsRepository(db);
  summaries = new SummariesRepository(db);
  characterId = characters.create({ name: "Summarized" }).id;
});

describe("SettingsRepository", () => {
  it("stores JSON values, overwrites and deletes", () => {
    settings.set("theme", { mode: "dark", scale: 1.25 });
    expect(settings.get("theme")).toEqual({ mode: "dark", scale: 1.25 });
    settings.set("theme", "light");
    expect(settings.get("theme")).toBe("light");
    expect(settings.get("missing")).toBe(null);
    expect(settings.delete("theme")).toBe(true);
    expect(settings.get("theme")).toBe(null);
  });
});

describe("PresetsRepository", () => {
  it("round-trips prompts and settings (the array IS the layout)", () => {
    const preset = presets.create({
      name: "Default",
      description: "a preset",
      prompts: [{ id: "main", name: "Main prompt", marker: "main", content: "sys" }],
      settings: { scan_depth: 3 },
    });
    expect(presets.get(preset.id)).toEqual(preset);
    expect(presets.update(preset.id, { name: "Renamed" })?.name).toBe("Renamed");
    expect(presets.list().map((p) => p.name)).toEqual(["Renamed"]);
    expect(presets.delete(preset.id)).toBe(true);
    expect(presets.get(preset.id)).toBe(null);
  });

  it("defaults description, prompts and settings on create", () => {
    const preset = presets.create({ name: "Bare" });
    expect(preset).toMatchObject({
      name: "Bare",
      description: "",
      prompts: [],
      settings: {},
    });
  });
});

describe("SummariesRepository", () => {
  it("stores hierarchical summaries per chat, cascading with the chat", () => {
    const chat = chats.create({ character_id: characterId });
    const s1 = summaries.create(chat.id, {
      level: 0,
      seq_from: 1,
      seq_to: 20,
      summary: "first",
      tokens: 120,
    });
    summaries.create(chat.id, { level: 1, seq_from: 1, seq_to: 2, summary: "second" });
    expect(summaries.list(chat.id).map((s) => s.level)).toEqual([0, 1]);
    expect(summaries.update(s1.id, { summary: "edited" })?.summary).toBe("edited");
    expect(summaries.delete(s1.id)).toBe(true);
    expect(chats.delete(chat.id)).toBe(true);
    expect(summaries.list(chat.id)).toEqual([]);
  });
});
