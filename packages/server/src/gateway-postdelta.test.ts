/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { createGateway } from "./gateway";
import { type Endpoint, GatewayError } from "./gateway-shared";

const enc = (s: string) => new TextEncoder().encode(s);

/** A keyless endpoint on the stub host this file's fetch answers. */
const stubEndpoint: Endpoint = { baseUrl: "https://api.example", apiKey: null };

describe("gateway chatCompletion post-delta stream failure", () => {
  it("rejects with GatewayError 502 when the stream errors after a delta", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    const fetchImpl = Object.assign(
      async () => {
        let pulled = false;
        return new Response(
          new ReadableStream({
            pull(c) {
              if (!pulled) {
                pulled = true;
                c.enqueue(enc('data {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
              } else {
                c.error(new Error("boom"));
              }
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
      { preconnect: () => {} },
    );

    const gateway = createGateway({ repos, fetchImpl });

    const deltas: string[] = [];
    let caught: unknown;
    try {
      await gateway.chatCompletion(
        [{ role: "user", content: "hello" }],
        {},
        {
          model: "m",
          endpoint: stubEndpoint,
          onDelta: (d) => deltas.push(d),
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    expect((caught as GatewayError).status).toBe(502);
    expect(deltas).toEqual(["Hi"]);
  });
});
