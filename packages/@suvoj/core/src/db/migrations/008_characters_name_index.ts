/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Migration } from "../migrate";

/**
 * 008 — index on `characters.name`.
 *
 * The character list orders by `name COLLATE NOCASE`; without an index that
 * forces a full scan plus a sort of every row once the library reaches
 * thousands of cards. The index uses the same NOCASE collation as the ORDER
 * BY, so SQLite can serve the ordering from it directly (confirmed via
 * EXPLAIN QUERY PLAN: `SCAN characters USING INDEX idx_characters_name`).
 *
 * The `name LIKE ? COLLATE NOCASE` search does NOT get a range scan from this
 * index: the pattern is a leading-wildcard `%x%`, which cannot be bounded on
 * either end. The index is still chosen for those queries — it is the cheapest
 * way to satisfy the ORDER BY — but the LIKE itself remains a filter. (The
 * index also stays useful alongside the tag filter, which is a separate
 * `json_each` EXISTS subquery.)
 */
export const migration008CharactersNameIndex: Migration = {
  id: 8,
  name: "characters_name_index",
  up: (db) => {
    db.exec("CREATE INDEX idx_characters_name ON characters (name COLLATE NOCASE);");
  },
};
