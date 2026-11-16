/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { assignSql, stmt } from "../db/sql";
import {
  type Character,
  type CharacterImage,
  type CharacterImageInput,
  type CharacterInput,
  type CharacterListRow,
  characterImageInputSchema,
  characterInputSchema,
} from "../schema/characters";
import { jsonOrNull, newId, nowIso, parseJson, parseJsonOr } from "../util";

/** Slim columns backing the list projection — never `SELECT *` for a listing. */
const LIST_COLUMNS = "id, name, avatar_path, tags, created_at, updated_at";

interface CharacterRow {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string;
  tags: string;
  avatar_path: string | null;
  created_at: string;
  updated_at: string;
  card_raw: string | null;
}

interface CharacterImageRow {
  id: string;
  character_id: string;
  blob_path: string | null;
  sort: number;
  created_at: string;
}

/** Row shape of the slim list projection (see {@link LIST_COLUMNS}). */
interface CharacterListRowDb {
  id: string;
  name: string;
  avatar_path: string | null;
  tags: string;
  created_at: string;
  updated_at: string;
}

/** Filters accepted by both `list` and `count`, so the two cannot diverge. */
interface CharacterFilters {
  /** Tag names a character must ALL carry (AND): each becomes its own EXISTS
   *  clause, so adding a tag narrows the set. An empty array is "no filter". */
  tags?: string[];
  search?: string;
}

/**
 * Listing order. `"name"` is the default and preserves the historical
 * name-ascending behavior; `"created"` is newest-first; `"recent"` surfaces
 * characters with the most recently updated chat first (chat-less rows last).
 * A listing concern only — it never affects `count`/`listTags`.
 */
export type CharacterSort = "name" | "created" | "recent";

/**
 * ORDER BY fragments per sort key. `characters.` qualifies the correlated
 * subquery in `"recent"`; SQLite already sorts NULLs last under DESC, so
 * characters without chats sink below every chat-bearing one. Each non-name
 * clause ends in a rowid tiebreak to stay deterministic when timestamps
 * collide (they are ms-resolution ISO strings).
 */
const ORDER_BY: Record<CharacterSort, string> = {
  name: "name COLLATE NOCASE, rowid",
  created: "created_at DESC, rowid DESC",
  recent:
    "(SELECT MAX(updated_at) FROM chats WHERE chats.character_id = characters.id) DESC, created_at DESC, rowid DESC",
};

function toCharacter(row: CharacterRow): Character {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    personality: row.personality,
    scenario: row.scenario,
    first_mes: row.first_mes,
    mes_example: row.mes_example,
    creator_notes: row.creator_notes,
    system_prompt: row.system_prompt,
    post_history_instructions: row.post_history_instructions,
    alternate_greetings: parseJsonOr(row.alternate_greetings, []),
    tags: parseJsonOr(row.tags, []),
    avatar_path: row.avatar_path,
    created_at: row.created_at,
    updated_at: row.updated_at,
    card_raw: parseJson(row.card_raw),
  };
}

function toCharacterImage(row: CharacterImageRow): CharacterImage {
  return {
    id: row.id,
    character_id: row.character_id,
    blob_path: row.blob_path,
    sort: row.sort,
    created_at: row.created_at,
  };
}

