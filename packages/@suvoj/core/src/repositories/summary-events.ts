/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Summary } from "../schema/summaries";

/**
 * Summary lifecycle event: fired after summary rows were created or
 * deleted for a chat.
 *
 * - `created`/`deleted` carry the affected rows (never both non-empty today
 *   — creation and deletion are separate flows, but listeners should treat
 *   the lists independently);
 * - `unhiddenSeqs` lists the chat positions whose messages returned to the
 *   live window because the summaries covering them were deleted:
 *   positions inside the deleted rows' ranges that still have message rows
 *   and that no surviving summary covers.
 */
export interface SummaryLifecycleEvent {
  chatId: string;
  created: Summary[];
  deleted: Summary[];
  unhiddenSeqs: number[];
}

export type SummaryLifecycleListener = (event: SummaryLifecycleEvent) => void;

/**
 * Minimal typed event bus for summary lifecycle events, mirroring
 * {@link ./hooks}' ChatHookBus. `emit` is synchronous; a throwing listener
 * propagates to the emitter (the summary deletions are already committed
 * at that point, so the database stays consistent).
 */
export class SummaryEventBus {
  private readonly listeners = new Set<SummaryLifecycleListener>();

  /** Registers a listener and returns a function that unregisters it. */
  register(listener: SummaryLifecycleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Invokes every listener with `event`. */
  emit(event: SummaryLifecycleEvent): void {
    // Snapshot: a listener may register/unregister in reaction to an event.
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  /** Removes every listener (tests only). */
  removeAll(): void {
    this.listeners.clear();
  }
}

/** Default process-wide bus, used by the summary cascade unless one is injected. */
export const summaryEvents = new SummaryEventBus();

/**
 * Registers a summary lifecycle listener on the default bus and returns
 * an unregister function — the summaries counterpart of
 * `registerChatHooks`.
 */
export function registerSummaryHooks(listener: SummaryLifecycleListener): () => void {
  return summaryEvents.register(listener);
}

/**
 * Emits a creation lifecycle event for `created` (empty `deleted` and
 * `unhiddenSeqs` — new summaries only widen coverage, never reveal
 * messages). The summarize flows call this after the rows are stored; a
 * call with no created rows emits nothing.
 */
export function emitSummariesCreated(chatId: string, created: readonly Summary[]): void {
  if (created.length === 0) {
    return;
  }
  summaryEvents.emit({ chatId, created: [...created], deleted: [], unhiddenSeqs: [] });
}
