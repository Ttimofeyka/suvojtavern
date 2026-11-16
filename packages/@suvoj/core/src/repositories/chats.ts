/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { assignSql, stmt } from "../db/sql";
import { type Chat, type ChatInput, chatInputSchema, type ForkChatOptions } from "../schema/chats";
import { newId, nowIso } from "../util";

interface ChatRow {
  id: string;
  character_id: string;
  persona_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  branch_root_id: string | null;
  active_branch: string | null;
  tracker_enabled: number;
}

/** Message columns needed when copying history during a fork. */
interface MessageCopyRow {
  seq: number;
  role: string;
  name: string | null;
  content: string;
  metadata: string | null;
  created_at: string;
}

/** Summary (layered memory) columns needed when copying memories during a fork. */
interface SummaryCopyRow {
  level: number;
  seq_from: number;
  seq_to: number;
  summary: string;
  tokens: number | null;
  created_at: string;
}

function toChat(row: ChatRow): Chat {
  return {
    id: row.id,
    character_id: row.character_id,
    persona_id: row.persona_id,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    branch_root_id: row.branch_root_id,
    active_branch: row.active_branch,
    // SQLite stores the flag as 0/1; the schema type is a boolean.
    tracker_enabled: row.tracker_enabled !== 0,
  };
}

/**
 * Builds the shared `WHERE` clause and bound params for the list/count pair.
 * Factored out deliberately: `list` and `count` MUST see the same filter, or
 * page `total` would disagree with the returned rows.
 */
function chatFilter(characterId?: string): { where: string; params: SQLQueryBindings[] } {
  return characterId === undefined
    ? { where: "", params: [] }
    : { where: " WHERE character_id = ?", params: [characterId] };
}

/**
 * Chats, including branching.
 *
 * Branching semantics (see also the migration's schema comments):
 * - a chat forked from a message stores that message's id in
 *   `branch_root_id` — the fork point inside the *parent* chat;
 * - the parent's `active_branch` holds the id of the child chat currently
 *   followed from it. Forking again from the same parent overwrites the
 *   pointer (older children are kept, just no longer marked active).
 */
export class ChatsRepository {
  constructor(private readonly db: Database) {}

  create(input: ChatInput): Chat {
    const data = chatInputSchema.parse(input);
    const id = newId();
    const ts = nowIso();
    stmt(
      this.db,
      `INSERT INTO chats (id, character_id, persona_id, title, created_at, updated_at, branch_root_id, active_branch)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(id, data.character_id, data.persona_id, data.title, ts, ts);
    return {
      id,
      character_id: data.character_id,
      persona_id: data.persona_id,
      title: data.title,
      created_at: ts,
      updated_at: ts,
      branch_root_id: null,
      active_branch: null,
      // The column default (1) — new chats track like every existing one.
      tracker_enabled: true,
    };
  }

  get(id: string): Chat | null {
    const row = stmt<ChatRow>(this.db, "SELECT * FROM chats WHERE id = ?").get(id);
    return row ? toChat(row) : null;
  }

  /** Chats of a character, most recently updated first (rowid breaks ms ties). */
  listByCharacter(characterId: string): Chat[] {
    return this.list({ characterId });
  }

  /**
   * Chats, newest-updated first (rowid breaks ms ties), optionally scoped to
   * one character and paged.
   *
   * Omitting `characterId` lists every chat in ONE query — this replaces the
   * old all-characters branch that ran `listByCharacter` per character and
   * re-sorted the flattened result in JS. Paging is pushed into SQL so a page
   * only ever materializes its own rows.
   */
  list(options: { characterId?: string; limit?: number; offset?: number } = {}): Chat[] {
    const { where, params } = chatFilter(options.characterId);
    let sql = `SELECT * FROM chats${where} ORDER BY updated_at DESC, rowid DESC`;
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
    return stmt<ChatRow>(this.db, sql)
      .all(...binds)
      .map(toChat);
  }

  /**
   * Number of chats matching the same filter as {@link list}, ignoring paging.
   * Shares {@link chatFilter} so `total` can never drift from the rows the same
   * query would return.
   */
  count(characterId?: string): number {
    const { where, params } = chatFilter(characterId);
    const row = stmt<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM chats${where}`).get(
      ...params,
    );
    return row?.n ?? 0;
  }

  /**
   * Chat counts per character id, in one grouped query. Listing characters
   * would otherwise call {@link listByCharacter} once per character (an
   * N+1 that scales with the whole library); this collapses it to a single
   * scan. Characters with zero chats are simply absent from the map.
   */
  countsByCharacter(): Map<string, number> {
    const rows = stmt<{ character_id: string; n: number }>(
      this.db,
      "SELECT character_id, COUNT(*) AS n FROM chats GROUP BY character_id",
    ).all();
    return new Map(rows.map((row) => [row.character_id, row.n]));
  }

