/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { DEFAULT_TRACKER_CSS, DEFAULT_TRACKER_HTML } from "../../tracker/defaults";
import { openDatabase } from "../database";
import type { Migration } from "../migrate";
import { runMigrations } from "../migrate";
import { stmt } from "../sql";
import { migration001Init } from "./001_init";
import { migration002Profiles } from "./002_profiles";
import { migration003PresetsV2 } from "./003_presets_v2";
import { migration004LorebookLinkEnabled } from "./004_lorebook_link_enabled";
import { migration005Tracker } from "./005_tracker";
import { migration006ProfileEndpoints } from "./006_profile_endpoints";
import { migration007LorebookSections } from "./007_lorebook_sections";
import { migration008CharactersNameIndex } from "./008_characters_name_index";
import { migration009TrackerMessageIndex } from "./009_tracker_message_index";
import { migration010RenameZtrackerMechanism } from "./010_rename_ztracker_mechanism";
import { migration011ChatTrackerEnabled } from "./011_chat_tracker_enabled";
import { migration012DropAuth } from "./012_drop_auth";
import {
  LEGACY_DEFAULT_TRACKER_CSS,
  migration013ThemeAwareTrackerPresetCss,
} from "./013_theme_aware_tracker_preset_css";
import { migrations } from "./index";

/** The migration set as it existed just before 013. */
const preThirteen: readonly Migration[] = [
  migration001Init,
  migration002Profiles,
  migration003PresetsV2,
  migration004LorebookLinkEnabled,
  migration005Tracker,
  migration006ProfileEndpoints,
  migration007LorebookSections,
  migration008CharactersNameIndex,
  migration009TrackerMessageIndex,
  migration010RenameZtrackerMechanism,
  migration011ChatTrackerEnabled,
  migration012DropAuth,
];

/** One preset of the fixture config, as the settings JSON stores it. */
interface FixturePreset {
  name: string;
  schema: Record<string, unknown>;
  html: string;
  css: string;
  parts: { count: number; fields: Record<string, number> };
}

/** The fixture `tracker_config` value, typed so the assertions can index it. */
interface FixtureConfig {
  enabled: boolean;
  mechanism: string;
  active_schema_key: string;
  system_prompt: string;
  schema_presets: Record<string, FixturePreset>;
}

