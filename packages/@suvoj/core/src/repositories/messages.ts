/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { stmt } from "../db/sql";
import {
  type Message,
  type MessageInput,
  type MessageRole,
  messageInputSchema,
} from "../schema/messages";
import { boolToInt, jsonOrNull, newId, nowIso, parseJson } from "../util";
import { type ChatHookBus, chatHooks } from "./hooks";

interface MessageRow {
  id: string;
  chat_id: string;
  seq: number;
  role: string;
  name: string | null;
  content: string;
  variant_of: string | null;
  active: number;
  metadata: string | null;
  created_at: string;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    chat_id: row.chat_id,
    seq: row.seq,
    role: row.role as Message["role"],
    name: row.name,
    content: row.content,
    variant_of: row.variant_of,
    active: row.active === 1,
    metadata: parseJson<Record<string, unknown>>(row.metadata),
    created_at: row.created_at,
  };
}

/**
 * Message persistence with swipe (variant) support.
 *
 * Swipes are sibling rows that share one `variant_of` — the id of the
 * group's first variant — and one `seq` (position in the chat). Exactly one
 * sibling per group is `active = 1`; `listActive` returns the chosen swipe
 * per position in one indexed query, which is THE hot path for prompt
 * building.
 *
 * The repository emits lifecycle hooks (see ./hooks) around writes.
 */
export class MessagesRepository {
  constructor(
    private readonly db: Database,
    private readonly hooks: ChatHookBus = chatHooks,
  ) {}

  /** Appends a message as a new position at the end of the chat. */
  insertMessage(chatId: string, input: MessageInput): Message {
    const data = messageInputSchema.parse(input);
    const message: Message = {
      id: newId(),
      chat_id: chatId,
      seq: this.nextSeq(chatId),
      role: data.role,
      name: data.name,
      content: data.content,
      variant_of: null,
      active: true,
      metadata: data.metadata,
      created_at: nowIso(),
    };
    // beforeInsert listeners may still mutate `message` (e.g. enrich
    // metadata); afterInsert listeners observe the stored state.
    this.hooks.emit("beforeInsert", { chatId, message });
    this.insertRow(message);
    this.touchChat(chatId);
    this.hooks.emit("afterInsert", { chatId, message });
    return message;
  }

  /**
   * Adds a swipe to an existing message group. `siblingGroupId` is the id of
   * any message in the group (the group's first variant or a later sibling —
   * both resolve to the same group). The new variant shares the group's
   * `seq`, is inserted inactive, and becomes the chosen swipe only after
   * {@link setActiveVariant}.
   */
  addVariant(
    chatId: string,
    siblingGroupId: string,
    content: string,
    role: MessageRole = "assistant",
    opts: { name?: string | null; metadata?: Record<string, unknown> | null } = {},
  ): Message {
    const sibling = stmt<{ id: string; seq: number; variant_of: string | null }>(
      this.db,
      "SELECT id, seq, variant_of FROM messages WHERE chat_id = ? AND (id = ? OR variant_of = ?) LIMIT 1",
    ).get(chatId, siblingGroupId, siblingGroupId);
    if (!sibling) {
      throw new Error(`no message group ${siblingGroupId} in chat ${chatId}`);
    }
    // Anchor the swipe to the group ROOT: `siblingGroupId` may be any member
    // of the group (after a regenerate, the last active message is a
    // variant), and pointing at it would chain variants
    // (root ← variant ← variant) instead of keeping the group a star
    // (root ← siblings). The root is the variant_of-null row at the
    // group's position.
    const rootId =
      sibling.variant_of === null
        ? sibling.id
        : (stmt<{ id: string }>(
            this.db,
            "SELECT id FROM messages WHERE chat_id = ? AND seq = ? AND variant_of IS NULL",
          ).get(chatId, sibling.seq)?.id ?? sibling.variant_of);
    const message: Message = {
      id: newId(),
      chat_id: chatId,
      seq: sibling.seq,
      role,
      name: opts.name ?? null,
      content,
      variant_of: rootId,
      active: false,
      metadata: opts.metadata ?? null,
      created_at: nowIso(),
    };
    this.hooks.emit("beforeInsert", { chatId, message });
    this.insertRow(message);
    this.touchChat(chatId);
    this.hooks.emit("afterInsert", { chatId, message });
    return message;
  }

