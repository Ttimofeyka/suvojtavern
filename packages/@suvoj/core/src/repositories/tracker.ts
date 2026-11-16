/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { stmt } from "../db/sql";
import {
  parseTrackerSnapshot,
  type TrackerSnapshot,
  type TrackerSnapshotInput,
  type TrackerSnapshotRow,
  trackerSnapshotInputSchema,
} from "../schema/tracker";
import { jsonOrNull, newId, nowIso } from "../util";

/**
 * Tracker snapshot persistence (the Suvoj Tracker surface). Snapshots form a
 * per-chat monotonic chain: `create` computes `seq` as the chat's current
 * max + 1 inside the INSERT itself (a single atomic statement, so
 * concurrent writers serialize through SQLite's write lock — no read-then-
 * write race).
 *
 * A snapshot attaches to ONE message row via `message_id` (nullable for
 * legacy/manual runs). A chat position can hold several sibling swipes, so
 * "the tracker of a message" is per swipe ROW, not per position: the
 * SELECTED swipe is the `messages.active = 1` row, and the swipe-aware reads
 * ({@link listForActiveMessages}, {@link listForMessagesBefore}) resolve the
 * newest snapshot attached to that row. `pruneTo` retains the newest
 * snapshot per swipe row across the newest `keepLast` positions.
 */
export class TrackerRepository {
  constructor(private readonly db: Database) {}

  create(chatId: string, input: TrackerSnapshotInput): TrackerSnapshot {
    const data = trackerSnapshotInputSchema.parse(input);
    const id = newId();
    stmt(
      this.db,
      `INSERT INTO tracker_snapshots (id, chat_id, message_id, seq, data, schema_key, created_at)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tracker_snapshots WHERE chat_id = ?), ?, ?, ?)`,
    ).run(id, chatId, data.message_id, chatId, jsonOrNull(data.data), data.schema_key, nowIso());
    const created = this.get(id);
    if (!created) {
      throw new Error(`tracker snapshot ${id} missing after insert`);
    }
    return created;
  }

  get(id: string): TrackerSnapshot | null {
    const row = stmt<TrackerSnapshotRow>(
      this.db,
      "SELECT * FROM tracker_snapshots WHERE id = ?",
    ).get(id);
    return row ? parseTrackerSnapshot(row) : null;
  }

  /** Snapshots of a chat, oldest → newest. */
  listByChat(chatId: string): TrackerSnapshot[] {
    return stmt<TrackerSnapshotRow>(
      this.db,
      "SELECT * FROM tracker_snapshots WHERE chat_id = ? ORDER BY seq, rowid",
    )
      .all(chatId)
      .map(parseTrackerSnapshot);
  }

  /**
   * Swipe-aware injection read: the newest snapshot attached to the SELECTED
   * (active) swipe of each of the chat's newest `limit` POSITIONS, oldest →
   * newest. A position with several swipes contributes only its active row's
   * newest snapshot; positions whose active row has no snapshot are skipped.
   *
   * `limit` pages from the newest position down, so it bounds how many
   * positions (not raw snapshots) are injected. `limit` ≤ 0 → [].
   */
  listForActiveMessages(chatId: string, limit: number): TrackerSnapshot[] {
    if (limit <= 0) {
      return [];
    }
    return (
      stmt<TrackerSnapshotRow>(
        this.db,
        `SELECT t.* FROM tracker_snapshots t
       JOIN messages m ON m.id = t.message_id AND m.chat_id = t.chat_id
       WHERE t.chat_id = ? AND m.active = 1
         AND t.id = (SELECT t2.id FROM tracker_snapshots t2
                     WHERE t2.message_id = t.message_id AND t2.chat_id = t.chat_id
                     ORDER BY t2.seq DESC, t2.rowid DESC LIMIT 1)
       ORDER BY m.seq DESC, t.rowid DESC
       LIMIT ?`,
      )
        .all(chatId, limit)
        // The query pages newest-position-first so LIMIT keeps the newest
        // positions; reverse back into prompt (oldest → newest) order.
        .reverse()
        .map(parseTrackerSnapshot)
    );
  }

