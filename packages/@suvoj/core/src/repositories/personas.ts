/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { assignSql, stmt } from "../db/sql";
import { type Persona, type PersonaInput, personaInputSchema } from "../schema/personas";
import { newId, nowIso } from "../util";

interface PersonaRow {
  id: string;
  name: string;
  description: string;
  avatar_path: string | null;
  created_at: string;
  updated_at: string;
}

function toPersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    avatar_path: row.avatar_path,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** User personas. */
export class PersonasRepository {
  constructor(private readonly db: Database) {}

  create(input: PersonaInput): Persona {
    const data = personaInputSchema.parse(input);
    const id = newId();
    const ts = nowIso();
    stmt(
      this.db,
      "INSERT INTO personas (id, name, description, avatar_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, data.name, data.description, data.avatar_path, ts, ts);
    return { id, ...data, created_at: ts, updated_at: ts };
  }

  get(id: string): Persona | null {
    const row = stmt<PersonaRow>(this.db, "SELECT * FROM personas WHERE id = ?").get(id);
    return row ? toPersona(row) : null;
  }

  list(): Persona[] {
    return stmt<PersonaRow>(this.db, "SELECT * FROM personas ORDER BY name COLLATE NOCASE, rowid")
      .all()
      .map(toPersona);
  }

  update(id: string, patch: Partial<PersonaInput>): Persona | null {
    const current = this.get(id);
    if (!current) {
      return null;
    }
    const set = assignSql([
      ["name", patch.name],
      ["description", patch.description],
      ["avatar_path", patch.avatar_path],
    ]);
    if (!set) {
      return current;
    }
    stmt(this.db, `UPDATE personas SET ${set.assignments}, updated_at = ? WHERE id = ?`).run(
      ...set.params,
      nowIso(),
      id,
    );
    return this.get(id);
  }

  delete(id: string): boolean {
    return stmt(this.db, "DELETE FROM personas WHERE id = ?").run(id).changes > 0;
  }
}
