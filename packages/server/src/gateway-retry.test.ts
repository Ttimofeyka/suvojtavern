/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { createGateway } from "./gateway";
import { type Endpoint, GatewayError } from "./gateway-shared";

/** A keyless endpoint on the stub host this file's fetch answers. */
const stubEndpoint: Endpoint = { baseUrl: "https://api.example", apiKey: null };

const sse = (chunks: string[]): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    }),
  );

const successChunks = [
  'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
];

describe("gateway chatCompletion retry", () => {
  it("retries a 429 then succeeds on the second attempt", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    let calls = 0;
    const fetchImpl = Object.assign(
      async () => {
        calls++;
        if (calls === 1) {
          return new Response("busy", { status: 429, headers: { "Retry-After": "0" } });
        }
        return sse(successChunks);
      },
      { preconnect: () => {} },
    );
    const gateway = createGateway({ repos, fetchImpl });

    const result = await gateway.chatCompletion(
      [{ role: "user", content: "hello" }],
      {},
      {
        model: "m",
        endpoint: stubEndpoint,
      },
    );

    expect(result.content).toBe("Hi there");
    expect(calls).toBe(2);
  });

  it("throws GatewayError 400 without fetching when no model is configured", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    let calls = 0;
    const fetchImpl = Object.assign(
      async () => {
        calls++;
        return sse(successChunks);
      },
      { preconnect: () => {} },
    );
    const gateway = createGateway({ repos, fetchImpl });

    let caught: unknown;
    try {
      await gateway.chatCompletion(
        [{ role: "user", content: "hello" }],
        {},
        {
          endpoint: stubEndpoint,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    expect((caught as GatewayError).status).toBe(400);
    expect((caught as GatewayError).message).toBe("No model configured");
    expect(calls).toBe(0);
  });

  it("throws GatewayError 400 without fetching when no profile (endpoint) is configured", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    let calls = 0;
    const fetchImpl = Object.assign(
      async () => {
        calls++;
        return sse(successChunks);
      },
      { preconnect: () => {} },
    );
    const gateway = createGateway({ repos, fetchImpl });

    let caught: unknown;
    try {
      await gateway.chatCompletion([{ role: "user", content: "hello" }], {}, { model: "m" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    expect((caught as GatewayError).status).toBe(400);
    expect((caught as GatewayError).message).toBe("No connection profile configured");
    expect(calls).toBe(0);
  });
});
