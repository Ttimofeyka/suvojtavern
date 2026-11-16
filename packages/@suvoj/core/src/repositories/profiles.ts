/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { assignSql, stmt } from "../db/sql";
import {
  type Profile,
  type ProfileInput,
  type ProfilePatch,
  profileInputSchema,
} from "../schema/profiles";
import { boolToInt, jsonOrNull, newId, nowIso, parseJsonOr } from "../util";

/** Server-only endpoint credentials for a profile (never sent to clients). */
export interface ProfileSecret {
  base_url: string;
  api_key: string;
}

interface ProfileRow {
  id: string;
  name: string;
  model: string;
  base_url: string;
  api_key: string;
  sampling: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

/**
 * Row → read shape. `api_key` is deliberately dropped here (only the derived
 * `has_api_key` flag crosses the boundary) so it can never leak through the
 * API; see `profileSchema`.
 */
function toProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    base_url: row.base_url,
    sampling: parseJsonOr(row.sampling, {}),
    is_default: row.is_default === 1,
    has_api_key: row.api_key !== "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Connection profiles: the model plus sampler settings generation runs
 * with. Exactly one profile is `is_default`; it is created by seeding and
 * cannot be deleted (the routes enforce that).
 */
export class ProfilesRepository {
  constructor(private readonly db: Database) {}

  create(input: ProfileInput, opts?: { is_default?: boolean }): Profile {
    const data = profileInputSchema.parse(input);
    const id = newId();
    const ts = nowIso();
    const isDefault = opts?.is_default ?? false;
    stmt(
      this.db,
      `INSERT INTO connection_profiles (id, name, model, base_url, api_key, sampling, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      data.name,
      data.model,
      data.base_url,
      data.api_key,
      jsonOrNull(data.sampling),
      boolToInt(isDefault),
      ts,
      ts,
    );
    // Rebuild explicitly rather than spreading `data`: that would carry the
    // plaintext `api_key` into the read shape.
    return {
      id,
      name: data.name,
      model: data.model,
      base_url: data.base_url,
      sampling: data.sampling,
      is_default: isDefault,
      has_api_key: data.api_key !== "",
      created_at: ts,
      updated_at: ts,
    };
  }

  get(id: string): Profile | null {
    const row = stmt<ProfileRow>(this.db, "SELECT * FROM connection_profiles WHERE id = ?").get(id);
    return row ? toProfile(row) : null;
  }

  /**
   * Endpoint credentials of a profile — the one read path that deliberately
   * crosses the secret boundary. `null` when the profile does not exist.
   */
  getSecret(id: string): ProfileSecret | null {
    const row = stmt<{ base_url: string; api_key: string }>(
      this.db,
      "SELECT base_url, api_key FROM connection_profiles WHERE id = ?",
    ).get(id);
    return row ? { base_url: row.base_url, api_key: row.api_key } : null;
  }

  /** All profiles, the default first, then by creation time. */
  list(): Profile[] {
    return stmt<ProfileRow>(
      this.db,
      "SELECT * FROM connection_profiles ORDER BY is_default DESC, created_at, rowid",
    )
      .all()
      .map(toProfile);
  }

  update(id: string, patch: ProfilePatch): Profile | null {
    const current = this.get(id);
    if (!current) {
      return null;
    }
    const set = assignSql([
      ["name", patch.name],
      ["model", patch.model],
      ["base_url", patch.base_url],
      // `undefined` (absent) keeps the key; `null` clears it. assignSql skips
      // undefined but would bind null into the NOT NULL column, so collapse
      // null to "" here.
      ["api_key", patch.api_key === undefined ? undefined : (patch.api_key ?? "")],
      ["sampling", patch.sampling === undefined ? undefined : jsonOrNull(patch.sampling)],
    ]);
    if (!set) {
      return current;
    }
    stmt(
      this.db,
      `UPDATE connection_profiles SET ${set.assignments}, updated_at = ? WHERE id = ?`,
    ).run(...set.params, nowIso(), id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return stmt(this.db, "DELETE FROM connection_profiles WHERE id = ?").run(id).changes > 0;
  }
}
