/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Migration } from "../migrate";

/**
 * 011 — per-chat tracker switch.
 *
 * `chats.tracker_enabled` is the in-chat half of the tracker's two-switch
 * model: the global `tracker_config.enabled` setting remains the master
 * switch, and this column lets a single chat opt out (or back in) without
 * touching the global config. Defaults to 1 (enabled) so every existing chat
 * keeps tracking exactly as before; the effective state is
 * `global.enabled && chat.tracker_enabled`.
 */
export const migration011ChatTrackerEnabled: Migration = {
  id: 11,
  name: "chat_tracker_enabled",
  up: (db) => {
    db.exec("ALTER TABLE chats ADD COLUMN tracker_enabled INTEGER NOT NULL DEFAULT 1;");
  },
};
