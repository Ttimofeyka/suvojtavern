/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Migration } from "../migrate";

/**
 * 010 — rename the persisted built-in tracker mechanism id.
 *
 * The built-in mechanism was renamed `ztracker` → `suvoj-tracker`, and the
 * id is persisted as JSON under the `tracker_config` settings key. A stored
 * config still naming the old id would silently fall back to the built-in on
 * every generation (see the server's tracker service) yet never round-trip,
 * so rewrite it once at migration time instead of aliasing at runtime.
 *
 * Only the single `tracker_config` row is touched, and only when its value is
 * valid JSON whose `mechanism` is exactly `"ztracker"`. `json_extract` raises
 * on malformed JSON, so the `CASE` is what guarantees it runs on valid input
 * only — a corrupt row (or a valid non-legacy one) is left untouched and can
 * never make startup throw.
 */
export const migration010RenameZtrackerMechanism: Migration = {
  id: 10,
  name: "rename_ztracker_mechanism",
  up: (db) => {
    db.exec(`
      UPDATE settings
      SET value = json_set(value, '$.mechanism', 'suvoj-tracker')
      WHERE key = 'tracker_config'
        AND CASE
          WHEN json_valid(value) THEN json_extract(value, '$.mechanism') = 'ztracker'
          ELSE 0
        END;
    `);
  },
};
