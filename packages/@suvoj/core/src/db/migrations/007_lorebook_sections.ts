/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Migration } from "../migrate";

/**
 * 007 — lorebook "sections".
 *
 * Sections are a purely organizational concept (collapsible named blocks of
 * entries in the editor) native to Suvoj; they must never affect generation.
 * A section belongs to exactly one lorebook and cascades with it. Entries
 * carry a nullable `section_id`; NULL is the implicit "ungrouped" bucket, so
 * deleting a section (`ON DELETE SET NULL`) preserves its entries as
 * ungrouped rather than deleting them. `display_index` on both tables is a
 * PER-CONTAINER sequence: a container is (lorebook_id, section_id), with
 * `section_id IS NULL` as the ungrouped container.
 *
 * Note the added FK column cannot carry a DEFAULT — SQLite requires an added
 * column with a REFERENCES clause to default to NULL while foreign_keys is on.
 */
export const migration007LorebookSections: Migration = {
  id: 7,
  name: "lorebook_sections",
  up: (db) => {
    db.exec(`
      CREATE TABLE lorebook_sections (
        id TEXT PRIMARY KEY NOT NULL,
        lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        display_index INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_lorebook_sections_book ON lorebook_sections (lorebook_id);
    `);
    db.exec(
      "ALTER TABLE lorebook_entries ADD COLUMN section_id TEXT REFERENCES lorebook_sections(id) ON DELETE SET NULL;",
    );
    db.exec("CREATE INDEX idx_lorebook_entries_section ON lorebook_entries (section_id);");
  },
};
