/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Migration } from "../migrate";

/**
 * 005 — tracker snapshots.
 *
 * One row per generated tracker state (the Suvoj Tracker surface): the JSON the
 * tracker model produced, the message it was generated after (nullable, so
 * manual/snapshot runs survive message deletion), and a per-chat monotonic
 * `seq` for ordering. `data` is the tracker JSON serialized as TEXT and
 * (de)serialized at the repository boundary; `schema_key` selects the
 * schema preset the snapshot was generated against. Rows cascade with their
 * chat.
 */
export const migration005Tracker: Migration = {
  id: 5,
  name: "tracker_snapshots",
  up: (db) => {
    db.exec(`
      CREATE TABLE tracker_snapshots (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        message_id TEXT,
        seq INTEGER NOT NULL,
        data TEXT NOT NULL,
        schema_key TEXT NOT NULL DEFAULT 'default',
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_tracker_snapshots_chat ON tracker_snapshots (chat_id);
    `);
  },
};
