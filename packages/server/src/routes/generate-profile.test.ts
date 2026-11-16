/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway, GatewayError } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { chatsRoutes } from "./chats";
import { generateRoutes } from "./generate";
import { makeSummarizeFn } from "./generate-helpers";
import { messagesRoutes } from "./messages";

const sse = (): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
  );

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const parseEvents = (text: string): Record<string, unknown>[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);

/** Captures the last upstream chat-completions request body. */
function captureFetch(): {
  bodies: Record<string, unknown>[];
  fetchImpl: typeof fetch;
} {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = Object.assign(
    async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse();
    },
    { preconnect: () => {} },
  );
  return { bodies, fetchImpl };
}

/** Captures each upstream request's URL + headers (for endpoint assertions). */
function captureRequests(): {
  requests: { url: string; headers: Record<string, string> }[];
  fetchImpl: typeof fetch;
} {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = Object.assign(
    async (url: unknown, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return sse();
    },
    { preconnect: () => {} },
  );
  return { requests, fetchImpl };
}

describe("POST /api/chats/:id/generate with an active connection profile", () => {
  it("sends the active profile's model and samplers upstream", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    repos.profiles.create(
      {
        name: "Default",
        model: "profile-model",
        base_url: "https://api.example",
        api_key: "sk-test",
        sampling: { temperature: 0.5, max_tokens: 123, context_size: 8192, stream: true },
      },
      { is_default: true },
    );
    // The default tracker config is disabled — enable it for this test's
    // after_reply tracker call through the profile.
    repos.settings.set("tracker_config", { enabled: true });

    const { bodies, fetchImpl } = captureFetch();
    const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }) };
    const app = new Hono();
    app.route("/", chatsRoutes(deps));
    app.route("/", messagesRoutes(deps));
    app.route("/", generateRoutes(deps));

    const characterId = repos.characters.create({ name: "Aria", first_mes: "Hello!" }).id;
    const chatRes = await app.request(
      "/api/chats",
      jsonInit("POST", { character_id: characterId }),
    );
    expect(chatRes.status).toBe(201);
    const { chat } = (await chatRes.json()) as { chat: { id: string } };
    await app.request(
      `/api/chats/${chat.id}/messages`,
      jsonInit("POST", { role: "user", content: "Hi" }),
    );

    const res = await app.request(`/api/chats/${chat.id}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());
    expect(events.find((e) => e.type === "done")).toMatchObject({ content: "Hi" });

    // The upstream request carries the profile's model and samplers;
    // the gateway drops context_size/stream from the sampling object.
    // One generation call + one tracker call: the tracker is enabled
    // (after_reply) and a default profile exists, so the tracker
    // generator runs through it after the reply (its "Hi" reply fails the
    // JSON parse — a `tracker` {ok:false} event, the stream is unaffected).
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      model: "profile-model",
      temperature: 0.5,
      max_tokens: 123,
      stream: true,
    });
    expect(bodies[0]?.context_size).toBeUndefined();
    // The tracker call: the profile's samplers with the 0.3 temperature
    // guard, max_tokens overridden by the tracker config's default 8192.
    expect(bodies[1]).toMatchObject({
      model: "profile-model",
      temperature: 0.3,
      max_tokens: 8192,
    });

    // The prompt budget follows the profile's context_size/max_tokens
    // (8192 − 123 minus the assembled prompt's tokens).
    const prompt = events.find((e) => e.stage === "prompt") as
      | { tokenCount?: number; budget?: { context: number; remaining: number } }
      | undefined;
    expect(prompt?.budget?.context).toBe(8192);
    expect(prompt?.budget?.remaining).toBe(8192 - 123 - (prompt?.tokenCount ?? 0));
  });

  it("sends no samplers when the profile carries none (gateway defaults)", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    repos.profiles.create(
      { name: "Default", model: "profile-model", base_url: "https://api.example" },
      { is_default: true },
    );

    const { bodies, fetchImpl } = captureFetch();
    const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }) };
    const app = new Hono();
    app.route("/", chatsRoutes(deps));
    app.route("/", messagesRoutes(deps));
    app.route("/", generateRoutes(deps));

    const characterId = repos.characters.create({ name: "Aria", first_mes: "Hello!" }).id;
    const chatRes = await app.request(
      "/api/chats",
      jsonInit("POST", { character_id: characterId }),
    );
    const { chat } = (await chatRes.json()) as { chat: { id: string } };
    await app.request(
      `/api/chats/${chat.id}/messages`,
      jsonInit("POST", { role: "user", content: "Hi" }),
    );

    const res = await app.request(`/api/chats/${chat.id}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());
    expect(events.find((e) => e.type === "done")).toMatchObject({ content: "Hi" });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: "profile-model" });
    // Empty sampling: the gateway applies its own defaults, so no sampler
    // keys reach the upstream request.
    expect(bodies[0]?.temperature).toBeUndefined();
    expect(bodies[0]?.top_p).toBeUndefined();
    expect(bodies[0]?.max_tokens).toBeUndefined();
  });

  it("routes generation to the profile's custom base_url with its key", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    // A custom profile endpoint uses its own base URL + key.
    repos.profiles.create(
      {
        name: "Custom",
        model: "custom-model",
        base_url: "https://llm.example.com",
        api_key: "sk-custom",
      },
      { is_default: true },
    );

    const { requests, fetchImpl } = captureRequests();
    const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }) };
    const app = new Hono();
    app.route("/", chatsRoutes(deps));
    app.route("/", messagesRoutes(deps));
    app.route("/", generateRoutes(deps));

    const characterId = repos.characters.create({ name: "Aria", first_mes: "Hello!" }).id;
    const chatRes = await app.request(
      "/api/chats",
      jsonInit("POST", { character_id: characterId }),
    );
    const { chat } = (await chatRes.json()) as { chat: { id: string } };
    await app.request(
      `/api/chats/${chat.id}/messages`,
      jsonInit("POST", { role: "user", content: "Hi" }),
    );

    const res = await app.request(`/api/chats/${chat.id}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());
    expect(events.find((e) => e.type === "done")).toMatchObject({ content: "Hi" });

    // The call went to the profile's endpoint with the profile key.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://llm.example.com/v1/chat/completions");
    expect(requests[0]?.headers.Authorization).toBe("Bearer sk-custom");
  });
});

describe("makeSummarizeFn with a connection profile", () => {
  it("applies the profile's model and samplers with the 0.3 temperature guard", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    const { bodies, fetchImpl } = captureFetch();
    const gateway = createGateway({ repos, fetchImpl });
    const summarize = makeSummarizeFn(gateway, {
      profile: { model: "sum-model", sampling: { temperature: 0.9, top_p: 0.8, stream: true } },
      endpoint: { baseUrl: "https://api.example", apiKey: null },
    });

    expect(await summarize("range text")).toBe("Hi");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      model: "sum-model",
      temperature: 0.3,
      top_p: 0.8,
      stream: true, // the gateway's own SSE switch, not the profile's flag
    });
  });

  it("fails cleanly when no endpoint (profile) is configured", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);

    const { bodies, fetchImpl } = captureFetch();
    const gateway = createGateway({ repos, fetchImpl });

    await expect(makeSummarizeFn(gateway)("range text")).rejects.toBeInstanceOf(GatewayError);
    expect(bodies).toHaveLength(0);
  });
});
