/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
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
import { migrations } from "./index";

/** The migration set as it existed just before 010. */
const preRename: readonly Migration[] = [
  migration001Init,
  migration002Profiles,
  migration003PresetsV2,
  migration004LorebookLinkEnabled,
  migration005Tracker,
  migration006ProfileEndpoints,
  migration007LorebookSections,
  migration008CharactersNameIndex,
  migration009TrackerMessageIndex,
];

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

describe("migration 010 (rename ztracker mechanism)", () => {
  it("records migration 10 in schema_migrations", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const row = stmt<{ id: number; name: string }>(
      db,
      "SELECT id, name FROM schema_migrations WHERE id = 10",
    ).get();
    expect(row).toEqual({ id: 10, name: "rename_ztracker_mechanism" });
    db.close();
  });

  it("rewrites a legacy tracker_config mechanism id", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, preRename);
    setSetting(db, "tracker_config", JSON.stringify({ enabled: true, mechanism: "ztracker" }));

    const applied = runMigrations(db, migrations);
    expect(applied).toEqual([
      "rename_ztracker_mechanism",
      "chat_tracker_enabled",
      "drop_auth",
      "theme_aware_tracker_preset_css",
    ]);

    const stored = settingValue(db, "tracker_config");
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string)).toEqual({ enabled: true, mechanism: "suvoj-tracker" });
    db.close();
  });

  it("leaves a non-legacy tracker_config untouched", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, preRename);
    const current = JSON.stringify({ enabled: false, mechanism: "suvoj-tracker" });
    setSetting(db, "tracker_config", current);

    runMigrations(db, migrations);

    expect(settingValue(db, "tracker_config")).toBe(current);
    db.close();
  });

  it("leaves other settings rows untouched", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, preRename);
    const other = JSON.stringify({ mechanism: "ztracker" });
    setSetting(db, "some_other_config", other);

    runMigrations(db, migrations);

    expect(settingValue(db, "some_other_config")).toBe(other);
    db.close();
  });

  it("does not throw on a corrupt tracker_config row and leaves it untouched", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, preRename);
    setSetting(db, "tracker_config", "not json {");

    expect(() => runMigrations(db, migrations)).not.toThrow();

    expect(settingValue(db, "tracker_config")).toBe("not json {");
    db.close();
  });

  it("is idempotent: re-running 010 does not reapply", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, preRename);
    setSetting(db, "tracker_config", JSON.stringify({ mechanism: "ztracker" }));

    expect(runMigrations(db, [migration010RenameZtrackerMechanism])).toEqual([
      "rename_ztracker_mechanism",
    ]);
    expect(runMigrations(db, [migration010RenameZtrackerMechanism])).toEqual([]);
    expect(JSON.parse(settingValue(db, "tracker_config") as string)).toEqual({
      mechanism: "suvoj-tracker",
    });
    db.close();
  });
});
