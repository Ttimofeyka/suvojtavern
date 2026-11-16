/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import { stmt } from "../db/sql";
import { createTestDb } from "../test-utils";
import { PresetsRepository } from "./presets";

/**
 * Repository-level control normalization. A row named by a control option has
 * no independent on/off state, so the STORED `enabled` flag must always equal
 * the flag the chosen option dictates — for every write path at once (the
 * controls route, the editor's Save, create, and both importers, which write
 * through `create`/`update`). Otherwise the editor (which renders the stored
 * rows) silently disagrees with generation.
 */

/** Four mutually-exclusive POV rows, matching the built-in preset's control. */
const POV_CONTROLS: Array<Record<string, unknown>> = [
  {
    id: "pov",
    label: "Point of View",
    type: "select",
    default: "hybrid",
    options: [
      { id: "first", label: "1st person", prompts: ["1st-person-pov"] },
      { id: "second", label: "2nd person", prompts: ["2nd-person-pov"] },
      { id: "third", label: "3rd person", prompts: ["3rd-person-pov"] },
      { id: "hybrid", label: "Hybrid", prompts: ["hybrid-pov"] },
    ],
  },
];

/** The four governed rows, all off — a deliberately inconsistent start. */
const POV_ROWS: Array<Record<string, unknown>> = [
  { id: "main", name: "Main", marker: "main" },
  { id: "1st-person-pov", name: "1st", enabled: false },
  { id: "2nd-person-pov", name: "2nd", enabled: false },
  { id: "3rd-person-pov", name: "3rd", enabled: false },
  { id: "hybrid-pov", name: "Hybrid", enabled: false },
];

/** The settings object declaring the POV control with `choice` stored. */
function povSettings(choice?: Record<string, string>): Record<string, unknown> {
  return choice === undefined
    ? { controls: POV_CONTROLS }
    : { controls: POV_CONTROLS, control_values: choice };
}

/** `id → enabled` for the four governed rows, for compact assertions. */
function povFlags(rows: ReadonlyArray<Record<string, unknown>>): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const row of rows) {
    const id = row.id;
    if (typeof id === "string" && id.endsWith("-pov")) {
      flags[id] = row.enabled === true;
    }
  }
  return flags;
}

let presets: PresetsRepository;

/** The RAW `prompts` column — what actually sits on disk, not the read shape. */
function rawPrompts(id: string): string {
  const row = stmt<{ prompts: string }>(db, "SELECT prompts FROM presets WHERE id = ?").get(id);
  if (!row) {
    throw new Error(`preset ${id} not found`);
  }
  return row.prompts;
}

// `db` is set in `beforeEach`; declaring it after the helpers keeps them
// above their use while still sharing one migrated in-memory database.
let db: ReturnType<typeof createTestDb>;

beforeEach(() => {
  db = createTestDb();
  presets = new PresetsRepository(db);
});

