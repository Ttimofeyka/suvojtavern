/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { assignSql, stmt } from "../db/sql";
import { type Summary, type SummaryInput, summaryInputSchema } from "../schema/summaries";
import { newId, nowIso } from "../util";

interface SummaryRow {
  id: string;
  chat_id: string;
  level: number;
  seq_from: number;
  seq_to: number;
  summary: string;
  tokens: number | null;
  created_at: string;
}

function toSummary(row: SummaryRow): Summary {
  return {
    id: row.id,
    chat_id: row.chat_id,
    level: row.level,
    seq_from: row.seq_from,
    seq_to: row.seq_to,
    summary: row.summary,
    tokens: row.tokens,
    created_at: row.created_at,
  };
}

/**
 * Collapses `seqs` into disjoint ascending `[lo, hi]` ranges so a set of
 * positions becomes a minimal list of OR'ed interval predicates (a
 * contiguous `deleteFromSeq` run collapses to one range).
 */
function toRanges(seqs: number | readonly number[]): Array<[number, number]> {
  const list = (typeof seqs === "number" ? [seqs] : [...new Set(seqs)]).sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const seq of list) {
    const last = ranges[ranges.length - 1];
    if (last && seq <= last[1] + 1) {
      // Overlapping or adjacent: extend the current range (adjacent seqs
      // merge because a summary interval overlapping either overlaps both).
      last[1] = seq;
    } else {
      ranges.push([seq, seq]);
    }
  }
  return ranges;
}

/**
 * The SQL fragment matching summaries whose `[seq_from, seq_to]` range
 * includes at least one seq of the collapsed ranges: plain interval
 * overlap per range, OR'ed together.
 */
function intersectingSql(ranges: ReadonlyArray<readonly [number, number]>): {
  where: string;
  params: number[];
} {
  const params: number[] = [];
  const where = ranges
    .map(([lo, hi]) => {
      params.push(lo, hi);
      return "(seq_to >= ? AND seq_from <= ?)";
    })
    .join(" OR ");
  return { where, params };
}

/** Hierarchical chat memory: level 0 summarizes message ranges, higher levels summarize summaries. */
export class SummariesRepository {
  constructor(private readonly db: Database) {}

  create(chatId: string, input: SummaryInput): Summary {
    const data = summaryInputSchema.parse(input);
    const id = newId();
    const ts = nowIso();
    stmt(
      this.db,
      `INSERT INTO summaries (id, chat_id, level, seq_from, seq_to, summary, tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, chatId, data.level, data.seq_from, data.seq_to, data.summary, data.tokens, ts);
    return { id, chat_id: chatId, ...data, created_at: ts };
  }

  get(id: string): Summary | null {
    const row = stmt<SummaryRow>(this.db, "SELECT * FROM summaries WHERE id = ?").get(id);
    return row ? toSummary(row) : null;
  }

  /** Summaries of a chat, coarse-to-fine (level, then message range). */
  list(chatId: string): Summary[] {
    return stmt<SummaryRow>(
      this.db,
      "SELECT * FROM summaries WHERE chat_id = ? ORDER BY level, seq_from, rowid",
    )
      .all(chatId)
      .map(toSummary);
  }

  /**
   * Summaries of ANY level whose `[seq_from, seq_to]` range includes at
   * least one of `seqs` (a single seq or a set — a contiguous
   * `deleteFromSeq` batch collapses to one interval predicate).
   */
  listIntersecting(chatId: string, seqs: number | readonly number[]): Summary[] {
    const ranges = toRanges(seqs);
    if (ranges.length === 0) {
      return [];
    }
    const { where, params } = intersectingSql(ranges);
    return stmt<SummaryRow>(
      this.db,
      `SELECT * FROM summaries WHERE chat_id = ? AND (${where}) ORDER BY level, seq_from, rowid`,
    )
      .all(chatId, ...params)
      .map(toSummary);
  }

  /**
   * Deletes every summary intersecting `seqs` (any level) and returns the
   * removed rows. Collect-then-delete runs inside one transaction so the
   * returned set is exactly what was removed.
   */
  deleteIntersecting(chatId: string, seqs: number | readonly number[]): Summary[] {
    const ranges = toRanges(seqs);
    if (ranges.length === 0) {
      return [];
    }
    const { where, params } = intersectingSql(ranges);
    return this.db.transaction((): Summary[] => {
      const rows = stmt<SummaryRow>(
        this.db,
        `SELECT * FROM summaries WHERE chat_id = ? AND (${where}) ORDER BY level, seq_from, rowid`,
      )
        .all(chatId, ...params)
        .map(toSummary);
      if (rows.length > 0) {
        stmt(this.db, `DELETE FROM summaries WHERE chat_id = ? AND (${where})`).run(
          chatId,
          ...params,
        );
      }
      return rows;
    })();
  }

  /**
   * Deletes every summary of the chat (all levels) and returns the removed
   * rows — the wipe half of the summaries-import replace. Collect-then-
   * delete runs inside one transaction so the returned set is exactly
   * what was removed.
   */
  deleteAllByChat(chatId: string): Summary[] {
    return this.db.transaction((): Summary[] => {
      const rows = this.list(chatId);
      if (rows.length > 0) {
        stmt(this.db, "DELETE FROM summaries WHERE chat_id = ?").run(chatId);
      }
      return rows;
    })();
  }

  /**
   * Atomically REPLACES every summary of the chat with `rows` (ids
   * regenerate — imported ids are ignored): one transaction wraps the wipe
   * and the inserts (nested transactions roll back together), so a failure
   * midway leaves the chat's existing rows untouched. The replace
   * semantics of the summaries-import route — returns the removed and the
   * newly created rows (the lifecycle event's payload).
   */
  replaceChatSummaries(
    chatId: string,
    rows: readonly SummaryInput[],
  ): { deleted: Summary[]; created: Summary[] } {
    return this.db.transaction((): { deleted: Summary[]; created: Summary[] } => {
      const deleted = this.deleteAllByChat(chatId);
      const created = rows.map((row) => this.create(chatId, row));
      return { deleted, created };
    })();
  }

  update(
    id: string,
    patch: Partial<Pick<Summary, "level" | "seq_from" | "seq_to" | "summary" | "tokens">>,
  ): Summary | null {
    const current = this.get(id);
    if (!current) {
      return null;
    }
    const set = assignSql([
      ["level", patch.level],
      ["seq_from", patch.seq_from],
      ["seq_to", patch.seq_to],
      ["summary", patch.summary],
      ["tokens", patch.tokens],
    ]);
    if (!set) {
      return current;
    }
    stmt(this.db, `UPDATE summaries SET ${set.assignments} WHERE id = ?`).run(...set.params, id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return stmt(this.db, "DELETE FROM summaries WHERE id = ?").run(id).changes > 0;
  }
}
