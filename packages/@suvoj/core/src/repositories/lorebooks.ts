/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { assignSql, stmt } from "../db/sql";
import {
  type Lorebook,
  type LorebookEntry,
  type LorebookEntryInput,
  type LorebookInput,
  type LorebookSection,
  type LorebookSectionInput,
  lorebookEntryInputSchema,
  lorebookInputSchema,
  lorebookSectionInputSchema,
} from "../schema/lorebooks";
import { boolToInt, jsonOrNull, newId, nowIso, parseJson, parseJsonOr } from "../util";

interface LorebookRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

interface LorebookEntryRow {
  id: string;
  lorebook_id: string;
  keys: string;
  secondary: string;
  content: string;
  comment: string | null;
  constant: number;
  selective: number;
  logic: number;
  order: number;
  position: number;
  depth: number;
  role: string | null;
  probability: number;
  enabled: number;
  sticky: number;
  cooldown: number;
  delay: number;
  vectorized: number;
  case_sensitive: number;
  match_whole_words: number;
  scan_depth: number | null;
  group: string | null;
  group_weight: number | null;
  recursion: string | null;
  match_fields: string | null;
  character_filter: string | null;
  display_index: number;
  section_id: string | null;
  extra: string | null;
}

/** A `lorebook_sections` row; timestamps round-trip into the read shape. */
interface LorebookSectionRow {
  id: string;
  lorebook_id: string;
  name: string;
  display_index: number;
  created_at: string;
  updated_at: string;
}