/** Maps a slim list row; `tags` is the only JSON column in the projection. */
function toCharacterListRow(row: CharacterListRowDb): CharacterListRow {
  return {
    id: row.id,
    name: row.name,
    avatar_path: row.avatar_path,
    tags: parseJsonOr(row.tags, []),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Builds the shared `WHERE` clause and bound params for the list/count pair.
 * Factored out deliberately: `list` and `count` MUST see identical filters,
 * or page `total` would disagree with the returned rows.
 */
function buildFilters(filters: CharacterFilters): {
  where: string;
  params: SQLQueryBindings[];
} {
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (filters.tags !== undefined) {
    // One EXISTS per tag, AND-combined: a character must carry every selected
    // tag. `json_each` is per-row, so each clause is independent.
    for (const tag of filters.tags) {
      conditions.push(
        "EXISTS (SELECT 1 FROM json_each(characters.tags) WHERE json_each.value = ?)",
      );
      params.push(tag);
    }
  }
  if (filters.search !== undefined && filters.search !== "") {
    conditions.push("name LIKE ? COLLATE NOCASE");
    params.push(`%${filters.search}%`);
  }
  return {
    where: conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

/** Characters and their image galleries. */
export class CharactersRepository {
  constructor(private readonly db: Database) {}

  create(input: CharacterInput): Character {
    const data = characterInputSchema.parse(input);
    const id = newId();
    const ts = nowIso();
    stmt(
      this.db,
      `INSERT INTO characters (
         id, name, description, personality, scenario, first_mes, mes_example,
         creator_notes, system_prompt, post_history_instructions,
         alternate_greetings, tags, avatar_path, created_at, updated_at, card_raw
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      data.name,
      data.description,
      data.personality,
      data.scenario,
      data.first_mes,
      data.mes_example,
      data.creator_notes,
      data.system_prompt,
      data.post_history_instructions,
      jsonOrNull(data.alternate_greetings),
      jsonOrNull(data.tags),
      data.avatar_path,
      ts,
      ts,
      jsonOrNull(data.card_raw),
    );
    return { id, ...data, created_at: ts, updated_at: ts };
  }

  get(id: string): Character | null {
    const row = stmt<CharacterRow>(this.db, "SELECT * FROM characters WHERE id = ?").get(id);
    return row ? toCharacter(row) : null;
  }

  /**
   * Slim character rows, optionally filtered by one or more exact tags (ALL
   * must be present) or a case-insensitive name substring search, and ordered
   * by `sort` (default {@link CharacterSort} `"name"`).
   *
   * Returns a projection (no `description`/`card_raw`/prompts), so callers
   * that need a full card must go through {@link get}. `limit` is optional on
   * purpose: when omitted the query is unbounded, which the card importer's
   * duplicate-name check relies on to see every existing name.
   */
  list(
    options: CharacterFilters & { sort?: CharacterSort; limit?: number; offset?: number } = {},
  ): CharacterListRow[] {
    const { where, params } = buildFilters(options);
    let sql = `SELECT ${LIST_COLUMNS} FROM characters${where} ORDER BY ${ORDER_BY[options.sort ?? "name"]}`;
    const binds = [...params];
    if (options.limit !== undefined) {
      sql += " LIMIT ?";
      binds.push(options.limit);
      // An OFFSET without a LIMIT is invalid SQLite; only append when a
      // positive offset was requested (0 is a no-op).
      if (options.offset !== undefined && options.offset > 0) {
        sql += " OFFSET ?";
        binds.push(options.offset);
      }
    }
    return stmt<CharacterListRowDb>(this.db, sql)
      .all(...binds)
      .map(toCharacterListRow);
  }

  /**
   * Number of characters matching the same filters as {@link list}, ignoring
   * paging. Shares {@link buildFilters} so `total` can never drift from the
   * rows the same query would return.
   */
  count(options: CharacterFilters = {}): number {
    const { where, params } = buildFilters(options);
    const row = stmt<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM characters${where}`).get(
      ...params,
    );
    return row?.n ?? 0;
  }

  /**
   * Distinct tags across the characters matching the same filters as
   * {@link list} (ignoring paging), for the grid's filter chips. A tag that
   * only occurs beyond the loaded pages would otherwise never be offered.
   *
   * The facet is a join against `json_each(characters.tags)` in the FROM
   * clause — which enumerates every tag of each matching character — while
   * {@link buildFilters}'s tag conditions stay `EXISTS (...)` subqueries
   * scoped to `characters.tags`. Those are independent `json_each`
   * instances (the FROM one and the subquery's), so composing the shared
   * `WHERE` here is valid: the WHERE decides *which characters* qualify, and
   * the join then emits all of their tags.
   */
  listTags(options: CharacterFilters = {}): string[] {
    const { where, params } = buildFilters(options);
    const rows = stmt<{ tag: string }>(
      this.db,
      `SELECT DISTINCT json_each.value AS tag FROM characters, json_each(characters.tags)${where} ORDER BY 1`,
    ).all(...params);
    return rows.map((row) => row.tag);
  }

  update(id: string, patch: Partial<CharacterInput>): Character | null {
    const current = this.get(id);
    if (!current) {
      return null;
    }
    const set = assignSql([
      ["name", patch.name],
      ["description", patch.description],
      ["personality", patch.personality],
      ["scenario", patch.scenario],
      ["first_mes", patch.first_mes],
      ["mes_example", patch.mes_example],
      ["creator_notes", patch.creator_notes],
      ["system_prompt", patch.system_prompt],
      ["post_history_instructions", patch.post_history_instructions],
      [
        "alternate_greetings",
        patch.alternate_greetings === undefined ? undefined : jsonOrNull(patch.alternate_greetings),
      ],
      ["tags", patch.tags === undefined ? undefined : jsonOrNull(patch.tags)],
      ["avatar_path", patch.avatar_path],
      ["card_raw", patch.card_raw === undefined ? undefined : jsonOrNull(patch.card_raw)],
    ]);
    if (!set) {
      return current;
    }
    stmt(this.db, `UPDATE characters SET ${set.assignments}, updated_at = ? WHERE id = ?`).run(
      ...set.params,
      nowIso(),
      id,
    );
    return this.get(id);
  }

  /** Deletes a character (gallery images cascade). Chats must be deleted first. */
  delete(id: string): boolean {
    return stmt(this.db, "DELETE FROM characters WHERE id = ?").run(id).changes > 0;
  }

  // --- gallery (character_images) ---

  addImage(characterId: string, input: CharacterImageInput): CharacterImage {
    const data = characterImageInputSchema.parse(input);
    const id = newId();
    const ts = nowIso();
    stmt(
      this.db,
      "INSERT INTO character_images (id, character_id, blob_path, sort, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, characterId, data.blob_path, data.sort, ts);
    return {
      id,
      character_id: characterId,
      blob_path: data.blob_path,
      sort: data.sort,
      created_at: ts,
    };
  }

  getImage(imageId: string): CharacterImage | null {
    const row = stmt<CharacterImageRow>(this.db, "SELECT * FROM character_images WHERE id = ?").get(
      imageId,
    );
    return row ? toCharacterImage(row) : null;
  }

  /** Gallery images ordered by `sort`, then insertion order. */
  listImages(characterId: string): CharacterImage[] {
    const rows = stmt<CharacterImageRow>(
      this.db,
      "SELECT * FROM character_images WHERE character_id = ? ORDER BY sort, rowid",
    ).all(characterId);
    return rows.map(toCharacterImage);
  }

  updateImage(
    imageId: string,
    patch: Partial<Pick<CharacterImage, "blob_path" | "sort">>,
  ): CharacterImage | null {
    const current = this.getImage(imageId);
    if (!current) {
      return null;
    }
    const set = assignSql([
      ["blob_path", patch.blob_path],
      ["sort", patch.sort],
    ]);
    if (!set) {
      return current;
    }
    stmt(this.db, `UPDATE character_images SET ${set.assignments} WHERE id = ?`).run(
      ...set.params,
      imageId,
    );
    return this.getImage(imageId);
  }

  deleteImage(imageId: string): boolean {
    return stmt(this.db, "DELETE FROM character_images WHERE id = ?").run(imageId).changes > 0;
  }
}
