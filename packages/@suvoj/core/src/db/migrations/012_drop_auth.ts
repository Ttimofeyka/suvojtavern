/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Migration } from "../migrate";

/**
 * 012 — drop the `auth` table.
 *
 * It held the Suvoj device-authorization flow (pending device codes + granted
 * access tokens). Device auth is gone: a connection profile now carries its
 * own `base_url` and optional `api_key`, so no server-level credential store
 * remains. `001_init` still creates the table; this migration is the only one
 * that drops it, and `IF EXISTS` keeps the drop idempotent on a re-run.
 */
export const migration012DropAuth: Migration = {
  id: 12,
  name: "drop_auth",
  up: (db) => {
    db.exec("DROP TABLE IF EXISTS auth;");
  },
};
