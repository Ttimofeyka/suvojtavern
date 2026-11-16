/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { createGateway } from "./gateway";
import type { Endpoint } from "./gateway-shared";

/** A keyless endpoint on the stub host this file's fetch answers. */
const stubEndpoint: Endpoint = { baseUrl: "https://api.example", apiKey: null };

describe("gateway chatCompletion abort", () => {
  it("rejects with AbortError when the signal is already aborted", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    const fetchImpl = Object.assign(
      async () => {
        throw new DOMException("Aborted", "AbortError");
      },
      { preconnect: () => {} },
    );
    const gateway = createGateway({ repos, fetchImpl });

    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      await gateway.chatCompletion(
        [{ role: "user", content: "hello" }],
        {},
        {
          signal: controller.signal,
          model: "m",
          endpoint: stubEndpoint,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe("AbortError");
  });
});
