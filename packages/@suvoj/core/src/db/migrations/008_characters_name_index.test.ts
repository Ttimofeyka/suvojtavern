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
import { migrations } from "./index";

/** The migration set as it existed just before 008. */
const preNameIndex: readonly Migration[] = [
  migration001Init,
  migration002Profiles,
  migration003PresetsV2,
  migration004LorebookLinkEnabled,
  migration005Tracker,
  migration006ProfileEndpoints,
  migration007LorebookSections,
];

/** Index names on `characters` (the auto PRIMARY KEY index included). */
function characterIndexes(db: Database): string[] {
  return stmt<{ name: string }>(db, "PRAGMA index_list(characters)")
    .all()
    .map((row) => row.name);
}

describe("migration 008 (characters name index)", () => {
  it("creates idx_characters_name on a fresh database", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    expect(characterIndexes(db)).toContain("idx_characters_name");
    db.close();
  });

  it("records migration 8 in schema_migrations", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const row = stmt<{ id: number; name: string }>(
      db,
      "SELECT id, name FROM schema_migrations WHERE id = 8",
    ).get();
    expect(row).toEqual({ id: 8, name: "characters_name_index" });
    db.close();
  });

  it("adds the index to a pre-008 database and the list query can use it", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, preNameIndex);
    expect(characterIndexes(db)).not.toContain("idx_characters_name");

    const applied = runMigrations(db, migrations);
    expect(applied).toContain("characters_name_index");
    expect(characterIndexes(db)).toContain("idx_characters_name");

    // The list's ORDER BY must be satisfiable by the index (no temp sort-free
    // scan assertion is possible here, but the plan should mention the index).
    const plan = stmt<{ detail: string }>(
      db,
      "EXPLAIN QUERY PLAN SELECT id, name FROM characters ORDER BY name COLLATE NOCASE",
    )
      .all()
      .map((row) => row.detail)
      .join(" ");
    expect(plan).toContain("idx_characters_name");
    db.close();
  });
});
