/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type ChatHookBus, chatHooks } from "./hooks";
import type { Repositories } from "./index";

/**
 * The message-deletion → tracker-snapshot-deletion cascade.
 *
 * `tracker_snapshots.message_id` is a plain TEXT column with no foreign key
 * (see migration 005), so deleting a message row would otherwise strand its
 * snapshots with a dangling id. Unlike the summary cascade there is NO
 * per-position gate: a summary stands for a whole chat POSITION and must
 * survive while any swipe of that position remains, but a snapshot attaches
 * to ONE exact row. Every deleted row's snapshots must go — deleting one
 * swipe of a group drops that swipe's snapshots while its surviving siblings
 * keep theirs.
 *
 * Batching: a bulk delete (`deleteMessageGroup`, `deleteFromSeq`) emits one
 * `afterDelete` per removed row, so the cascade coalesces ids per chat into a
 * per-microtask batch and runs ONE `deleteForMessages` pass per chat per
 * batch — a `deleteFromSeq` of a thousand rows costs one batched delete, not
 * a thousand. (This is why the repository offers the batch method at all.)
 *
 * Like the summary cascade, the composition root wires this (app.ts) rather
 * than `createRepositories`: tests build throwaway repository sets over one
 * shared default bus, and a listener outliving its database would poison
 * that bus.
 */

export interface TrackerCascadeOptions {
  repos: Repositories;
  /** Chat-hook bus the message repositories emit on; defaults to the process-wide bus. */
  hooks?: ChatHookBus;
}

/**
 * Wires the cascade onto `hooks`: every afterDelete whose payload carries a
 * `message` collects its id into a per-chat, per-microtask batch, and one
 * `deleteForMessages` pass runs per chat per batch. Returns an unregister
 * function.
 *
 * Timing: `afterDelete` fires after the deleting transaction committed, and
 * the pass runs one microtask later still — listeners always observe
 * committed state. A failing pass is logged, never fatal: the queue must not
 * wedge on one broken batch, so the remaining chats' batches still flow.
 */
export function wireTrackerCascade(opts: TrackerCascadeOptions): () => void {
  const hooks = opts.hooks ?? chatHooks;
  const repos = opts.repos;
  // Chat id → deleted message ids of the current microtask batch. `null`
  // while no pass is scheduled.
  let pending: Map<string, Set<string>> | null = null;
  const flush = (): void => {
    const batches = pending;
    pending = null;
    if (!batches) {
      return;
    }
    for (const ids of batches.values()) {
      try {
        repos.trackers.deleteForMessages([...ids]);
      } catch (err) {
        // The message deletions are already committed — log and keep the
        // remaining chats' batches flowing.
        console.error("[tracker-cascade] cascade pass failed:", err);
      }
    }
  };
  return hooks.register({
    afterDelete: ({ chatId, message }) => {
      if (!message) {
        return;
      }
      if (!pending) {
        pending = new Map();
        queueMicrotask(flush);
      }
      let ids = pending.get(chatId);
      if (!ids) {
        ids = new Set();
        pending.set(chatId, ids);
      }
      ids.add(message.id);
    },
  });
}