function toLorebookSection(row: LorebookSectionRow): LorebookSection {
  return {
    id: row.id,
    lorebook_id: row.lorebook_id,
    name: row.name,
    display_index: row.display_index,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toLorebook(row: LorebookRow): Lorebook {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** A lorebook row joined with its character-link state. */
interface LorebookAttachmentRow extends LorebookRow {
  enabled: number;
}

/** A lorebook plus its per-character link state. */
export interface LorebookAttachment extends Lorebook {
  /** Whether the character link is enabled — disabled links never inject. */
  enabled: boolean;
}

/** True when `ids` is exactly a permutation of `expected` (same length AND set). */
function isPermutation(expected: readonly string[], ids: readonly string[]): boolean {
  if (ids.length !== expected.length) {
    return false;
  }
  const wanted = new Set(expected);
  if (wanted.size !== expected.length) {
    return false; // duplicate ids in the current set — treat as no valid permutation
  }
  for (const id of ids) {
    if (!wanted.delete(id)) {
      return false; // extra, duplicate, or foreign id
    }
  }
  return wanted.size === 0;
}

function toLorebookEntry(row: LorebookEntryRow): LorebookEntry {
  return {
    id: row.id,
    lorebook_id: row.lorebook_id,
    keys: parseJsonOr(row.keys, []),
    secondary: parseJsonOr(row.secondary, []),
    content: row.content,
    comment: row.comment,
    constant: row.constant === 1,
    selective: row.selective === 1,
    logic: row.logic,
    order: row.order,
    position: row.position,
    depth: row.depth,
    role: row.role,
    probability: row.probability,
    enabled: row.enabled === 1,
    sticky: row.sticky,
    cooldown: row.cooldown,
    delay: row.delay,
    vectorized: row.vectorized === 1,
    case_sensitive: row.case_sensitive === 1,
    match_whole_words: row.match_whole_words === 1,
    scan_depth: row.scan_depth,
    group: row.group,
    group_weight: row.group_weight,
    recursion: parseJson(row.recursion),
    match_fields: parseJson(row.match_fields),
    character_filter: parseJson(row.character_filter),
    section_id: row.section_id,
    display_index: row.display_index,
    extra: parseJson(row.extra),
  };
}

/** Lorebooks, their entries (full ST surface), and character links. */
export class LorebooksRepository {
  constructor(private readonly db: Database) {}

  create(input: LorebookInput): Lorebook {
    const data = lorebookInputSchema.parse(input);
    const id = newId();
    const ts = nowIso();
    stmt(
      this.db,
      "INSERT INTO lorebooks (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, data.name, data.description, ts, ts);
    return { id, ...data, created_at: ts, updated_at: ts };
  }

  get(id: string): Lorebook | null {
    const row = stmt<LorebookRow>(this.db, "SELECT * FROM lorebooks WHERE id = ?").get(id);
    return row ? toLorebook(row) : null;
  }

  list(): Lorebook[] {
    return stmt<LorebookRow>(this.db, "SELECT * FROM lorebooks ORDER BY name COLLATE NOCASE")
      .all()
      .map(toLorebook);
  }

  update(id: string, patch: Partial<LorebookInput>): Lorebook | null {
    const current = this.get(id);
    if (!current) {
      return null;
    }
    const set = assignSql([
      ["name", patch.name],
      ["description", patch.description],
    ]);
    if (!set) {
      return current;
    }
    stmt(this.db, `UPDATE lorebooks SET ${set.assignments}, updated_at = ? WHERE id = ?`).run(
      ...set.params,
      nowIso(),
      id,
    );
    return this.get(id);
  }

  /** Deletes a lorebook; entries, sections, and character links cascade. */
  delete(id: string): boolean {
    return stmt(this.db, "DELETE FROM lorebooks WHERE id = ?").run(id).changes > 0;
  }

  // --- sections ---

  /**
   * Creates a section, appending it after the book's existing sections.
   * Any `display_index` on the input is intentionally overridden: a new
   * section always lands last so callers cannot accidentally collide.
   */
  createSection(lorebookId: string, input: LorebookSectionInput): LorebookSection {
    const data = lorebookSectionInputSchema.parse(input);
    const id = newId();
    const ts = nowIso();
    const displayIndex = this.nextSectionIndex(lorebookId);
    stmt(
      this.db,
      `INSERT INTO lorebook_sections (id, lorebook_id, name, display_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, lorebookId, data.name, displayIndex, ts, ts);
    return {
      id,
      lorebook_id: lorebookId,
      name: data.name,
      display_index: displayIndex,
      created_at: ts,
      updated_at: ts,
    };
  }

  getSection(sectionId: string): LorebookSection | null {
    const row = stmt<LorebookSectionRow>(
      this.db,
      "SELECT * FROM lorebook_sections WHERE id = ?",
    ).get(sectionId);
    return row ? toLorebookSection(row) : null;
  }

  /** A book's sections in render order (`display_index`, then insertion). */
  listSections(lorebookId: string): LorebookSection[] {
    return stmt<LorebookSectionRow>(
      this.db,
      "SELECT * FROM lorebook_sections WHERE lorebook_id = ? ORDER BY display_index, rowid",
    )
      .all(lorebookId)
      .map(toLorebookSection);
  }

  updateSection(sectionId: string, patch: Partial<LorebookSectionInput>): LorebookSection | null {
    const current = this.getSection(sectionId);
    if (!current) {
      return null;
    }
    const set = assignSql([
      ["name", patch.name],
      ["display_index", patch.display_index],
    ]);
    if (!set) {
      return current;
    }
    stmt(
      this.db,
      `UPDATE lorebook_sections SET ${set.assignments}, updated_at = ? WHERE id = ?`,
    ).run(...set.params, nowIso(), sectionId);
    return this.getSection(sectionId);
  }

  /**
   * Deletes a section WITHOUT deleting its entries: the FK first sets their
   * `section_id` to NULL, then they are appended to the book's ungrouped
   * container — consecutive `display_index` values after its current max —
   * so their relative order is deterministic and they stay visible in the
   * editor. Entries are a section's contents, never its property.
   */
  deleteSection(sectionId: string): boolean {
    const section = this.getSection(sectionId);
    if (!section) {
      return false;
    }
    return this.db.transaction(() => {
      // Capture the section's entries (their per-container order) before the
      // delete, and the ungrouped next index while they are still grouped —
      // after the FK nulls them they would inflate the ungrouped max.
      const entries = stmt<{ id: string }>(
        this.db,
        "SELECT id FROM lorebook_entries WHERE section_id = ? ORDER BY display_index, rowid",
      ).all(sectionId);
      let next = this.nextDisplayIndex(section.lorebook_id, null);
      const removed =
        stmt(this.db, "DELETE FROM lorebook_sections WHERE id = ?").run(sectionId).changes > 0;
      if (!removed) {
        return false; // deleted concurrently; roll the captures back
      }
      const assign = stmt(this.db, "UPDATE lorebook_entries SET display_index = ? WHERE id = ?");
      for (const entry of entries) {
        assign.run(next, entry.id);
        next += 1;
      }
      return true;
    })();
  }

  /**
   * Rewrites the book's section order. `ids` must be exactly a permutation
   * of the book's section ids — a mismatch (extra, missing, duplicate, or a
   * foreign id) answers `null` and changes nothing.
   */
  reorderSections(lorebookId: string, ids: readonly string[]): LorebookSection[] | null {
    const current = this.listSections(lorebookId);
    if (
      !isPermutation(
        current.map((section) => section.id),
        ids,
      )
    ) {
      return null;
    }
    this.db.transaction(() => {
      const assign = stmt(this.db, "UPDATE lorebook_sections SET display_index = ? WHERE id = ?");
      ids.forEach((id, index) => {
        assign.run(index, id);
      });
    })();
    return this.listSections(lorebookId);
  }

  /**
   * Rewrites the order within one container (lorebook_id, section_id), where
   * `sectionId === null` is the ungrouped bucket. `ids` must be exactly a
   * permutation of that container's entry ids, else `null`. Other containers
   * are untouched, but all of the book's entries are returned.
   *
   * `sectionId` is assumed to belong to `lorebookId`: the FK on
   * `lorebook_entries.section_id` proves the section exists but cannot express
   * "same lorebook", so cross-book integrity is enforced by the routes before
   * this is called (a foreign section would otherwise read as an empty
   * container here).
   */
  reorderEntries(
    lorebookId: string,
    sectionId: string | null,
    ids: readonly string[],
  ): LorebookEntry[] | null {
    const container = stmt<{ id: string }>(
      this.db,
      `SELECT id FROM lorebook_entries
       WHERE lorebook_id = ? AND section_id IS ?
       ORDER BY display_index, rowid`,
    )
      .all(lorebookId, sectionId)
      .map((row) => row.id);
    if (!isPermutation(container, ids)) {
      return null;
    }
    this.db.transaction(() => {
      const assign = stmt(this.db, "UPDATE lorebook_entries SET display_index = ? WHERE id = ?");
      ids.forEach((id, index) => {
        assign.run(index, id);
      });
    })();
    return this.listEntries(lorebookId);
  }

  // --- entries ---

  addEntry(lorebookId: string, input: LorebookEntryInput): LorebookEntry {
    return this.insertEntryRow(lorebookId, input);
  }
  getEntry(entryId: string): LorebookEntry | null {
    const row = stmt<LorebookEntryRow>(this.db, "SELECT * FROM lorebook_entries WHERE id = ?").get(
      entryId,
    );
    return row ? toLorebookEntry(row) : null;
  }

  /** Entries ordered by `display_index` (SillyTavern's editor order). */
  listEntries(lorebookId: string): LorebookEntry[] {
    return stmt<LorebookEntryRow>(
      this.db,
      "SELECT * FROM lorebook_entries WHERE lorebook_id = ? ORDER BY display_index, rowid",
    )
      .all(lorebookId)
      .map(toLorebookEntry);
  }

  /**
   * Patches an entry. When `patch.section_id` moves it to another container
   * without an explicit `display_index`, the entry is appended there (same
   * rule as addEntry). The target section is assumed to belong to the entry's
   * lorebook — the FK cannot express "same book", so the routes reject a
   * cross-book `section_id` before this runs.
   */
  updateEntry(entryId: string, patch: Partial<LorebookEntryInput>): LorebookEntry | null {
    const current = this.getEntry(entryId);
    if (!current) {
      return null;
    }
    // Moving an entry to a different container without an explicit
    // `display_index` appends it there (same rule as addEntry). An explicit
    // index wins and is written verbatim.
    let displayIndex = patch.display_index;
    if (
      patch.section_id !== undefined &&
      patch.section_id !== current.section_id &&
      patch.display_index === undefined
    ) {
      displayIndex = this.nextDisplayIndex(current.lorebook_id, patch.section_id);
    }
    const set = assignSql([
      ["keys", patch.keys === undefined ? undefined : jsonOrNull(patch.keys)],
      ["secondary", patch.secondary === undefined ? undefined : jsonOrNull(patch.secondary)],
      ["content", patch.content],
      ["comment", patch.comment],
      ["constant", patch.constant],
      ["selective", patch.selective],
      ["logic", patch.logic],
      ["order", patch.order],
      ["position", patch.position],
      ["depth", patch.depth],
      ["role", patch.role],
      ["probability", patch.probability],
      ["enabled", patch.enabled],
      ["sticky", patch.sticky],
      ["cooldown", patch.cooldown],
      ["delay", patch.delay],
      ["vectorized", patch.vectorized],
      ["case_sensitive", patch.case_sensitive],
      ["match_whole_words", patch.match_whole_words],
      ["scan_depth", patch.scan_depth],
      ["group", patch.group],
      ["group_weight", patch.group_weight],
      ["recursion", patch.recursion === undefined ? undefined : jsonOrNull(patch.recursion)],
      [
        "match_fields",
        patch.match_fields === undefined ? undefined : jsonOrNull(patch.match_fields),
      ],
      [
        "character_filter",
        patch.character_filter === undefined ? undefined : jsonOrNull(patch.character_filter),
      ],
      ["section_id", patch.section_id],
      ["display_index", displayIndex],
      ["extra", patch.extra === undefined ? undefined : jsonOrNull(patch.extra)],
    ]);
    if (!set) {
      return current;
    }
    stmt(this.db, `UPDATE lorebook_entries SET ${set.assignments} WHERE id = ?`).run(
      ...set.params,
      entryId,
    );
    return this.getEntry(entryId);
  }

  deleteEntry(entryId: string): boolean {
    return stmt(this.db, "DELETE FROM lorebook_entries WHERE id = ?").run(entryId).changes > 0;
  }

  /**
   * Full-replace import: atomically swaps the lorebook's entries for the
   * given list (fresh ids, `display_index` order preserved as given).
   *
   * Sections are dropped too: SillyTavern files carry no section concept, so
   * a replacing import intentionally rebuilds the native section layout from
   * scratch rather than leaving stale sections pointing at deleted entries.
   */
  replaceEntries(lorebookId: string, entries: ReadonlyArray<LorebookEntryInput>): LorebookEntry[] {
    return this.db.transaction(() => {
      stmt(this.db, "DELETE FROM lorebook_entries WHERE lorebook_id = ?").run(lorebookId);
      stmt(this.db, "DELETE FROM lorebook_sections WHERE lorebook_id = ?").run(lorebookId);
      for (const entry of entries) {
        this.insertEntryRow(lorebookId, entry);
      }
      return this.listEntries(lorebookId);
    })();
  }

  // --- character links ---

  attachToCharacter(characterId: string, lorebookId: string): void {
    stmt(
      this.db,
      "INSERT OR IGNORE INTO character_lorebooks (character_id, lorebook_id) VALUES (?, ?)",
    ).run(characterId, lorebookId);
  }

  detachFromCharacter(characterId: string, lorebookId: string): boolean {
    return (
      stmt(
        this.db,
        "DELETE FROM character_lorebooks WHERE character_id = ? AND lorebook_id = ?",
      ).run(characterId, lorebookId).changes > 0
    );
  }

  /**
   * Lorebooks attached to a character — **enabled links only**. This is the
   * surface the engine's lorebook stage consumes, so a disabled link is
   * invisible to generation here. Use {@link listAttachmentsForCharacter}
   * for the full link state (editors, chat popover).
   */
  listForCharacter(characterId: string): Lorebook[] {
    return stmt<LorebookRow>(
      this.db,
      `SELECT lorebooks.* FROM lorebooks
       JOIN character_lorebooks ON character_lorebooks.lorebook_id = lorebooks.id
       WHERE character_lorebooks.character_id = ? AND character_lorebooks.enabled = 1
       ORDER BY lorebooks.name COLLATE NOCASE`,
    )
      .all(characterId)
      .map(toLorebook);
  }

  /** All lorebooks linked to a character, each with its per-link enabled flag. */
  listAttachmentsForCharacter(characterId: string): LorebookAttachment[] {
    return stmt<LorebookAttachmentRow>(
      this.db,
      `SELECT lorebooks.*, character_lorebooks.enabled AS enabled
       FROM lorebooks
       JOIN character_lorebooks ON character_lorebooks.lorebook_id = lorebooks.id
       WHERE character_lorebooks.character_id = ?
       ORDER BY lorebooks.name COLLATE NOCASE`,
    )
      .all(characterId)
      .map((row) => ({ ...toLorebook(row), enabled: row.enabled === 1 }));
  }

  /** Flips a link's enabled flag; false when no link exists. */
  setAttachmentEnabled(characterId: string, lorebookId: string, enabled: boolean): boolean {
    return (
      stmt(
        this.db,
        "UPDATE character_lorebooks SET enabled = ? WHERE character_id = ? AND lorebook_id = ?",
      ).run(boolToInt(enabled), characterId, lorebookId).changes > 0
    );
  }

  /** Character-link count per lorebook id (books with no links are absent). */
  attachmentCounts(): Map<string, number> {
    const rows = stmt<{ lorebook_id: string; count: number }>(
      this.db,
      "SELECT lorebook_id, COUNT(*) AS count FROM character_lorebooks GROUP BY lorebook_id",
    ).all();
    return new Map(rows.map((row) => [row.lorebook_id, row.count]));
  }

  private insertEntryRow(lorebookId: string, input: LorebookEntryInput): LorebookEntry {
    // Append semantics: an omitted `display_index` lands the entry at the end
    // of its container; an explicit index is honored verbatim. The input is
    // the raw `z.input` (pre-schema) so `undefined` is still observable — the
    // create schema defaults `display_index` to 0, so callers that go through
    // it (HTTP POST) must re-omit the field when the client sent none.
    const sectionId = input.section_id ?? null;
    const data = lorebookEntryInputSchema.parse(input);
    const displayIndex =
      input.display_index === undefined
        ? this.nextDisplayIndex(lorebookId, sectionId)
        : data.display_index;
    const entry: LorebookEntry = {
      id: newId(),
      lorebook_id: lorebookId,
      ...data,
      display_index: displayIndex,
    };
    stmt(
      this.db,
      `INSERT INTO lorebook_entries (
         id, lorebook_id, keys, secondary, content, comment, constant, selective,
         logic, "order", position, depth, role, probability, enabled, sticky,
         cooldown, delay, vectorized, case_sensitive, match_whole_words, scan_depth,
         "group", group_weight, recursion, match_fields, character_filter,
         display_index, section_id, extra
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.id,
      entry.lorebook_id,
      jsonOrNull(entry.keys),
      jsonOrNull(entry.secondary),
      entry.content,
      entry.comment,
      boolToInt(entry.constant),
      boolToInt(entry.selective),
      entry.logic,
      entry.order,
      entry.position,
      entry.depth,
      entry.role,
      entry.probability,
      boolToInt(entry.enabled),
      entry.sticky,
      entry.cooldown,
      entry.delay,
      boolToInt(entry.vectorized),
      boolToInt(entry.case_sensitive),
      boolToInt(entry.match_whole_words),
      entry.scan_depth,
      entry.group,
      entry.group_weight,
      jsonOrNull(entry.recursion),
      jsonOrNull(entry.match_fields),
      jsonOrNull(entry.character_filter),
      entry.display_index,
      entry.section_id,
      jsonOrNull(entry.extra),
    );
    return entry;
  }

  /**
   * The next `display_index` for a container: max + 1, or 0 when the
   * container is empty. A container is (lorebook_id, section_id), where a
   * NULL `section_id` is the ungrouped bucket (`IS ?` handles the NULL case,
   * which `= NULL` never matches).
   */
  private nextDisplayIndex(lorebookId: string, sectionId: string | null): number {
    const row = stmt<{ next: number }>(
      this.db,
      `SELECT COALESCE(MAX(display_index), -1) + 1 AS next
       FROM lorebook_entries WHERE lorebook_id = ? AND section_id IS ?`,
    ).get(lorebookId, sectionId);
    return row ? row.next : 0;
  }

  /** The next section index in a book: max + 1, or 0 when there are none. */
  private nextSectionIndex(lorebookId: string): number {
    const row = stmt<{ next: number }>(
      this.db,
      `SELECT COALESCE(MAX(display_index), -1) + 1 AS next
       FROM lorebook_sections WHERE lorebook_id = ?`,
    ).get(lorebookId);
    return row ? row.next : 0;
  }
}
