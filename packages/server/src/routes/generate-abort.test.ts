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

const jsonInit = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// A rejecting fetch is the accepted proxy for a client disconnect: the
// gateway surfaces the aborted upstream call as a rejected promise.
const mockFetch: typeof fetch = Object.assign(
  async () => Promise.reject(new DOMException("Aborted", "AbortError")),
  { preconnect: () => {} },
);

const db = openDatabase(":memory:");
runMigrations(db, migrations);
const repos = createRepositories(db);
repos.profiles.create(
  { name: "Test", base_url: "https://api.example", api_key: "sk-test", model: "test-model" },
  { is_default: true },
);
const gateway = createGateway({ repos, fetchImpl: mockFetch });
const deps: RouteDeps = { repos, gateway };
const app = new Hono();
app.route("/", chatsRoutes(deps));
app.route("/", messagesRoutes(deps));
app.route("/", generateRoutes(deps));

describe("POST /api/chats/:id/generate (abort)", () => {
  it("ends the stream with no done event and persists nothing", async () => {
    const character = repos.characters.create({ name: "Aria", first_mes: "Hello!" });
    const chatRes = await app.request("/api/chats", jsonInit({ character_id: character.id }));
    expect(chatRes.status).toBe(201);
    const chatId = ((await chatRes.json()) as { chat: { id: string } }).chat.id;
    const msgRes = await app.request(
      `/api/chats/${chatId}/messages`,
      jsonInit({ role: "user", content: "hi" }),
    );
    expect(msgRes.status).toBe(201);

    const before = repos.messages.listAll(chatId).length;

    const res = await app.request(`/api/chats/${chatId}/generate`, jsonInit({}));
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).not.toContain('"type":"done"');
    expect(repos.messages.listAll(chatId).length).toBe(before);
  });
});