  /**
   * Chooses `messageId` as the active swipe of its group, deactivating
   * every other row at its position. Leaves the chat with exactly one
   * active message per position.
   */
  setActiveVariant(messageId: string): Message {
    const target = this.get(messageId);
    if (!target) {
      throw new Error(`message ${messageId} not found`);
    }
    this.db.transaction(() => {
      // Deactivate by POSITION (seq) rather than group id, so even chained
      // (legacy) rows at this position end up inactive — exactly one
      // active row per position, always.
      stmt(this.db, "UPDATE messages SET active = 0 WHERE chat_id = ? AND seq = ?").run(
        target.chat_id,
        target.seq,
      );
      stmt(this.db, "UPDATE messages SET active = 1 WHERE id = ?").run(messageId);
    })();
    const updated = this.get(messageId);
    if (!updated) {
      throw new Error(`message ${messageId} disappeared while switching variants`);
    }
    return updated;
  }

  /**
   * Returns the full sibling group of `messageId` (the message plus its
   * swipes), group root first, then in creation order.
   */
  listMessageWithSiblings(messageId: string): Message[] {
    const target = this.get(messageId);
    if (!target) {
      return [];
    }
    const groupId = target.variant_of ?? target.id;
    return stmt<MessageRow>(
      this.db,
      `SELECT * FROM messages WHERE chat_id = ? AND (id = ? OR variant_of = ?)
       ORDER BY (variant_of IS NULL) DESC, rowid`,
    )
      .all(target.chat_id, groupId, groupId)
      .map(toMessage);
  }

  /**
   * The prompt-building hot path: the chosen swipe of every position,
   * ordered by `seq` — one indexed query.
   */
  listActive(chatId: string): Message[] {
    return stmt<MessageRow>(
      this.db,
      "SELECT * FROM messages WHERE chat_id = ? AND active = 1 ORDER BY seq",
    )
      .all(chatId)
      .map(toMessage);
  }

  /** Every row of the chat (all swipes), ordered by position then creation. */
  listAll(chatId: string): Message[] {
    return stmt<MessageRow>(this.db, "SELECT * FROM messages WHERE chat_id = ? ORDER BY seq, rowid")
      .all(chatId)
      .map(toMessage);
  }

  /** Pages by position so a swipe group never straddles two responses. */
  listWindow(
    chatId: string,
    options: { before?: number; from?: number; limit?: number },
  ): Message[] {
    return stmt<MessageRow>(
      this.db,
      `SELECT * FROM messages WHERE chat_id = ? AND seq IN (
         SELECT DISTINCT seq FROM messages
         WHERE chat_id = ? AND seq >= ? AND seq < ?
         ORDER BY seq DESC LIMIT ?
       ) ORDER BY seq, rowid`,
    )
      .all(
        chatId,
        chatId,
        options.from ?? 1,
        options.before ?? Number.MAX_SAFE_INTEGER,
        options.limit ?? -1,
      )
      .map(toMessage);
  }

  get(messageId: string): Message | null {
    const row = stmt<MessageRow>(this.db, "SELECT * FROM messages WHERE id = ?").get(messageId);
    return row ? toMessage(row) : null;
  }

  /**
   * Whether any row — any swipe variant — remains at `seq`: the position
   * is only truly gone when this is false (deleting one swipe of a
   * surviving group keeps the position alive).
   */
  positionExists(chatId: string, seq: number): boolean {
    return (
      stmt<{ seq: number }>(
        this.db,
        "SELECT seq FROM messages WHERE chat_id = ? AND seq = ? LIMIT 1",
      ).get(chatId, seq) !== null
    );
  }

