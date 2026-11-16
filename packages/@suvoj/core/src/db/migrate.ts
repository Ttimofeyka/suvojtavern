/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { nowIso } from "../util";
import { stmt } from "./sql";

/** A single sequential schema migration. */
export interface Migration {
  id: number;
  name: string;
  up: (db: Database) => void;
}

/**
 * Tiny sequential migration runner (PLAN.md §2.1 — no external tooling).
 *
 * - creates the `schema_migrations` bookkeeping table if missing;
 * - applies pending migrations in ascending id order, each inside its own
 *   transaction together with its bookkeeping row;
 * - idempotent: already-applied migrations are skipped.
 *
 * @returns the names of the migrations applied by this call.
 */
export function runMigrations(db: Database, migrations: readonly Migration[]): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    stmt<{ id: number }>(db, "SELECT id FROM schema_migrations")
      .all()
      .map((row) => row.id),
  );
  const appliedNow: string[] = [];
  for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
    if (applied.has(migration.id)) {
      continue;
    }
    db.transaction(() => {
      migration.up(db);
      stmt(db, "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migration.name,
        nowIso(),
      );
    })();
    appliedNow.push(migration.name);
  }
  return appliedNow;
}
