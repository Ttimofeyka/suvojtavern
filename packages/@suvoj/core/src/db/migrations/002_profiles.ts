/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Migration } from "../migrate";

/**
 * 002 — connection profiles.
 *
 * One row per connection profile: a model plus the sampler settings that
 * replace the preset's at generation time (presets keep the prompt layout
 * only). `is_default` marks the fallback active profile; it is created by
 * seeding and cannot be deleted through the API.
 */
export const migration002Profiles: Migration = {
  id: 2,
  name: "connection_profiles",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS connection_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        sampling TEXT NOT NULL DEFAULT '{}',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};