  /**
   * Swipe-aware generation read: the same active-swipe selection as
   * {@link listForActiveMessages}, restricted to positions strictly BEFORE
   * `seq` — the "previous trackers" handed to the tracker model. Restricting
   * by POSITION excludes the target message's whole sibling group, since
   * every swipe of it shares the same `seq`. `limit` ≤ 0 → [].
   */
  listForMessagesBefore(chatId: string, seq: number, limit: number): TrackerSnapshot[] {
    if (limit <= 0) {
      return [];
    }
    return stmt<TrackerSnapshotRow>(
      this.db,
      `SELECT t.* FROM tracker_snapshots t
       JOIN messages m ON m.id = t.message_id AND m.chat_id = t.chat_id
       WHERE t.chat_id = ? AND m.active = 1 AND m.seq < ?
         AND t.id = (SELECT t2.id FROM tracker_snapshots t2
                     WHERE t2.message_id = t.message_id AND t2.chat_id = t.chat_id
                     ORDER BY t2.seq DESC, t2.rowid DESC LIMIT 1)
       ORDER BY m.seq DESC, t.rowid DESC
       LIMIT ?`,
    )
      .all(chatId, seq, limit)
      .reverse()
      .map(parseTrackerSnapshot);
  }

  /**
   * The distinct `message_id`s of a chat's snapshots (null ids excluded) —
   * the membership test behind each variant's `has_tracker` flag. Returns a
   * Set so the messages list flags N variants from ONE query; a per-variant
   * existence probe would read the table once per row.
   */
  listTrackedMessageIds(chatId: string): Set<string> {
    const rows = stmt<{ message_id: string }>(
      this.db,
      `SELECT DISTINCT message_id FROM tracker_snapshots
       WHERE chat_id = ? AND message_id IS NOT NULL`,
    ).all(chatId);
    return new Set(rows.map((row) => row.message_id));
  }

  /** The newest snapshot attached to one message row, or null when it has none. */
  getForMessage(messageId: string): TrackerSnapshot | null {
    const row = stmt<TrackerSnapshotRow>(
      this.db,
      `SELECT * FROM tracker_snapshots WHERE message_id = ?
       ORDER BY seq DESC, rowid DESC LIMIT 1`,
    ).get(messageId);
    return row ? parseTrackerSnapshot(row) : null;
  }

  /**
   * Bounded swipe-aware read for the tracker panel's "last turn" fallback:
   * the newest snapshot attached to an ACTIVE row whose position is among the
   * chat's newest `positionCount` POSITIONS. Unlike
   * {@link listForActiveMessages} — which pages from the newest TRACKED
   * position however far back that is — the window here is fixed to raw chat
   * positions and never reaches past it. That window is the point: after the
   * trailing reply is deleted, the panel falls back to the previous turn's
   * tracker rather than some arbitrarily old snapshot that merely happens to
   * be the newest one still attached. The join already drops snapshots whose
   * message row was deleted, and `m.active = 1` drops inactive siblings, so
   * neither needs an extra guard.
   *
   * The newest snapshot per `message_id` is resolved first, so a swipe that
   * was regenerated returns only its current tracker. `positionCount` ≤ 0 →
   * null (SQLite has no `LIMIT` that means "none").
   */
  getLatestWithinLastPositions(chatId: string, positionCount: number): TrackerSnapshot | null {
    if (positionCount <= 0) {
      return null;
    }
    const row = stmt<TrackerSnapshotRow>(
      this.db,
      `SELECT t.* FROM tracker_snapshots t
       JOIN messages m ON m.id = t.message_id AND m.chat_id = t.chat_id
       WHERE t.chat_id = ? AND m.active = 1
         AND m.seq IN (
           SELECT seq FROM messages WHERE chat_id = ?
           GROUP BY seq ORDER BY seq DESC LIMIT ?
         )
         AND t.id = (SELECT t2.id FROM tracker_snapshots t2
                     WHERE t2.message_id = t.message_id AND t2.chat_id = t.chat_id
                     ORDER BY t2.seq DESC, t2.rowid DESC LIMIT 1)
       ORDER BY m.seq DESC, t.rowid DESC
       LIMIT 1`,
    ).get(chatId, chatId, positionCount);
    return row ? parseTrackerSnapshot(row) : null;
  }

