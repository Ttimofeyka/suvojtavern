/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Default on-disk location, resolved from the process working directory. */
export const DEFAULT_DB_PATH = "data/suvoj.db";

/**
 * Opens the single SQLite store with the pragmas the app relies on:
 * WAL (cheap commits, concurrent readers), enforced foreign keys, and a
 * busy timeout so brief lock contention does not surface as errors.
 *
 * @param path database file path, `:memory:`, or `undefined` for
 *   {@link DEFAULT_DB_PATH}. Parent directories are created as needed.
 */
export function openDatabase(path?: string): Database {
  const target = path ?? DEFAULT_DB_PATH;
  const resolved = target === ":memory:" ? target : resolve(target);
  if (resolved !== ":memory:") {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  const db = new Database(resolved, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