/** Writes a raw `settings` row (the repository stores JSON-serialized values). */
function setSetting(db: Database, key: string, value: string): void {
  stmt(db, "INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

/** The raw `settings.value` for a key, or null when unset. */
function settingValue(db: Database, key: string): string | null {
  return (
    stmt<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null
  );
}

/** A `tracker_config` row whose `default` preset still carries the old literals. */
function legacyConfig(): FixtureConfig {
  return {
    enabled: true,
    mechanism: "suvoj-tracker",
    active_schema_key: "default",
    system_prompt: "track the scene",
    schema_presets: {
      default: {
        name: "Default",
        schema: { type: "object" },
        html: DEFAULT_TRACKER_HTML,
        css: LEGACY_DEFAULT_TRACKER_CSS,
        parts: { count: 1, fields: {} },
      },
      mine: {
        name: "Mine",
        schema: {},
        html: "<p></p>",
        css: ".a{}",
        parts: { count: 1, fields: {} },
      },
    },
  };
}

/** One fixture preset by key (the fixture always defines it). */
function presetOf(config: FixtureConfig, key: string): FixturePreset {
  const preset = config.schema_presets[key];
  if (preset === undefined) {
    throw new Error(`fixture is missing the "${key}" preset`);
  }
  return preset;
}

/** The stored `tracker_config`, parsed back. */
function storedConfig(db: Database): FixtureConfig {
  return JSON.parse(settingValue(db, "tracker_config") as string) as FixtureConfig;
}

describe("migration 013 (theme-aware tracker preset css)", () => {
  it("records migration 13 in schema_migrations", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const row = stmt<{ id: number; name: string }>(
      db,
      "SELECT id, name FROM schema_migrations WHERE id = 13",
    ).get();
    expect(row).toEqual({ id: 13, name: "theme_aware_tracker_preset_css" });
    db.close();
  });

  it("upgrades a legacy default preset to the shipped theme-aware stylesheet", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, preThirteen);
    setSetting(db, "tracker_config", JSON.stringify(legacyConfig()));

    const applied = runMigrations(db, migrations);
    expect(applied).toEqual(["theme_aware_tracker_preset_css"]);

    const css = storedConfig(db).schema_presets.default?.css ?? "";
    expect(css).toBe(DEFAULT_TRACKER_CSS);
    expect(css).toContain("var(--tf-card-bg");
    db.close();
  });

  it("preserves every other field of the config and its sibling presets", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, preThirteen);
    const before = legacyConfig();
    setSetting(db, "tracker_config", JSON.stringify(before));
    runMigrations(db, migrations);

    const stored = storedConfig(db);
    expect(stored.enabled).toBe(true);
    expect(stored.mechanism).toBe("suvoj-tracker");
    expect(stored.active_schema_key).toBe("default");
    expect(stored.system_prompt).toBe("track the scene");
    expect(stored.schema_presets.mine).toEqual(presetOf(before, "mine"));
    expect(stored.schema_presets.default?.name).toBe("Default");
    expect(stored.schema_presets.default?.html).toBe(DEFAULT_TRACKER_HTML);
    expect(stored.schema_presets.default?.parts).toEqual({ count: 1, fields: {} });
    db.close();
  });

  it("leaves a hand-edited default preset alone", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, preThirteen);
    const config = legacyConfig();
    presetOf(config, "default").css =
      `${LEGACY_DEFAULT_TRACKER_CSS}\n.tracker-card { color: hotpink; }`;
    const raw = JSON.stringify(config);
    setSetting(db, "tracker_config", raw);

    runMigrations(db, migrations);

    expect(settingValue(db, "tracker_config")).toBe(raw);
    db.close();
  });

  it("leaves an already theme-aware default preset alone", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, preThirteen);
    const config = legacyConfig();
    presetOf(config, "default").css = DEFAULT_TRACKER_CSS;
    const raw = JSON.stringify(config);
    setSetting(db, "tracker_config", raw);

    runMigrations(db, migrations);

    expect(settingValue(db, "tracker_config")).toBe(raw);
    db.close();
  });

  it("leaves the legacy stylesheet on a non-default preset alone", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, preThirteen);
    const config = legacyConfig();
    presetOf(config, "default").css = DEFAULT_TRACKER_CSS;
    presetOf(config, "mine").css = LEGACY_DEFAULT_TRACKER_CSS;
    const raw = JSON.stringify(config);
    setSetting(db, "tracker_config", raw);

    runMigrations(db, migrations);

    expect(settingValue(db, "tracker_config")).toBe(raw);
    db.close();
  });

  it("does not throw on a corrupt tracker_config row and leaves it untouched", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, preThirteen);
    setSetting(db, "tracker_config", "not json {");

    expect(() => runMigrations(db, migrations)).not.toThrow();

    expect(settingValue(db, "tracker_config")).toBe("not json {");
    db.close();
  });

  it("does nothing when there is no tracker_config row", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, preThirteen);

    expect(() => runMigrations(db, migrations)).not.toThrow();

    expect(settingValue(db, "tracker_config")).toBeNull();
    db.close();
  });

  it("is idempotent: re-running 013 does not reapply", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, preThirteen);
    setSetting(db, "tracker_config", JSON.stringify(legacyConfig()));

    expect(runMigrations(db, [migration013ThemeAwareTrackerPresetCss])).toEqual([
      "theme_aware_tracker_preset_css",
    ]);
    expect(runMigrations(db, [migration013ThemeAwareTrackerPresetCss])).toEqual([]);
    expect(storedConfig(db).schema_presets.default?.css).toBe(DEFAULT_TRACKER_CSS);
    db.close();
  });
});
