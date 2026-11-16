/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Migration } from "../migrate";

/**
 * 006 — per-profile custom endpoints.
 *
 * `connection_profiles.base_url` is the whole profile's API base (a
 * user-configured OpenAI-compatible endpoint); the empty string means "no
 * endpoint", so endpoint resolution fails with a clean 400 until one is set —
 * existing rows are left as they are by this migration. `api_key` is the
 * per-profile bearer token for that endpoint, stored plaintext (same trust
 * model as the rest of the local SQLite DB) but never returned by the API —
 * the read shape exposes only `has_api_key`. Two ALTERs, each inside the
 * migration runner's transaction.
 */
export const migration006ProfileEndpoints: Migration = {
  id: 6,
  name: "profile_endpoints",
  up: (db) => {
    db.exec("ALTER TABLE connection_profiles ADD COLUMN base_url TEXT NOT NULL DEFAULT '';");
    db.exec("ALTER TABLE connection_profiles ADD COLUMN api_key TEXT NOT NULL DEFAULT '';");
  },
};
