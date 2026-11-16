/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { createGateway } from "./gateway";
import { type Endpoint, GatewayError, resolveEndpoint } from "./gateway-shared";

/** A keyless endpoint on the stub host every fetch here answers. */
const stubEndpoint = (baseUrl = "https://api.example"): Endpoint => ({ baseUrl, apiKey: null });

const sse = (chunks: string[]): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    }),
  );

describe("gateway chatCompletion streaming", () => {
  it("accumulates deltas, fires onDelta in order, and returns finishReason", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    const fetchImpl = Object.assign(
      async () =>
        sse([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" there"},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      { preconnect: () => {} },
    );
    const gateway = createGateway({ repos, fetchImpl });

    const deltas: string[] = [];
    const result = await gateway.chatCompletion(
      [{ role: "user", content: "hello" }],
      {},
      {
        model: "m",
        endpoint: stubEndpoint(),
        onDelta: (d) => deltas.push(d),
      },
    );

    expect(result.content).toBe("Hi there");
    expect(deltas).toEqual(["Hi", " there"]);
    expect(result.finishReason).toBe("stop");
  });

  it("posts to a custom endpoint with its profile key as Bearer", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    const profile = repos.profiles.create({
      name: "Custom",
      base_url: "https://custom.example",
      api_key: "sk-custom",
    });

    const captured: { url: string; auth: string | null } = { url: "", auth: null };
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.url = String(input);
        captured.auth = new Headers(init?.headers).get("Authorization");
        return sse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', "data: [DONE]\n\n"]);
      },
      { preconnect: () => {} },
    );
    const gateway = createGateway({ repos, fetchImpl });

    const result = await gateway.chatCompletion(
      [{ role: "user", content: "hello" }],
      {},
      {
        model: "m",
        endpoint: await resolveEndpoint(repos, profile),
      },
    );

    expect(captured.url).toBe("https://custom.example/v1/chat/completions");
    expect(captured.auth).toBe("Bearer sk-custom");
    expect(result.content).toBe("Hi");
  });

  it("sends reasoning_effort low by default, passes a choice through, and omits it for off", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return sse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', "data: [DONE]\n\n"]);
      },
      { preconnect: () => {} },
    );
    const gateway = createGateway({ repos, fetchImpl });
    const opts = { model: "m", endpoint: stubEndpoint() };

    await gateway.chatCompletion([{ role: "user", content: "hello" }], {}, opts);
    await gateway.chatCompletion(
      [{ role: "user", content: "hello" }],
      { reasoning_effort: "high" },
      opts,
    );
    await gateway.chatCompletion(
      [{ role: "user", content: "hello" }],
      { reasoning_effort: "off" },
      opts,
    );

    expect(bodies.at(0)).toMatchObject({ reasoning_effort: "low" });
    expect(bodies.at(1)).toMatchObject({ reasoning_effort: "high" });
    expect(bodies.at(2)).not.toHaveProperty("reasoning_effort");
  });

  it("sends no Authorization header to a keyless endpoint", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    const captured: { auth: string | null } = { auth: null };
    const fetchImpl = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured.auth = new Headers(init?.headers).get("Authorization");
        return sse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', "data: [DONE]\n\n"]);
      },
      { preconnect: () => {} },
    );
    const gateway = createGateway({ repos, fetchImpl });

    await gateway.chatCompletion(
      [{ role: "user", content: "hello" }],
      {},
      {
        model: "m",
        endpoint: stubEndpoint("http://127.0.0.1:11434"),
      },
    );

    expect(captured.auth).toBeNull();
  });

  it("rejects with a clean 400 and never fetches when no endpoint is configured", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    let calls = 0;
    const fetchImpl = Object.assign(
      async () => {
        calls++;
        return sse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n']);
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
    expect((caught as GatewayError).message).toBe("No connection profile configured");
    expect((caught as GatewayError).status).toBe(400);
    expect(calls).toBe(0);
  });

  it("rejects with the upstream message when the stream emits an error chunk", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    const fetchImpl = Object.assign(
      async () => sse(['data: {"error":{"message":"Error in input stream"}}\n\n']),
      { preconnect: () => {} },
    );
    const gateway = createGateway({ repos, fetchImpl });

    let caught: unknown;
    try {
      await gateway.chatCompletion(
        [{ role: "user", content: "hello" }],
        {},
        {
          model: "m",
          endpoint: stubEndpoint(),
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    expect((caught as GatewayError).message).toBe("Error in input stream");
    expect((caught as GatewayError).status).toBe(502);
    expect((caught as GatewayError).detail).toContain("api.example");
    expect((caught as GatewayError).detail).toContain('{"message":"Error in input stream"}');
  });

  it("keeps the upstream message when an error chunk follows deltas", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    const fetchImpl = Object.assign(
      async () =>
        sse([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          'data: {"error":{"message":"Error in input stream"}}\n\n',
        ]),
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
          endpoint: stubEndpoint(),
          onDelta: (d) => deltas.push(d),
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(deltas).toEqual(["Hi"]);
    expect(caught).toBeInstanceOf(GatewayError);
    expect((caught as GatewayError).message).toBe("Error in input stream");
    expect((caught as GatewayError).status).toBe(502);
    expect((caught as GatewayError).detail).toContain("api.example");
    expect((caught as GatewayError).detail).toContain('{"message":"Error in input stream"}');
  });
});
