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
import { migrations } from "./index";

/** The migration set as it existed just before 007. */
const preSections: readonly Migration[] = [
  migration001Init,
  migration002Profiles,
  migration003PresetsV2,
  migration004LorebookLinkEnabled,
  migration005Tracker,
  migration006ProfileEndpoints,
];

/** A pre-007 database holding one lorebook with one entry. */
function preSectionsDb(): Database {
  const db = openDatabase(":memory:");
  runMigrations(db, preSections);
  stmt(
    db,
    "INSERT INTO lorebooks (id, name, description, created_at, updated_at) VALUES ('b1', 'World', '', 't', 't')",
  ).run();
  stmt(
    db,
    "INSERT INTO lorebook_entries (id, lorebook_id, content, display_index) VALUES ('e1', 'b1', 'x', 0)",
  ).run();
  return db;
}

describe("migration 007 (lorebook sections)", () => {
  it("creates the sections table and the entry section_id column on a fresh database", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);

    const sectionColumns = stmt<{ name: string }>(db, "PRAGMA table_info(lorebook_sections)")
      .all()
      .map((row) => row.name);
    expect(sectionColumns).toEqual([
      "id",
      "lorebook_id",
      "name",
      "display_index",
      "created_at",
      "updated_at",
    ]);

    const entryColumns = stmt<{ name: string }>(db, "PRAGMA table_info(lorebook_entries)")
      .all()
      .map((row) => row.name);
    expect(entryColumns).toContain("section_id");

    const indexes = stmt<{ name: string }>(db, "PRAGMA index_list(lorebook_sections)")
      .all()
      .map((row) => row.name);
    expect(indexes).toContain("idx_lorebook_sections_book");
    db.close();
  });

  it("records migration 7 in schema_migrations", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const row = stmt<{ id: number; name: string }>(
      db,
      "SELECT id, name FROM schema_migrations WHERE id = 7",
    ).get();
    expect(row).toEqual({ id: 7, name: "lorebook_sections" });
    db.close();
  });

  it("migrates a pre-007 entry to section_id NULL", () => {
    const db = preSectionsDb();
    // Sanity: the old schema has no section_id yet.
    const before = stmt<{ name: string }>(db, "PRAGMA table_info(lorebook_entries)")
      .all()
      .map((row) => row.name);
    expect(before).not.toContain("section_id");

    const applied = runMigrations(db, migrations);
    expect(applied).toContain("lorebook_sections");

    const entry = stmt<{ section_id: string | null; lorebook_id: string }>(
      db,
      "SELECT section_id, lorebook_id FROM lorebook_entries WHERE id = 'e1'",
    ).get();
    expect(entry).toEqual({ section_id: null, lorebook_id: "b1" });
    db.close();
  });
});