  /**
   * Distinct positions that still have rows within `[fromSeq, toSeq]`
   * (inclusive), ascending — the existing-message counterpart of a summary
   * range, used to derive which positions a coverage change unhides.
   */
  listSeqsBetween(chatId: string, fromSeq: number, toSeq: number): number[] {
    return stmt<{ seq: number }>(
      this.db,
      "SELECT DISTINCT seq FROM messages WHERE chat_id = ? AND seq BETWEEN ? AND ? ORDER BY seq",
    )
      .all(chatId, fromSeq, toSeq)
      .map((row) => row.seq);
  }

  /**
   * Rewrites a message's content, and optionally its metadata.
   *
   * `metadata` is tri-state on purpose: `undefined` leaves the column
   * untouched (the text-edit PATCH path must not wipe a row's stored
   * `reasoning`), `null` clears it, an object replaces it wholesale (the
   * continuation path, which folds `regex_applied` into the existing
   * metadata itself before calling this).
   */
  editMessageContent(
    messageId: string,
    content: string,
    metadata?: Record<string, unknown> | null,
  ): Message | null {
    const previous = this.get(messageId);
    if (!previous) {
      return null;
    }
    this.hooks.emit("beforeEdit", { chatId: previous.chat_id, message: previous });
    if (metadata === undefined) {
      stmt(this.db, "UPDATE messages SET content = ? WHERE id = ?").run(content, messageId);
    } else {
      stmt(this.db, "UPDATE messages SET content = ?, metadata = ? WHERE id = ?").run(
        content,
        jsonOrNull(metadata),
        messageId,
      );
    }
    this.touchChat(previous.chat_id);
    // `previous` is a fresh object from `get`, so it cannot alias the stored
    // row; the spread starts from it and then applies exactly the same
    // branch as the SQL above.
    const message: Message = { ...previous, content };
    if (metadata !== undefined) {
      message.metadata = metadata;
    }
    this.hooks.emit("afterEdit", { chatId: previous.chat_id, message, previous });
    return message;
  }

  /**
   * Deletes one message, keeping the swipe group consistent:
   * - deleting the active swipe falls back to the group root;
   * - deleting the group root promotes the oldest sibling to be the new
   *   root (remaining siblings are re-pointed at it) and activates it if the
   *   deleted root was active.
   */
  deleteMessage(messageId: string): boolean {
    const target = this.get(messageId);
    if (!target) {
      return false;
    }
    this.hooks.emit("beforeDelete", { chatId: target.chat_id, message: target });
    this.db.transaction(() => {
      if (target.variant_of === null) {
        const siblings = stmt<MessageRow>(
          this.db,
          "SELECT * FROM messages WHERE variant_of = ? ORDER BY rowid",
        ).all(messageId);
        const promoted = siblings[0];
        if (promoted) {
          stmt(this.db, "UPDATE messages SET variant_of = NULL WHERE id = ?").run(promoted.id);
          stmt(this.db, "UPDATE messages SET variant_of = ? WHERE variant_of = ? AND id != ?").run(
            promoted.id,
            messageId,
            promoted.id,
          );
          if (target.active) {
            stmt(this.db, "UPDATE messages SET active = 1 WHERE id = ?").run(promoted.id);
          }
        }
      } else if (target.active) {
        stmt(this.db, "UPDATE messages SET active = 1 WHERE id = ?").run(target.variant_of);
      }
      stmt(this.db, "DELETE FROM messages WHERE id = ?").run(messageId);
      this.touchChat(target.chat_id);
    })();
    // Emitted only after the transaction committed: afterDelete listeners
    // observe the persisted state (the row is really gone).
    this.hooks.emit("afterDelete", { chatId: target.chat_id, message: target });
    return true;
  }

