/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";

/** The `col = ?` fragment of an UPDATE statement. */
export interface SqlAssignment {
  assignments: string;
  params: SQLQueryBindings[];
}

/**
 * Typed access to bun:sqlite's cached prepared statements. `db.query` needs
 * both type arguments spelled out, so repositories go through this helper.
 */
export function stmt<Row>(db: Database, sql: string): Statement<Row> {
  return db.query<Row, SQLQueryBindings[]>(sql);
}

/**
 * Builds a `col = ?, ...` list from (column, value) pairs for UPDATE
 * statements. `undefined` means "field not patched" and is skipped; `null`
 * clears the column; booleans are bound as 0/1.
 */
export function assignSql(pairs: ReadonlyArray<readonly [string, unknown]>): SqlAssignment | null {
  const applicable = pairs.filter(([, value]) => value !== undefined);
  if (applicable.length === 0) {
    return null;
  }
  return {
    assignments: applicable.map(([column]) => `"${column}" = ?`).join(", "),
    params: applicable.map(([, value]) => toBinding(value)),
  };
}

function toBinding(value: unknown): SQLQueryBindings {
  if (value === true) {
    return 1;
  }
  if (value === false) {
    return 0;
  }
  return value as SQLQueryBindings;
}
