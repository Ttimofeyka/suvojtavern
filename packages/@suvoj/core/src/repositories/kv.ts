/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { stmt } from "../db/sql";
import type { VariableScope } from "../schema/kv";
import { jsonOrNull, parseJson } from "../util";

/**
 * Key/value JSON store for app settings (theme, layout, provider defaults).
 * Values are (de)serialized at the repository boundary.
 */
export class SettingsRepository {
  constructor(private readonly db: Database) {}

  /** Untyped read: the stored JSON value, or `null` when the key is unset. */
  get(key: string): unknown;
  /** Typed read (e.g. `get<{ mode: string }>("theme")`). */
  get<T>(key: string): T | null;
  get<T>(key: string): T | null {
    const row = stmt<{ value: string }>(this.db, "SELECT value FROM settings WHERE key = ?").get(
      key,
    );
    return row ? parseJson<T>(row.value) : null;
  }

  set(key: string, value: unknown): void {
    stmt(
      this.db,
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, jsonOrNull(value));
  }

  delete(key: string): boolean {
    return stmt(this.db, "DELETE FROM settings WHERE key = ?").run(key).changes > 0;
  }
}

/**
 * Scoped variable store — the same store macros (`{{setvar}}`/`{{getvar}}`)
 * and future modules (the tracker) read and write.
 *
 * - `global` is a single namespace (`scopeId` is ignored, stored as NULL);
 * - `chat` is keyed by chat id and *requires* it.
 *
 * Rows are upserted manually: the composite PK contains a nullable `scope_id`,
 * and SQL unique indexes treat NULLs as distinct, so `ON CONFLICT` cannot be
 * relied on for the global scope.
 */
export class VariablesRepository {
  constructor(private readonly db: Database) {}

  /** Untyped read: the stored JSON value, or `null` when the key is unset. */
  get(scope: VariableScope, scopeId: string | null, key: string): unknown;
  /** Typed read (e.g. `get<string>("chat", chatId, "mood")`). */
  get<T>(scope: VariableScope, scopeId: string | null, key: string): T | null;
  get<T>(scope: VariableScope, scopeId: string | null, key: string): T | null {
    const row = stmt<{ value: string }>(
      this.db,
      "SELECT value FROM variables WHERE scope = ? AND scope_id IS ? AND key = ?",
    ).get(scope, this.normalizeScopeId(scope, scopeId), key);
    return row ? parseJson<T>(row.value) : null;
  }

  set<T>(scope: VariableScope, scopeId: string | null, key: string, value: T): void {
    const normalized = this.normalizeScopeId(scope, scopeId);
    const upsert = this.db.transaction(() => {
      const existing = stmt(
        this.db,
        "SELECT rowid FROM variables WHERE scope = ? AND scope_id IS ? AND key = ?",
      ).get(scope, normalized, key);
      if (existing === null) {
        stmt(
          this.db,
          "INSERT INTO variables (scope, scope_id, key, value) VALUES (?, ?, ?, ?)",
        ).run(scope, normalized, key, jsonOrNull(value));
      } else {
        stmt(
          this.db,
          "UPDATE variables SET value = ? WHERE scope = ? AND scope_id IS ? AND key = ?",
        ).run(jsonOrNull(value), scope, normalized, key);
      }
    });
    upsert();
  }

  delete(scope: VariableScope, scopeId: string | null, key: string): boolean {
    return (
      stmt(this.db, "DELETE FROM variables WHERE scope = ? AND scope_id IS ? AND key = ?").run(
        scope,
        this.normalizeScopeId(scope, scopeId),
        key,
      ).changes > 0
    );
  }

  /** All `key → value` pairs of one scope. */
  list(scope: VariableScope, scopeId: string | null): Record<string, unknown> {
    const rows = stmt<{ key: string; value: string }>(
      this.db,
      "SELECT key, value FROM variables WHERE scope = ? AND scope_id IS ?",
    ).all(scope, this.normalizeScopeId(scope, scopeId));
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      out[row.key] = parseJson(row.value);
    }
    return out;
  }

  private normalizeScopeId(scope: VariableScope, scopeId: string | null): string | null {
    if (scope === "global") {
      return null;
    }
    if (scopeId === null || scopeId === "") {
      throw new Error("chat-scoped variables require a chat id");
    }
    return scopeId;
  }
}
