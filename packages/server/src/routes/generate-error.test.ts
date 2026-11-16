/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { chatsRoutes } from "./chats";
import { generateRoutes } from "./generate";
import { messagesRoutes } from "./messages";

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

function setup(fetchImpl: typeof fetch) {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  repos.profiles.create(
    { name: "Test", base_url: "https://api.example", api_key: "sk-test", model: "test-model" },
    { is_default: true },
  );
  const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }) };
  const app = new Hono();
  app.route("/", chatsRoutes(deps));
  app.route("/", messagesRoutes(deps));
  app.route("/", generateRoutes(deps));
  return { app, repos };
}

describe("POST /api/chats/:id/generate (errors)", () => {
  it("emits an error event and persists nothing on upstream failure", async () => {
    const fetchImpl: typeof fetch = Object.assign(
      async () => new Response("boom", { status: 500 }),
      { preconnect: () => {} },
    );
    const { app, repos } = setup(fetchImpl);
    const characterId = repos.characters.create({ name: "Aria", first_mes: "Hello!" }).id;
    const chatRes = await app.request(
      "/api/chats",
      jsonInit("POST", { character_id: characterId }),
    );
    expect(chatRes.status).toBe(201);
    const { chat } = (await chatRes.json()) as { chat: { id: string } };
    const msgRes = await app.request(
      `/api/chats/${chat.id}/messages`,
      jsonInit("POST", { role: "user", content: "Hi Aria" }),
    );
    expect(msgRes.status).toBe(201);
    const before = repos.messages.listAll(chat.id).length;

    const res = await app.request(`/api/chats/${chat.id}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(repos.messages.listAll(chat.id)).toHaveLength(before);
  });

  it("includes upstream status context in the error event message", async () => {
    const fetchImpl: typeof fetch = Object.assign(
      async () => new Response("boom", { status: 500 }),
      { preconnect: () => {} },
    );
    const { app, repos } = setup(fetchImpl);
    const characterId = repos.characters.create({ name: "Aria", first_mes: "Hello!" }).id;
    const chatRes = await app.request(
      "/api/chats",
      jsonInit("POST", { character_id: characterId }),
    );
    expect(chatRes.status).toBe(201);
    const { chat } = (await chatRes.json()) as { chat: { id: string } };
    const msgRes = await app.request(
      `/api/chats/${chat.id}/messages`,
      jsonInit("POST", { role: "user", content: "Hi Aria" }),
    );
    expect(msgRes.status).toBe(201);

    const res = await app.request(`/api/chats/${chat.id}/generate`, jsonInit("POST", {}));
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    const failure = events.find((e) => e.type === "error");
    expect(failure).toBeDefined();
    expect(String(failure?.message)).toContain("upstream 500");
  });

  it("returns 404 for an unknown chat id", async () => {
    const fetchImpl: typeof fetch = Object.assign(async () => new Response("", { status: 500 }), {
      preconnect: () => {},
    });
    const { app } = setup(fetchImpl);
    const res = await app.request("/api/chats/unknown-chat/generate", jsonInit("POST", {}));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "Chat not found" });
  });
});
