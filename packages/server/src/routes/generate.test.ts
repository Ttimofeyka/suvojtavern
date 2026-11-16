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

const sse = (): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
        c.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":" there"}}]}\n\n'),
        );
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

describe("POST /api/chats/:id/generate (stream)", () => {
  it("streams statuses, deltas and done, then persists the assistant reply", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    // The generation needs a configured connection profile (its own endpoint
    // + model); the tracker below then runs through it too.
    repos.profiles.create(
      {
        name: "Test",
        base_url: "https://api.example",
        api_key: "sk-test",
        model: "test-model",
      },
      { is_default: true },
    );
    // The tracker is enabled (after_reply) for its `tracking` status below.
    repos.settings.set("tracker_config", { enabled: true });
    const fetchImpl: typeof fetch = Object.assign(async () => sse(), { preconnect: () => {} });
    const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }) };
    const app = new Hono();
    app.route("/", chatsRoutes(deps));
    app.route("/", messagesRoutes(deps));
    app.route("/", generateRoutes(deps));

    const characterId = repos.characters.create({
      name: "Aria",
      first_mes: "Hello!",
      alternate_greetings: ["Hi!", "Hey!"],
    }).id;
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
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseEvents(await res.text());

    // The tracker is explicitly enabled + after_reply: its `tracking`
    // status runs after the reply. The stub upstream returns a plain "Hi
    // there" reply, which is not tracker JSON, so the run fails cleanly into
    // a `tracker` {ok:false} event — the stream (and the persisted reply)
    // are unaffected.
    expect(events.filter((e) => e.type === "status").map((e) => e.stage)).toEqual([
      "preparing",
      "prompt",
      "tracking",
    ]);
    const trackerEvent = events.find((e) => e.type === "tracker") as {
      ok: boolean;
      error: string;
    };
    expect(trackerEvent.ok).toBe(false);
    expect(trackerEvent.error).toContain("Failed to parse tracker response");
    expect(events.filter((e) => e.type === "delta").map((e) => e.content)).toEqual([
      "Hi",
      " there",
    ]);
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ content: "Hi there" });
    expect(typeof done?.message_id).toBe("string");

    const rows = repos.messages.listAll(chat.id);
    const assistant = rows.find((row) => row.role === "assistant" && row.content === "Hi there");
    expect(assistant?.name).toBe("Aria");
  });
});
