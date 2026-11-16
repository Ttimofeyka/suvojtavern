/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { openDatabase } from "./db/database";
import { runMigrations } from "./db/migrate";
import { migrations } from "./db/migrations";

/** Fresh migrated in-memory database for repository tests. */
export function createTestDb(): Database {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  return db;
}

/** Array access without `noUncheckedIndexedAccess` friction in tests. */
export function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`expected an item at index ${index}`);
  }
  return value;
}