  /**
   * Deletes a message with every swipe — all rows at the target's chat
   * position (`seq`) — in one transaction. This is the UI's "delete this
   * message" (SillyTavern's trash): the position itself disappears, unlike
   * {@link deleteMessage}, which removes one swipe row and keeps the group.
   * Returns whether any row was removed (false when the id is unknown).
   */
  deleteMessageGroup(messageId: string): boolean {
    const target = this.get(messageId);
    if (!target) {
      return false;
    }
    // Collect the group first so before/afterDelete listeners observe every
    // affected row, exactly like deleteMessage/deleteFromSeq.
    const targets = stmt<MessageRow>(
      this.db,
      "SELECT * FROM messages WHERE chat_id = ? AND seq = ? ORDER BY rowid",
    )
      .all(target.chat_id, target.seq)
      .map(toMessage);
    for (const message of targets) {
      this.hooks.emit("beforeDelete", { chatId: target.chat_id, message });
    }
    const deleted = this.db.transaction(() => {
      const removed = stmt(this.db, "DELETE FROM messages WHERE chat_id = ? AND seq = ?").run(
        target.chat_id,
        target.seq,
      ).changes;
      if (removed > 0) {
        this.touchChat(target.chat_id);
      }
      return removed;
    })();
    // afterDelete fires only after commit, so listeners see the persisted
    // (position-vanished) state — the summary cascade depends on this.
    for (const message of targets) {
      this.hooks.emit("afterDelete", { chatId: target.chat_id, message });
    }
    return deleted > 0;
  }

  /**
   * Deletes every message — all swipe variants included — from `fromSeq` to
   * the end of the chat, in one transaction. This is SillyTavern's "delete
   * this message and everything below". Returns the number of rows removed;
   * a `fromSeq` beyond the last position removes nothing and is not an
   * error.
   */
  deleteFromSeq(chatId: string, fromSeq: number): number {
    // beforeDelete listeners observe each affected row before the write —
    // the same contract {@link deleteMessage} gives single deletions.
    const targets = stmt<MessageRow>(
      this.db,
      "SELECT * FROM messages WHERE chat_id = ? AND seq >= ? ORDER BY seq, rowid",
    )
      .all(chatId, fromSeq)
      .map(toMessage);
    for (const target of targets) {
      this.hooks.emit("beforeDelete", { chatId, message: target });
    }
    const deleted = this.db.transaction(() => {
      const remove = stmt(this.db, "DELETE FROM messages WHERE chat_id = ? AND seq >= ?");
      const deleted = remove.run(chatId, fromSeq).changes;
      if (deleted > 0) {
        this.touchChat(chatId);
      }
      return deleted;
    })();
    // afterDelete listeners see the committed bulk state — every target row
    // is already gone when the first event fires, so a position-removal
    // check (see the summary cascade) sees the whole batch at once.
    for (const target of targets) {
      this.hooks.emit("afterDelete", { chatId, message: target });
    }
    return deleted;
  }

  private insertRow(message: Message): void {
    stmt(
      this.db,
      `INSERT INTO messages (id, chat_id, seq, role, name, content, variant_of, active, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      message.chat_id,
      message.seq,
      message.role,
      message.name,
      message.content,
      message.variant_of,
      boolToInt(message.active),
      jsonOrNull(message.metadata),
      message.created_at,
    );
  }

  /** Next chat position: one past the current maximum seq of any row. */
  private nextSeq(chatId: string): number {
    const row = stmt<{ seq: number }>(
      this.db,
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE chat_id = ?",
    ).get(chatId);
    return (row?.seq ?? 0) + 1;
  }

  /**
   * Refreshes the chat's `updated_at` after a message write, so chat lists
   * (which sort and stamp by most recent activity) stay correct. Raw SQL on
   * the shared db handle rather than a ChatsRepository call: repositories
   * own their statements here (ChatsRepository itself reads the messages
   * table during forks), and the direct UPDATE keeps the timestamp bump
   * inside the caller's transaction.
   */
  private touchChat(chatId: string): void {
    stmt(this.db, "UPDATE chats SET updated_at = ? WHERE id = ?").run(nowIso(), chatId);
  }
}
