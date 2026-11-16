/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  createRepositories,
  engine,
  migrations,
  openDatabase,
  runMigrations,
  tracker,
} from "@suvoj/core";
import {
  BUILTIN_PRESET_CONTROLS,
  BUILTIN_PROMPT_GROUPS,
  migrateTrackerDefaults,
  seedBuiltInPreset,
  seedDefaultRegexRules,
  TRACKER_DEFAULTS_VERSION,
  TRACKER_DEFAULTS_VERSION_KEY,
} from "./seed";

/** Fresh migrated in-memory database. */
function seededDb(): Database {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  return db;
}

describe("seedBuiltInPreset", () => {
  it("creates the built-in preset (name, description, slugged prompts)", () => {
    const db = seededDb();
    expect(seedBuiltInPreset(db)).toBe("created");
    const rows = createRepositories(db).presets.list();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      name: "Suvoj Default",
      description:
        "Built-in roleplay base: lean core rules with a Point of View switcher and grouped prose, NSFW, and reasoning toggles.",
    });
    if (!row) {
      throw new Error("expected the seeded preset row");
    }
    const preset = engine.fromStoredPreset(row);
    // The array follows the ST prompt_order; ids are readable slugs.
    expect(preset.prompts[0]?.id).toBe("main");
    expect(preset.prompts.some((prompt) => prompt.id === "enhance-definitions")).toBe(true);
    expect(promptIdsAreSlugs(preset)).toBe(true);
    db.close();
  });

  it("is version-gated: created once, then kept on every re-run", () => {
    const db = seededDb();
    const repos = createRepositories(db);
    expect(seedBuiltInPreset(db)).toBe("created");
    expect(seedBuiltInPreset(db)).toBe("kept");
    expect(seedBuiltInPreset(db)).toBe("kept");
    expect(repos.presets.list()).toHaveLength(1);
    db.close();
  });

  it("preserves user edits while the version is unchanged", () => {
    const db = seededDb();
    const repos = createRepositories(db);
    expect(seedBuiltInPreset(db)).toBe("created");
    const row = repos.presets.list()[0];
    if (!row) {
      throw new Error("expected the seeded preset row");
    }
    // Simulate a user edit of the built-in preset at the current version.
    repos.presets.update(row.id, {
      description: "my tweaks",
      prompts: [{ id: "main", name: "Main prompt", marker: "main", content: "CUSTOM" }],
    });

    expect(seedBuiltInPreset(db)).toBe("kept");
    expect(repos.presets.list()).toHaveLength(1);
    expect(repos.presets.get(row.id)?.description).toBe("my tweaks");
    db.close();
  });

  it("replaces prompts and settings on a version bump, keeping the row id", () => {
    const db = seededDb();
    const repos = createRepositories(db);
    expect(seedBuiltInPreset(db)).toBe("created");
    const row = repos.presets.list()[0];
    if (!row) {
      throw new Error("expected the seeded preset row");
    }
    repos.presets.update(row.id, {
      description: "my tweaks",
      prompts: [{ id: "main", name: "Main prompt", marker: "main", content: "CUSTOM" }],
      settings: { scan_depth: 42 },
    });

    // A forced bump stands in for shipping a new START_PRESET.json: the row
    // is rewritten in place (same id) with the shipped content.
    expect(seedBuiltInPreset(db, 999)).toBe("updated");
    expect(repos.presets.list()).toHaveLength(1);
    const replaced = repos.presets.get(row.id);
    if (!replaced) {
      throw new Error("expected the built-in preset to survive the version bump");
    }
    expect(replaced.description).not.toBe("my tweaks");
    const preset = engine.fromStoredPreset(replaced);
    expect(preset.prompts.length).toBeGreaterThan(10);
    expect(preset.settings.scan_depth).not.toBe(42);

    // The bump is now the stored version: the next run is a no-op.
    expect(seedBuiltInPreset(db, 999)).toBe("kept");
    db.close();
  });

  it("stamps the built-in groups onto the shipped preset", () => {
    const db = seededDb();
    expect(seedBuiltInPreset(db)).toBe("created");
    const row = createRepositories(db).presets.list()[0];
    if (!row) {
      throw new Error("expected the seeded preset row");
    }
    const preset = engine.fromStoredPreset(row);

    // Every mapped id exists post-conversion and carries its group.
    const byId = new Map(preset.prompts.map((prompt) => [prompt.id, prompt]));
    for (const [id, group] of Object.entries(BUILTIN_PROMPT_GROUPS)) {
      const prompt = byId.get(id);
      expect(prompt, `expected prompt "${id}" from the seeded preset`).toBeDefined();
      expect(prompt?.group).toEqual(group);
    }

    // The POV rows are NOT grouped — the Point of View control owns them.
    const pov = preset.prompts.filter((prompt) =>
      ["1st-person-pov", "2nd-person-pov", "3rd-person-pov", "hybrid-pov"].includes(prompt.id),
    );
    expect(pov).toHaveLength(4);
    expect(pov.every((prompt) => prompt.group === undefined)).toBe(true);

    // Every group ships exactly one enabled member.
    for (const groupId of new Set(Object.values(BUILTIN_PROMPT_GROUPS).map((g) => g.id))) {
      const members = preset.prompts.filter((prompt) => prompt.group?.id === groupId);
      expect(members.length, `group "${groupId}"`).toBeGreaterThan(1);
      expect(members.filter((prompt) => prompt.enabled).length, `group "${groupId}"`).toBe(1);
    }

    // Unmapped prompts stay group-less.
    expect(byId.get("main")?.group).toBeUndefined();
    db.close();
  });

  it("declares the Point of View control, Hybrid by default", () => {
    const db = seededDb();
    expect(seedBuiltInPreset(db)).toBe("created");
    const row = createRepositories(db).presets.list()[0];
    if (!row) {
      throw new Error("expected the seeded preset row");
    }
    const preset = engine.fromStoredPreset(row);

    // The declarations survive storage verbatim and resolve to Hybrid.
    expect(engine.settingsControls(preset.settings)).toEqual(BUILTIN_PRESET_CONTROLS);
    const choices = engine.settingsChoices(preset.settings);
    expect(choices).toEqual({ pov: "hybrid" });

    // Every option id is a valid control id, and its prompt id is real.
    const pov = BUILTIN_PRESET_CONTROLS.find((control) => control.id === "pov");
    if (!pov) {
      throw new Error("expected the built-in Point of View control");
    }
    const byId = new Set(preset.prompts.map((prompt) => prompt.id));
    expect(pov.options.map((option) => option.id)).toEqual(["first", "second", "third", "hybrid"]);
    for (const option of pov.options) {
      expect(engine.CONTROL_ID_PATTERN.test(option.id), `option id "${option.id}"`).toBe(true);
      for (const promptId of option.prompts) {
        expect(byId.has(promptId), `option "${option.id}" names prompt "${promptId}"`).toBe(true);
      }
    }

    // Applying the control to the shipped rows leaves exactly one POV row on:
    // Hybrid, matching the `prompt_order` the ST file ships.
    const controlled = engine.applyChoices(preset.prompts, [pov], choices);
    const enabledPov = controlled
      .filter((prompt) => prompt.id.endsWith("-pov") && prompt.enabled)
      .map((prompt) => prompt.id);
    expect(enabledPov).toEqual(["hybrid-pov"]);
    db.close();
  });

  it("prunes the dropped rows and ships the Micro NPC-voice block on the survivor", () => {
    const db = seededDb();
    expect(seedBuiltInPreset(db)).toBe("created");
    const row = createRepositories(db).presets.list()[0];
    if (!row) {
      throw new Error("expected the seeded preset row");
    }
    const preset = engine.fromStoredPreset(row);
    const byId = new Map(preset.prompts.map((prompt) => [prompt.id, prompt]));

    for (const dropped of [
      "time-and-place",
      "icebreaker-test",
      "npc-voice-dialogue-output-large",
    ]) {
      expect(byId.has(dropped), `expected "${dropped}" to be gone`).toBe(false);
    }

    // The surviving row keeps its id and name but carries the compact Micro
    // content — NOT the Large block, whose interjection examples ("Ngh",
    // "Khh", ...) the model parroted into needless "ngh", "ugh" spam.
    const survivor = byId.get("npc-voice-dialogue-output");
    expect(survivor?.name).toBe("🎤NPC Voice + Dialogue Output🗣️");
    const content = survivor?.content ?? "";
    expect(content).toContain("This is the small Micro version");
    expect(content).toContain("unnhhh, mmmm, yes");
    expect(content.endsWith("</npc_voice>")).toBe(true);
    // The Large block's interjection solicitations are gone: the model must
    // not be told to emit "Ngh", "Khh", "Grah", or stutter on overwhelm.
    for (const solicitation of ["Ngh", "Khh", "Grah", "stuttered for overwhelm"]) {
      expect(content, `Large solicitation "${solicitation}"`).not.toContain(solicitation);
    }
    db.close();
  });

  it("moves the CoT after chatHistory and ships identity + knowledge", () => {
    const db = seededDb();
    expect(seedBuiltInPreset(db)).toBe("created");
    const row = createRepositories(db).presets.list()[0];
    if (!row) {
      throw new Error("expected the seeded preset row");
    }
    const preset = engine.fromStoredPreset(row);
    const index = (id: string): number => preset.prompts.findIndex((prompt) => prompt.id === id);

    // The reasoning checklist is a regular post-history prompt now: it renders
    // after the tracker's dynamic tail, not as a depth-0 user injection.
    expect(index("chatHistory")).toBeLessThan(index("bolt-chain-of-thought"));
    expect(index("bolt-chain-of-thought")).toBeLessThan(index("jailbreak"));
    expect(
      preset.prompts.find((prompt) => prompt.id === "bolt-chain-of-thought")?.injection_position,
    ).toBe(0);
    expect(
      preset.prompts.find((prompt) => prompt.id === "micro-chain-of-thought")?.injection_position,
    ).toBe(0);

    // The two state-facing instruction rows ship enabled.
    expect(preset.prompts.find((prompt) => prompt.id === "identity")).toMatchObject({
      enabled: true,
      role: "system",
    });
    expect(preset.prompts.find((prompt) => prompt.id === "identity")?.content).toContain(
      "<identity>",
    );
    expect(preset.prompts.find((prompt) => prompt.id === "knowledge-rule")).toMatchObject({
      enabled: true,
      role: "system",
    });
    expect(preset.prompts.find((prompt) => prompt.id === "knowledge-rule")?.content).toContain(
      "<knowledge_rule>",
    );

    // The shipped preset scans four messages deep for lorebook keys.
    expect(preset.settings.scan_depth).toBe(4);
    db.close();
  });

  it("applies groups and controls to an existing row on a version bump", () => {
    const db = seededDb();
    const repos = createRepositories(db);
    expect(seedBuiltInPreset(db)).toBe("created");
    const row = repos.presets.list()[0];
    if (!row) {
      throw new Error("expected the seeded preset row");
    }
    // Simulate a row seeded before groups/controls existed: same prompts, no
    // group metadata and no control declarations.
    repos.presets.update(row.id, {
      prompts: [{ id: "main", name: "Main prompt", marker: "main", content: "CUSTOM" }],
      settings: {},
    });

    expect(seedBuiltInPreset(db, 999)).toBe("updated");
    const replaced = repos.presets.get(row.id);
    if (!replaced) {
      throw new Error("expected the built-in preset to survive the version bump");
    }
    const preset = engine.fromStoredPreset(replaced);
    expect(preset.prompts.find((prompt) => prompt.id === "cinematic-realism")?.group?.id).toBe(
      "prose-style",
    );
    expect(engine.settingsChoices(preset.settings)).toEqual({ pov: "hybrid" });
    db.close();
  });
});

