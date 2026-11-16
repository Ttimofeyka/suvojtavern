/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../test-utils";
import { openDatabase } from "./database";
import { runMigrations } from "./migrate";
import { migrations } from "./migrations";
import { stmt } from "./sql";

describe("database", () => {
  it("applies every migration to a fresh database exactly once", () => {
    const db = createTestDb();
    const applied = stmt<{ id: number; name: string }>(
      db,
      "SELECT id, name FROM schema_migrations ORDER BY id",
    ).all();
    expect(applied).toEqual(migrations.map((m) => ({ id: m.id, name: m.name })));
    expect(runMigrations(db, migrations)).toEqual([]);
    db.close();
  });

  it("creates the expected tables", () => {
    const db = createTestDb();
    const tables = stmt<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual([
      "character_images",
      "character_lorebooks",
      "characters",
      "chats",
      "connection_profiles",
      "lorebook_entries",
      "lorebook_sections",
      "lorebooks",
      "messages",
      "personas",
      "presets",
      "schema_migrations",
      "settings",
      "summaries",
      "tracker_snapshots",
      "variables",
    ]);
    db.close();
  });

  it("enforces foreign keys", () => {
    const db = createTestDb();
    expect(() =>
      stmt(
        db,
        "INSERT INTO chats (id, character_id, title, created_at, updated_at) VALUES ('c', 'missing', NULL, 't', 't')",
      ).run(),
    ).toThrow();
    db.close();
  });

  it("opens a WAL database file, creating parent directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "suvoj-db-"));
    try {
      const path = join(dir, "nested", "data", "test.db");
      const db = openDatabase(path);
      expect(existsSync(path)).toBe(true);
      expect(stmt<{ journal_mode: string }>(db, "PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      expect(stmt<{ foreign_keys: number }>(db, "PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
      runMigrations(db, migrations);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