  update(
    id: string,
    patch: Partial<Pick<Chat, "title" | "persona_id" | "active_branch" | "tracker_enabled">>,
  ): Chat | null {
    const current = this.get(id);
    if (!current) {
      return null;
    }
    const set = assignSql([
      ["title", patch.title],
      ["persona_id", patch.persona_id],
      ["active_branch", patch.active_branch],
      [
        "tracker_enabled",
        patch.tracker_enabled === undefined ? undefined : patch.tracker_enabled ? 1 : 0,
      ],
    ]);
    if (!set) {
      return current;
    }
    stmt(this.db, `UPDATE chats SET ${set.assignments}, updated_at = ? WHERE id = ?`).run(
      ...set.params,
      nowIso(),
      id,
    );
    return this.get(id);
  }

  /** Deletes a chat; its messages and summaries cascade. */
  delete(id: string): boolean {
    return stmt(this.db, "DELETE FROM chats WHERE id = ?").run(id).changes > 0;
  }

  /**
   * Forks a chat at `fromMessageId`, atomically:
   *
   * - the new chat copies the parent's character and persona (unless
   *   overridden by `options`), gets a fresh id, and records the fork point
   *   message id in `branch_root_id`;
   * - every *active* message of the parent with `seq <=` the fork point's
   *   `seq` is copied with a new id but the same `seq`, `content`, `metadata`
   *   and `created_at`. Inactive swipes are not copied; copies always have
   *   `variant_of = null` and `active = 1`, so the forked chat starts with
   *   one clean, active history;
   * - the parent's layered memories (summaries) are copied too, with fresh
   *   ids, for every summary that *begins* at or before the fork point
   *   (`seq_from <=` the fork point's `seq`); a summary starting after the
   *   fork point is dropped. Each copy's `seq_to` is clamped to the fork
   *   point so a copied memory never covers positions that do not exist in
   *   the fork (e.g. a parent `[5..12]` forked at seq 8 becomes `[5..8]`);
   * - the parent's `active_branch` is set to the new chat id and the parent
   *   gets its `updated_at` bumped.
   *
   * If the fork point message is itself an inactive swipe, only the active
   * messages up to its position are copied.
   */
  forkChat(fromMessageId: string, options: ForkChatOptions = {}): Chat {
    const fork = this.db.transaction((): Chat => {
      const source = stmt<{ chat_id: string; seq: number }>(
        this.db,
        "SELECT chat_id, seq FROM messages WHERE id = ?",
      ).get(fromMessageId);
      if (!source) {
        throw new Error(`fork point message ${fromMessageId} not found`);
      }
      const parent = this.get(source.chat_id);
      if (!parent) {
        throw new Error(`parent chat ${source.chat_id} not found`);
      }
      const id = newId();
      const ts = nowIso();
      const personaId = options.persona_id === undefined ? parent.persona_id : options.persona_id;
      const title =
        options.title ?? (parent.title === null ? "Chat (branch)" : `${parent.title} (branch)`);
      stmt(
        this.db,
        `INSERT INTO chats (id, character_id, persona_id, title, created_at, updated_at, branch_root_id, active_branch, tracker_enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        id,
        parent.character_id,
        personaId,
        title,
        ts,
        ts,
        fromMessageId,
        parent.tracker_enabled ? 1 : 0,
      );
      const history = stmt<MessageCopyRow>(
        this.db,
        `SELECT seq, role, name, content, metadata, created_at FROM messages
         WHERE chat_id = ? AND active = 1 AND seq <= ?
         ORDER BY seq`,
      ).all(parent.id, source.seq);
      const insertCopy = stmt(
        this.db,
        `INSERT INTO messages (id, chat_id, seq, role, name, content, variant_of, active, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
      );
      for (const row of history) {
        insertCopy.run(
          newId(),
          id,
          row.seq,
          row.role,
          row.name,
          row.content,
          row.metadata,
          row.created_at,
        );
      }
      const memories = stmt<SummaryCopyRow>(
        this.db,
        `SELECT level, seq_from, seq_to, summary, tokens, created_at FROM summaries
         WHERE chat_id = ? AND seq_from <= ?
         ORDER BY level, seq_from, rowid`,
      ).all(parent.id, source.seq);
      const insertMemoryCopy = stmt(
        this.db,
        `INSERT INTO summaries (id, chat_id, level, seq_from, seq_to, summary, tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of memories) {
        insertMemoryCopy.run(
          newId(),
          id,
          row.level,
          row.seq_from,
          Math.min(row.seq_to, source.seq),
          row.summary,
          row.tokens,
          row.created_at,
        );
      }
      stmt(this.db, "UPDATE chats SET active_branch = ?, updated_at = ? WHERE id = ?").run(
        id,
        ts,
        parent.id,
      );
      return {
        id,
        character_id: parent.character_id,
        persona_id: personaId,
        title,
        created_at: ts,
        updated_at: ts,
        branch_root_id: fromMessageId,
        active_branch: null,
        // A fork inherits its parent's per-chat tracker switch.
        tracker_enabled: parent.tracker_enabled,
      };
    });
    return fork();
  }
}