describe("migrateTrackerDefaults", () => {
  it("seeds the version without writing a config when none is stored", () => {
    const db = seededDb();
    const repos = createRepositories(db);
    expect(migrateTrackerDefaults(db)).toBe("seeded");
    expect(repos.settings.get(TRACKER_DEFAULTS_VERSION_KEY)).toBe(TRACKER_DEFAULTS_VERSION);
    expect(repos.settings.get(tracker.TRACKER_CONFIG_KEY)).toBeNull();
    // Idempotent from here on.
    expect(migrateTrackerDefaults(db)).toBe("kept");
    db.close();
  });

  it("forces the built-in surface while preserving user choices and custom presets", () => {
    const db = seededDb();
    const repos = createRepositories(db);
    repos.settings.set(tracker.TRACKER_CONFIG_KEY, {
      enabled: true,
      mechanism: "custom-mechanism",
      auto_mode: "manual",
      profile_id: "profile-1",
      system_prompt: "MY CUSTOM PROMPT",
      include_last_messages: 12,
      include_last_trackers: 1,
      keep_last: 5,
      max_response_tokens: 4096,
      invisible: true,
      injection: { include_last: 3, role: "user", format: "json", header: "State:" },
      schema_presets: {
        mine: {
          name: "Mine",
          schema: { type: "object" },
          html: "<p>mine</p>",
          css: "",
          parts: { count: 1, fields: {} },
        },
        default: {
          name: "Old default",
          schema: { type: "object" },
          html: "<p>old</p>",
          css: "",
          parts: { count: 2, fields: { a: 2 } },
        },
      },
      active_schema_key: "mine",
    });

    expect(migrateTrackerDefaults(db)).toBe("updated");
    const stored = repos.settings.get<Record<string, unknown>>(tracker.TRACKER_CONFIG_KEY);
    if (!stored) {
      throw new Error("expected the migrated config");
    }
    expect(stored).toMatchObject({
      enabled: true,
      mechanism: "custom-mechanism",
      auto_mode: "manual",
      profile_id: "profile-1",
      system_prompt: tracker.DEFAULT_TRACKER_SYSTEM_PROMPT,
      include_last_messages: 12,
      include_last_trackers: 2,
      keep_last: 5,
      max_response_tokens: 4096,
      invisible: true,
      active_schema_key: "mine",
    });
    expect(stored.injection).toEqual({
      include_last: 3,
      role: "system",
      format: "json",
      header: "State:",
    });
    const presets = stored.schema_presets as Record<string, Record<string, unknown>>;
    expect(presets.mine).toMatchObject({ name: "Mine", schema: { type: "object" } });
    expect(presets.default).toMatchObject({
      name: "Default",
      schema: tracker.DEFAULT_TRACKER_SCHEMA,
      html: tracker.DEFAULT_TRACKER_HTML,
      css: tracker.DEFAULT_TRACKER_CSS,
      parts: { count: 1, fields: {} },
    });
    expect(repos.settings.get(TRACKER_DEFAULTS_VERSION_KEY)).toBe(TRACKER_DEFAULTS_VERSION);
    // A second run is a no-op.
    expect(migrateTrackerDefaults(db)).toBe("kept");
    db.close();
  });

  it("recovers a corrupt config with the shipped defaults", () => {
    const db = seededDb();
    const repos = createRepositories(db);
    repos.settings.set(tracker.TRACKER_CONFIG_KEY, "garbage");
    expect(migrateTrackerDefaults(db)).toBe("updated");
    const stored = repos.settings.get<Record<string, unknown>>(tracker.TRACKER_CONFIG_KEY);
    expect(stored?.system_prompt).toBe(tracker.DEFAULT_TRACKER_SYSTEM_PROMPT);
    expect(stored?.include_last_trackers).toBe(2);
    expect(stored?.injection).toMatchObject({ role: "system" });
    db.close();
  });
});