  /** Deletes every snapshot attached to one message row; returns the count. */
  deleteForMessage(messageId: string): number {
    return stmt(this.db, "DELETE FROM tracker_snapshots WHERE message_id = ?").run(messageId)
      .changes;
  }

  /**
   * Deletes every snapshot attached to ANY of `messageIds` — the batch form
   * of {@link deleteForMessage}, used by the deletion cascade so a bulk
   * delete costs one statement rather than one per removed row. An empty
   * list is a no-op: SQLite has no empty `IN ()` list.
   */
  deleteForMessages(messageIds: readonly string[]): number {
    if (messageIds.length === 0) {
      return 0;
    }
    const placeholders = messageIds.map(() => "?").join(", ");
    return stmt(this.db, `DELETE FROM tracker_snapshots WHERE message_id IN (${placeholders})`).run(
      ...messageIds,
    ).changes;
  }

  deleteByChat(chatId: string): number {
    return stmt(this.db, "DELETE FROM tracker_snapshots WHERE chat_id = ?").run(chatId).changes;
  }

  /**
   * Swipe-aware retention. Keeps the newest snapshot attached to EACH swipe
   * row of the chat's newest `keepLast` message POSITIONS THAT CARRY A
   * SNAPSHOT, deleting everything else. Counting tracked positions (rather
   * than raw ones) is what makes the default `after_reply` cadence sane:
   * snapshots land on assistant replies only, so the newest raw positions
   * are `[user tail, assistant tail]` and a raw-position window would evict
   * the previous turn's tracker. Paging over tracked positions instead keeps
   * the `keepLast` most recent TRACKED turns.
   *
   * - rows with no `message_id` (legacy/manual runs) always go;
   * - every snapshot at a tracked position older than the newest `keepLast`
   *   tracked `messages.seq` goes — all swipes of that position included;
   * - within a retained position, only the newest snapshot per `message_id`
   *   survives: a swipe's current tracker, not its regeneration history.
   *
   * `keepLast` ≤ 0 is treated as 1: at least the newest tracked position's
   * trackers survive. Unlike the old count-based retention, this is defined
   * per position, so it can drop the chat's globally newest snapshot when
   * that belongs to an inactive swipe at a non-retained position.
   *
   * @returns the number of snapshots deleted.
   */
  pruneTo(chatId: string, keepLast: number): number {
    const keep = Math.max(1, keepLast);
    return stmt(
      this.db,
      `DELETE FROM tracker_snapshots
       WHERE chat_id = ?
         AND (
           message_id IS NULL
           OR message_id NOT IN (
             SELECT m.id FROM messages m
             WHERE m.chat_id = ?
               AND m.seq IN (
                 SELECT tm.seq FROM tracker_snapshots ts
                 JOIN messages tm ON tm.id = ts.message_id AND tm.chat_id = ts.chat_id
                 WHERE ts.chat_id = ?
                 GROUP BY tm.seq ORDER BY tm.seq DESC LIMIT ?
               )
           )
           OR id NOT IN (
             SELECT t2.id FROM tracker_snapshots t2
             WHERE t2.chat_id = ?
               AND t2.id = (
                 SELECT t3.id FROM tracker_snapshots t3
                 WHERE t3.message_id = t2.message_id AND t3.chat_id = t2.chat_id
                 ORDER BY t3.seq DESC, t3.rowid DESC LIMIT 1
               )
           )
         )`,
    ).run(chatId, chatId, chatId, keep, chatId).changes;
  }
}
