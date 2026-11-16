/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { migrations, openDatabase, runMigrations } from "@suvoj/core";
import { createApp } from "./app";
import { seedAll } from "./db/seed";

describe("GET /health", () => {
  it("responds with ok", async () => {
    // Same composition as the server entry (migrate, seed, createApp), but
    // over an in-memory database so the test never touches the live DB.
    // pluginsDir: null keeps it hermetic — without it the app would resolve
    // the repo root's plugins/ folder and activate the example plugin into
    // the process-wide engine registry, making the outcome depend on that
    // folder's contents.
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    seedAll(db);
    const app = createApp(db, { pluginsDir: null });

    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