/** Every non-marker id is a lowercase slug — never a UUID-like string. */
function promptIdsAreSlugs(preset: { prompts: Array<{ id: string; marker?: string }> }): boolean {
  return preset.prompts
    .filter((prompt) => prompt.marker === undefined)
    .every((prompt) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(prompt.id));
}

describe("seedDefaultRegexRules", () => {
  it("creates the built-in rule set when nothing is stored", () => {
    const db = seededDb();
    expect(seedDefaultRegexRules(db)).toBe("created");
    expect(engine.getRegexRules(createRepositories(db))).toEqual(engine.defaultRegexRules());
    db.close();
  });

  it("skips when the stored value already is an array — even an empty one", () => {
    const db = seededDb();
    const repos = createRepositories(db);
    // The user deleted every rule: "no rules" must stay a deliberate choice.
    repos.settings.set(engine.REGEX_RULES_KEY, []);
    expect(seedDefaultRegexRules(db)).toBe("skipped");
    expect(engine.getRegexRules(repos)).toEqual([]);

    // A non-empty user list is likewise never touched.
    const custom: engine.RegexRule[] = [
      {
        id: "mine",
        name: "Mine",
        find: "/a/g",
        replace: "b",
        placement: ["ai"],
        enabled: true,
      },
    ];
    repos.settings.set(engine.REGEX_RULES_KEY, custom);
    expect(seedDefaultRegexRules(db)).toBe("skipped");
    expect(engine.getRegexRules(repos)).toEqual([...custom]);
    db.close();
  });

  it("replaces a corrupt non-array value with the built-in rule", () => {
    // "Corrupt" = anything that is not a JSON array: a stale object, a
    // primitive, or malformed text (the settings reader maps the last to
    // null). Per the seed contract a corrupt store is RECOVERED — the user
    // never loses the built-in rule to a broken value — while a real array
    // (above) is always respected.
    for (const corrupt of [{ stale: true }, 42, "not an array"]) {
      const db = seededDb();
      const repos = createRepositories(db);
      repos.settings.set(engine.REGEX_RULES_KEY, corrupt);
      expect(seedDefaultRegexRules(db)).toBe("created");
      expect(engine.getRegexRules(repos)).toEqual(engine.defaultRegexRules());
      db.close();
    }
  });

  it("is idempotent across repeated runs", () => {
    const db = seededDb();
    expect(seedDefaultRegexRules(db)).toBe("created");
    expect(seedDefaultRegexRules(db)).toBe("skipped");
    expect(engine.getRegexRules(createRepositories(db))).toHaveLength(1);
    db.close();
  });
});
