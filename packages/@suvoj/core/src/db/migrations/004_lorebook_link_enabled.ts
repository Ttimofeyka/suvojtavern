/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Migration } from "../migrate";

/**
 * 004 — per-character lorebook link enablement.
 *
 * `character_lorebooks.enabled` lets a link be switched off without
 * deleting it (the engine only scans enabled links). The default of 1
 * keeps every existing link active — backward compatible.
 */
export const migration004LorebookLinkEnabled: Migration = {
  id: 4,
  name: "lorebook_link_enabled",
  up: (db) => {
    db.exec(`
      ALTER TABLE character_lorebooks ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
    `);
  },
};
