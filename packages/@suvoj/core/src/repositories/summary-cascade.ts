/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import type { Summary } from "../schema/summaries";
import { type ChatHookBus, chatHooks } from "./hooks";
import type { Repositories } from "./index";
import type { SummaryLifecycleEvent } from "./summary-events";
import { type SummaryEventBus, summaryEvents } from "./summary-events";

/**
 * The message-deletion → summary-deletion cascade.
 *
 * A summary stands for the messages its `[seq_from, seq_to]` range covers:
 * when a covered position is deleted, every summary of ANY level whose
 * range includes that position must go with it — a summary of messages
 * that no longer exist would keep hiding (and misrepresenting) history.
 * Positions the removed summaries hid but that still have messages then
 * return to the live window ("unhidden").
 *
 * Deletions only cascade when a chat POSITION fully disappears: deleting
 * one swipe of a surviving group keeps the position (and its summaries)
 * alive.
 */

export interface SummaryCascadeOptions {
  /** Shared database handle — wraps each cascade pass in one transaction. */
  db: Database;
  repos: Repositories;
  /** Chat-hook bus the message repositories emit on; defaults to the process-wide bus. */
  hooks?: ChatHookBus;
  /** Bus the summary lifecycle event is emitted on; defaults to the process-wide bus. */
  events?: SummaryEventBus;
}

/** True when some row (any level) covers message position `seq`. */
function coveredByAny(rows: ReadonlyArray<Summary>, seq: number): boolean {
  return rows.some((row) => row.seq_from <= seq && seq <= row.seq_to);
}

/**
 * Runs one cascade pass for the positions in `vanishedSeqs` (already
 * row-less positions — the caller verifies they are really gone):
 * transactionally deletes every summary intersecting any of them and
 * derives the unhidden positions from the DELETED ROWS' RANGES (all
 * levels): every position that still has message rows inside a deleted
 * row's range, minus the positions a SURVIVING summary still covers. The
 * lifecycle event is emitted AFTER the transaction committed (a throwing
 * listener never rolls the deletions back). Returns the emitted event, or
 * null when no summary was affected (nothing deleted, nothing unhidden —
 * no event).
 */
export function applySummaryCascade(
  opts: SummaryCascadeOptions,
  chatId: string,
  vanishedSeqs: readonly number[],
): SummaryLifecycleEvent | null {
  if (vanishedSeqs.length === 0) {
    return null;
  }
  const { db, repos } = opts;
  const events = opts.events ?? summaryEvents;
  const { deleted, unhiddenSeqs } = db.transaction(() => {
    const deleted = repos.summaries.deleteIntersecting(chatId, vanishedSeqs);
    if (deleted.length === 0) {
      return { deleted, unhiddenSeqs: [] as number[] };
    }
    // Range-based unhide, NOT a frontier before/after diff: a mid-range
    // deletion (summary [5-8] dies with message 6 while the [9-12] row
    // holds the old frontier) must return 5, 7, 8 to the live window even
    // though the frontier never moved. Vanished positions have no message
    // rows, so listing what remains inside the deleted ranges already
    // excludes the batch itself.
    const survivors = repos.summaries.list(chatId);
    const unhidden = new Set<number>();
    for (const row of deleted) {
      for (const seq of repos.messages.listSeqsBetween(chatId, row.seq_from, row.seq_to)) {
        if (!coveredByAny(survivors, seq)) {
          unhidden.add(seq);
        }
      }
    }
    return { deleted, unhiddenSeqs: [...unhidden].sort((a, b) => a - b) };
  })();
  if (deleted.length === 0) {
    return null;
  }
  const event: SummaryLifecycleEvent = { chatId, created: [], deleted, unhiddenSeqs };
  events.emit(event);
  return event;
}

export interface SummaryClearOptions {
  repos: Repositories;
  /** Bus the summary lifecycle event is emitted on; defaults to the process-wide bus. */
  events?: SummaryEventBus;
}

/**
 * Clears EVERY summary of `chatId` and emits one summary-lifecycle event
 * carrying the positions that returned to the live window. Unlike
 * {@link applySummaryCascade} this needs no `db`: the wipe is a single
 * repository transaction and no survivor set exists to compare against, so
 * every position that still has message rows inside a deleted row's range
 * is unhidden. Returns the emitted event, or null when the chat had no
 * summaries (nothing deleted, no event).
 */
export function applySummaryClear(
  opts: SummaryClearOptions,
  chatId: string,
): SummaryLifecycleEvent | null {
  const events = opts.events ?? summaryEvents;
  const deleted = opts.repos.summaries.deleteAllByChat(chatId);
  if (deleted.length === 0) {
    return null;
  }
  const unhidden = new Set<number>();
  for (const row of deleted) {
    for (const seq of opts.repos.messages.listSeqsBetween(chatId, row.seq_from, row.seq_to)) {
      unhidden.add(seq);
    }
  }
  const event: SummaryLifecycleEvent = {
    chatId,
    created: [],
    deleted,
    unhiddenSeqs: [...unhidden].sort((a, b) => a - b),
  };
  events.emit(event);
  return event;
}

/**
 * Wires the cascade onto `hooks`: every afterDelete whose chat POSITION
 * fully disappeared collects into a per-microtask batch, and ONE cascade
 * pass runs per batch — one `deleteIntersecting` query, one transaction,
 * one lifecycle event (a `deleteFromSeq` of a thousand rows costs one
 * pass, not a thousand). Returns an unregister function. The composition
 * root calls this once (app.ts) — it is NOT part of `createRepositories`,
 * because tests build throwaway repository sets over one shared default
 * bus, and a listener outliving its database would poison that bus.
 *
 * Timing: `afterDelete` fires after the deleting transaction committed,
 * and the pass runs one microtask later still — listeners always observe
 * committed state. A failing pass (e.g. a throwing event listener) is
 * logged, never fatal: the queue must not wedge on one broken batch.
 */
export function wireSummaryCascade(opts: SummaryCascadeOptions): () => void {
  const hooks = opts.hooks ?? chatHooks;
  const repos = opts.repos;
  // Chat id → vanished positions of the current microtask batch. `null`
  // while no pass is scheduled.
  let pending: Map<string, Set<number>> | null = null;
  const flush = (): void => {
    const batches = pending;
    pending = null;
    if (!batches) {
      return;
    }
    for (const [chatId, seqs] of batches) {
      try {
        applySummaryCascade(opts, chatId, [...seqs]);
      } catch (err) {
        // The deletions of a failed pass are already committed (or the
        // pass failed in a listener) — log and keep the remaining chats'
        // batches flowing.
        console.error("[summary-cascade] cascade pass failed:", err);
      }
    }
  };
  return hooks.register({
    afterDelete: ({ chatId, message }) => {
      if (!message) {
        return;
      }
      // A deleted swipe whose group still has rows keeps the position —
      // its summaries must survive untouched.
      if (repos.messages.positionExists(chatId, message.seq)) {
        return;
      }
      if (!pending) {
        pending = new Map();
        queueMicrotask(flush);
      }
      let seqs = pending.get(chatId);
      if (!seqs) {
        seqs = new Set();
        pending.set(chatId, seqs);
      }
      seqs.add(message.seq);
    },
  });
}
