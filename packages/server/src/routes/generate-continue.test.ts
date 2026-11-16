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

/**
 * Builds the app the exact way generate-regen.test.ts does: an in-memory
 * migrated DB, a default connection profile (its own endpoint + model), and a
 * stubbed upstream that always streams "Hi there".
 */
async function setup(): Promise<{
  app: Hono;
  repos: ReturnType<typeof createRepositories>;
  characterId: string;
}> {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  repos.profiles.create(
    { name: "Test", base_url: "https://api.example", api_key: "sk-test", model: "test-model" },
    { is_default: true },
  );
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
  return { app, repos, characterId };
}

describe("POST /api/chats/:id/generate (continue)", () => {
  it("appends the generated text to the last assistant message in place", async () => {
    const { app, repos, characterId } = await setup();
    const chatRes = await app.request(
      "/api/chats",
      jsonInit("POST", { character_id: characterId }),
    );
    expect(chatRes.status).toBe(201);
    const { chat, greeting } = (await chatRes.json()) as {
      chat: { id: string };
      greeting: { active_id: string };
    };
    const rootId = greeting.active_id;
    // The greeting group: the active first_mes plus two alternate greetings —
    // three rows, one seq.
    const before = repos.messages.listAll(chat.id);
    expect(before).toHaveLength(3);

    const res = await app.request(
      `/api/chats/${chat.id}/generate`,
      jsonInit("POST", { continue: true }),
    );
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    // The done event carries the FULL merged content — the stored truth the
    // client swaps its live surface to. The continuation is joined with the
    // SillyTavern-style separator so it never starts mid-word.
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ message_id: rootId, content: "Hello! Hi there" });

    // Same message id, same position: the continuation is an edit of the
    // active message, not a new row.
    const rows = repos.messages.listAll(chat.id);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.seq))).toEqual(new Set([1]));
    const merged = repos.messages.get(rootId);
    expect(merged?.content).toBe("Hello! Hi there");
    expect(done?.content).toBe(merged?.content);

    // No new swipe: the alternate greetings are untouched and the group still
    // has exactly one active row.
    expect(rows.filter((row) => row.active)).toHaveLength(1);
    expect(
      rows
        .filter((row) => row.variant_of === rootId)
        .map((row) => row.content)
        .sort(),
    ).toEqual(["Hey!", "Hi!"]);
  });

  it("inserts a separator when the continued text does not already end in whitespace", async () => {
    const { app, repos, characterId } = await setup();
    const chatRes = await app.request(
      "/api/chats",
      jsonInit("POST", { character_id: characterId }),
    );
    const { chat } = (await chatRes.json()) as { chat: { id: string } };
    // "Hello!" ends in punctuation — the continuation must be separated from
    // it, or the reply starts mid-word.
    const seeded = repos.messages.insertMessage(chat.id, {
      role: "assistant",
      name: "Aria",
      content: "Hello!",
    });

    const res = await app.request(
      `/api/chats/${chat.id}/generate`,
      jsonInit("POST", { continue: true }),
    );
    expect(res.status).toBe(200);
    await res.text();

    expect(repos.messages.get(seeded.id)?.content).toBe("Hello! Hi there");
  });

  it("inserts no separator when the continued text already ends in whitespace", async () => {
    const { app, repos, characterId } = await setup();
    const chatRes = await app.request(
      "/api/chats",
      jsonInit("POST", { character_id: characterId }),
    );
    const { chat } = (await chatRes.json()) as { chat: { id: string } };
    // Already separated (trailing space): a second one would show a doubled
    // gap, so the merge must not add it.
    const seeded = repos.messages.insertMessage(chat.id, {
      role: "assistant",
      name: "Aria",
      content: "Half a ",
    });

    const res = await app.request(
      `/api/chats/${chat.id}/generate`,
      jsonInit("POST", { continue: true }),
    );
    expect(res.status).toBe(200);
    await res.text();

    expect(repos.messages.get(seeded.id)?.content).toBe("Half a Hi there");
  });

  it("falls back to a new appended position when the last message is the user's", async () => {
    const { app, repos, characterId } = await setup();
    const chatRes = await app.request(
      "/api/chats",
      jsonInit("POST", { character_id: characterId }),
    );
    const { chat } = (await chatRes.json()) as { chat: { id: string } };
    const msgRes = await app.request(
      `/api/chats/${chat.id}/messages`,
      jsonInit("POST", { role: "user", content: "Hi Aria" }),
    );
    expect(msgRes.status).toBe(201);
    const userMessage = (await msgRes.json()) as { id: string };
    expect(userMessage.id).toBeDefined();
    const before = repos.messages.listAll(chat.id);
    expect(before).toHaveLength(4);

    const res = await app.request(
      `/api/chats/${chat.id}/generate`,
      jsonInit("POST", { continue: true }),
    );
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    // Nothing to extend: the reply lands as a fresh position (a new id and a
    // new seq) instead of editing the user message.
    const rows = repos.messages.listAll(chat.id);
    expect(rows).toHaveLength(5);
    const appended = rows.find((row) => row.role === "assistant" && row.seq > 1);
    expect(appended).toBeDefined();
    expect(appended?.id).not.toBe(userMessage.id);
    expect(appended?.seq).toBe(3);
    expect(appended?.content).toBe("Hi there");
    expect(repos.messages.get(userMessage.id)?.content).toBe("Hi Aria");
    expect(events.find((e) => e.type === "done")).toMatchObject({
      message_id: appended?.id,
      content: "Hi there",
    });
  });

  it("leaves the continued message's existing metadata untouched", async () => {
    const { app, repos, characterId } = await setup();
    const chatRes = await app.request(
      "/api/chats",
      jsonInit("POST", { character_id: characterId }),
    );
    const { chat } = (await chatRes.json()) as { chat: { id: string } };
    // A trailing assistant message that already carries metadata (reasoning
    // from its first half) — the recipient of the continuation.
    const seeded = repos.messages.insertMessage(chat.id, {
      role: "assistant",
      name: "Aria",
      content: "Half a ",
      metadata: { reasoning: "first-half thinking" },
    });

    const res = await app.request(
      `/api/chats/${chat.id}/generate`,
      jsonInit("POST", { continue: true }),
    );
    expect(res.status).toBe(200);
    await res.text();

    // The content merged in place, and the first half's reasoning survived
    // (the continuation writes only text — see persistAssistantMessage).
    const merged = repos.messages.get(seeded.id);
    expect(merged?.content).toBe("Half a Hi there");
    expect(merged?.metadata).toEqual({ reasoning: "first-half thinking" });
  });

  it("gives regenerate precedence when both flags are set", async () => {
    const { app, repos, characterId } = await setup();
    const chatRes = await app.request(
      "/api/chats",
      jsonInit("POST", { character_id: characterId }),
    );
    const { chat, greeting } = (await chatRes.json()) as {
      chat: { id: string };
      greeting: { active_id: string };
    };
    const rootId = greeting.active_id;

    const res = await app.request(
      `/api/chats/${chat.id}/generate`,
      jsonInit("POST", { regenerate: true, continue: true }),
    );
    expect(res.status).toBe(200);
    // Consume the SSE body: the route persists only while the stream runs.
    await res.text();

    // Regenerate won: the reply joined the group as a new active swipe, and
    // the root's content was left alone (a continue would have merged into it).
    const group = repos.messages
      .listAll(chat.id)
      .filter((row) => row.id === rootId || row.variant_of === rootId);
    expect(group).toHaveLength(4);
    expect(new Set(group.map((row) => row.seq)).size).toBe(1);
    expect(group.find((row) => row.id === rootId)?.content).toBe("Hello!");
    const active = group.filter((row) => row.active);
    expect(active).toHaveLength(1);
    expect(active[0]?.content).toBe("Hi there");
  });
});