describe("PresetsRepository control normalization", () => {
  it("materializes the resolved default on create", () => {
    const preset = presets.create({ name: "POV", prompts: POV_ROWS, settings: povSettings() });
    // No stored choice → the control's `default` (hybrid) is the effective
    // choice, so the stored rows must already say hybrid on, siblings off.
    expect(povFlags(preset.prompts)).toEqual({
      "1st-person-pov": false,
      "2nd-person-pov": false,
      "3rd-person-pov": false,
      "hybrid-pov": true,
    });
  });

  it("materializes an explicit stored choice on create", () => {
    const preset = presets.create({
      name: "POV",
      prompts: POV_ROWS,
      settings: povSettings({ pov: "first" }),
    });
    expect(povFlags(preset.prompts)).toEqual({
      "1st-person-pov": true,
      "2nd-person-pov": false,
      "3rd-person-pov": false,
      "hybrid-pov": false,
    });
  });

  it("flips the governed rows when only `settings` change (the reported bug)", () => {
    const preset = presets.create({ name: "POV", prompts: POV_ROWS, settings: povSettings() });
    expect(povFlags(preset.prompts)["hybrid-pov"]).toBe(true);

    // The exact user-reported flip: hybrid → first, with no prompts in the
    // patch (the controls route writes settings only).
    const updated = presets.update(preset.id, { settings: povSettings({ pov: "first" }) });
    const expected = {
      "1st-person-pov": true,
      "2nd-person-pov": false,
      "3rd-person-pov": false,
      "hybrid-pov": false,
    };
    expect(povFlags(updated?.prompts ?? [])).toEqual(expected);
    // And it is the STORED row that flipped, not just the read shape.
    expect(povFlags(JSON.parse(rawPrompts(preset.id)) as Array<Record<string, unknown>>)).toEqual(
      expected,
    );
  });

  it("normalizes rows supplied by a prompts-only patch against surviving settings", () => {
    const preset = presets.create({
      name: "POV",
      prompts: POV_ROWS,
      settings: povSettings({ pov: "third" }),
    });
    // An editor save that sends rows but not settings: the field it forgot
    // must not let a stale/hand-flipped row survive.
    const updated = presets.update(preset.id, {
      prompts: [
        { id: "main", marker: "main" },
        { id: "1st-person-pov", enabled: true },
        { id: "2nd-person-pov", enabled: false },
        { id: "3rd-person-pov", enabled: false },
        { id: "hybrid-pov", enabled: false },
      ],
    });
    expect(povFlags(updated?.prompts ?? [])).toEqual({
      "1st-person-pov": false,
      "2nd-person-pov": false,
      "3rd-person-pov": true,
      "hybrid-pov": false,
    });
  });

  it("leaves `prompts` byte-for-byte alone when the preset has no controls", () => {
    const preset = presets.create({
      name: "Plain",
      prompts: [{ id: "main", marker: "main", content: "sys" }],
      settings: { scan_depth: 3 },
    });
    const before = rawPrompts(preset.id);

    // A settings-only write with no controls to resolve, then a rename —
    // neither may touch the `prompts` column.
    presets.update(preset.id, { settings: { scan_depth: 9 } });
    presets.update(preset.id, { name: "Renamed" });
    expect(rawPrompts(preset.id)).toBe(before);
  });

  it("does not churn `prompts` when the flags already match the choice", () => {
    const settings = povSettings({ pov: "hybrid" });
    const preset = presets.create({ name: "POV", prompts: POV_ROWS, settings });
    const before = rawPrompts(preset.id);

    // Same choice as the stored flags → no assignment (the whole column is a
    // JSON write, so an unrelated save must not rewrite it).
    presets.update(preset.id, { settings: { ...settings } });
    expect(rawPrompts(preset.id)).toBe(before);
  });

  it("never throws on a corrupt stored `settings` column", () => {
    const preset = presets.create({ name: "Corrupt", prompts: [{ id: "main", enabled: true }] });
    // Bypass the repository to plant a non-object in the loose settings
    // column — the tolerant readers must treat it as "no controls".
    db.run("UPDATE presets SET settings = ? WHERE id = ?", ['"oops"', preset.id]);

    const updated = presets.update(preset.id, { name: "Still fine" });
    expect(updated?.name).toBe("Still fine");
    expect(updated?.prompts).toEqual([{ id: "main", enabled: true }]);
  });

  it("never throws on a corrupt `prompts` column", () => {
    const preset = presets.create({
      name: "Corrupt rows",
      prompts: POV_ROWS,
      settings: povSettings(),
    });
    // The `prompts` column is loose JSON too: a hand-edited string is left as
    // given rather than mapped over.
    db.run("UPDATE presets SET prompts = ? WHERE id = ?", ['"oops"', preset.id]);

    const updated = presets.update(preset.id, { settings: povSettings({ pov: "first" }) });
    expect(updated?.prompts as unknown).toBe("oops");
  });
});
