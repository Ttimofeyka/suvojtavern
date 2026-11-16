/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
  createRepositories,
  migrations,
  openDatabase,
  type Repositories,
  runMigrations,
} from "@suvoj/core";

let db: Database;
let repos: Repositories;

beforeEach(() => {
  db = openDatabase(":memory:");
  runMigrations(db, migrations);
  repos = createRepositories(db);
});

describe("lorebook entry keyword columns", () => {
  it("patches order and group without tripping SQLite keywords", () => {
    const book = repos.lorebooks.create({ name: "Keywords" });
    const entry = repos.lorebooks.addEntry(book.id, { keys: ["oblivion"], content: "Old text" });

    // Regression: `order` and `group` are SQLite keywords and used to make
    // the UPDATE statement fail with `near "order": syntax error`.
    const updated = repos.lorebooks.updateEntry(entry.id, { order: 5, group: "faction" });
    expect(updated).not.toBeNull();
    expect(updated).toMatchObject({ id: entry.id, order: 5, group: "faction" });
    expect(repos.lorebooks.getEntry(entry.id)).toMatchObject({ order: 5, group: "faction" });
  });

  it("patches keyword columns alongside ordinary columns", () => {
    const book = repos.lorebooks.create({ name: "Mixed" });
    const entry = repos.lorebooks.addEntry(book.id, { keys: ["cult"], content: "before" });

    const updated = repos.lorebooks.updateEntry(entry.id, {
      content: "after",
      depth: 8,
      order: 2,
      group: "cultists",
    });
    expect(updated).toMatchObject({ content: "after", depth: 8, order: 2, group: "cultists" });
  });

  it("returns the current entry when the patch is empty", () => {
    const book = repos.lorebooks.create({ name: "Noop" });
    const entry = repos.lorebooks.addEntry(book.id, { keys: ["x"], content: "y" });
    expect(repos.lorebooks.updateEntry(entry.id, {})).toEqual(entry);
  });
});
