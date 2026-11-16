/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { migrations, openDatabase, runMigrations } from "@suvoj/core";
import { isLoopbackHost, lanAddresses, resolveServerConfig } from "./access";
import { createApp } from "./app";
import { seedAll } from "./db/seed";

// Importing this module must stay side-effect-free (`bun test` and other
// tooling walk imports from the repo root): the live database is opened,
// migrated, seeded, and served only when this file runs as the main script.
if (import.meta.main) {
  // Single process-wide connection: migrate, then seed (both idempotent).
  const db = openDatabase();
  runMigrations(db, migrations);
  seedAll(db);
  // Throws on misconfiguration (e.g. a non-loopback HOST without credentials)
  // before any socket opens — the process exits non-zero with the reason.
  const { hostname, port, access } = resolveServerConfig(process.env);
  const app = createApp(db, { access });

  // SSE generation streams sit silent for long stretches (slow first token,
  // retry backoff, post-response summarization); Bun's default 10s idle
  // timeout would drop those connections mid-stream. 255 is Bun's ceiling.
  Bun.serve({ fetch: app.fetch, hostname, port, idleTimeout: 255 });
  const authNote = access.requireAuth ? " (basic auth enabled)" : "";
  console.log(`@suvoj/server listening on http://${hostname}:${port}${authNote}`);
  // When exposed via a wildcard/LAN hostname, tell the operator the concrete
  // URLs to hand out. No detected address is fine — never fail startup for it.
  if (!isLoopbackHost(hostname)) {
    for (const address of lanAddresses()) {
      console.log(`  LAN: http://${address}:${port}`);
    }
  }
}
