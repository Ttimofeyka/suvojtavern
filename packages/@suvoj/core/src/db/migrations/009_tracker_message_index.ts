/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Migration } from "../migrate";

/**
 * 009 — index on `tracker_snapshots (message_id, chat_id)`.
 *
 * `message_id` leads because the per-message reads (`getForMessage`,
 * `deleteForMessage`) and the correlated "newest per message_id" subqueries
 * filter on `message_id` first; a chat-scoped index would leave those
 * predicates off the leading column, forcing a full scan. `chat_id` is the
 * secondary column so the swipe-aware joins — which also constrain `chat_id`
 * — can use the composite index once the message row is resolved.
 */
export const migration009TrackerMessageIndex: Migration = {
  id: 9,
  name: "tracker_message_index",
  up: (db) => {
    db.exec(
      "CREATE INDEX idx_tracker_snapshots_message ON tracker_snapshots (message_id, chat_id);",
    );
  },
};
