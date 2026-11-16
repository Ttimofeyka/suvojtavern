/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Chat, Message, Summary } from "@suvoj/core";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { chatsRoutes } from "./chats";
import { summariesRoutes } from "./summaries";

let app: Hono;

let repos: ReturnType<typeof createRepositories>;
let characterId: string;
let chatId: string;
let greetingRootId: string;

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  repos = createRepositories(db);
  const deps: RouteDeps = {
    repos,
    gateway: createGateway({ repos }),
  };
  app = new Hono();
  app.route("/", chatsRoutes(deps));
  app.route("/", summariesRoutes(deps));
  characterId = repos.characters.create({
    name: "Seraphina",
    first_mes: "Hello {{user}}, I am {{char}}.",
    alternate_greetings: ["Hi!", "Hey."],
  }).id;
  const res = await app.request("/api/chats", jsonInit("POST", { character_id: characterId }));
  const body = (await res.json()) as { chat: Chat; greeting: { variants: Array<{ id: string }> } };
  chatId = body.chat.id;
  greetingRootId = body.greeting.variants[0]?.id ?? "";
});

describe("POST /api/chats/:id/fork", () => {
  it("copies active messages up to the fork point and links parent and child", async () => {
    repos.messages.insertMessage(chatId, { role: "user", content: "hello" }); // seq 2
    const m3 = repos.messages.insertMessage(chatId, { role: "assistant", content: "hi" });
    repos.messages.insertMessage(chatId, { role: "user", content: "bye" }); // seq 4, not copied

    const res = await app.request(
      `/api/chats/${chatId}/fork`,
      jsonInit("POST", { from_message_id: m3.id }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; chat: Chat };
    expect(body.id).toBe(body.chat.id);
    expect(body.chat).toMatchObject({
      character_id: characterId,
      branch_root_id: m3.id,
      title: "Chat (branch)",
      active_branch: null,
    });

    expect(repos.chats.get(chatId)?.active_branch).toBe(body.id);
    const history = repos.messages.listActive(body.id) as Message[];
    expect(history.map((message) => [message.seq, message.content])).toEqual([
      [1, "Hello User, I am Seraphina."],
      [2, "hello"],
      [3, "hi"],
    ]);
    expect(history.every((message) => message.variant_of === null && message.active)).toBe(true);
    expect(history.some((message) => message.id === greetingRootId)).toBe(false);
    expect(repos.messages.listAll(body.id).length).toBe(3); // inactive swipes not copied
  });

  it("accepts a custom title and a fork from the first message", async () => {
    const m2 = repos.messages.insertMessage(chatId, { role: "user", content: "hello" });
    const res = await app.request(
      `/api/chats/${chatId}/fork`,
      jsonInit("POST", { from_message_id: m2.id, title: "Custom" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; chat: Chat };
    expect(body.chat.title).toBe("Custom");
    expect(repos.messages.listActive(body.id).length).toBe(2);
  });

  it("404s for unknown fork points and messages of other chats", async () => {
    const missing = await app.request(
      `/api/chats/${chatId}/fork`,
      jsonInit("POST", { from_message_id: "missing" }),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "fork point message not found in chat" });

    const otherChat = repos.chats.create({ character_id: characterId });
    const otherMessage = repos.messages.insertMessage(otherChat.id, {
      role: "user",
      content: "hi",
    });
    const cross = await app.request(
      `/api/chats/${chatId}/fork`,
      jsonInit("POST", { from_message_id: otherMessage.id }),
    );
    expect(cross.status).toBe(404);

    const invalid = await app.request(`/api/chats/${chatId}/fork`, jsonInit("POST", {}));
    expect(invalid.status).toBe(400);
  });
});

/** The summaries of a chat as seen through the HTTP API. */
async function listSummaries(id: string): Promise<Summary[]> {
  const res = await app.request(`/api/chats/${id}/summaries`);
  expect(res.status).toBe(200);
  return (await res.json()) as Summary[];
}

describe("POST /api/chats/:id/fork — layered memories", () => {
  /** Seeds greeting (seq 1) plus three messages at seq 2, 3 and 4. */
  function seedMessages(): { m3: Message } {
    repos.messages.insertMessage(chatId, { role: "user", content: "m2" }); // seq 2
    const m3 = repos.messages.insertMessage(chatId, { role: "assistant", content: "m3" }); // seq 3
    repos.messages.insertMessage(chatId, { role: "user", content: "m4" }); // seq 4
    return { m3 };
  }

  it("copies the parent's summaries clamped to the fork point", async () => {
    const { m3 } = seedMessages();
    const a = repos.summaries.create(chatId, {
      level: 0,
      seq_from: 1,
      seq_to: 2,
      summary: "a",
      tokens: null,
    });
    const b = repos.summaries.create(chatId, {
      level: 0,
      seq_from: 3,
      seq_to: 4,
      summary: "b",
      tokens: null,
    });
    const c = repos.summaries.create(chatId, {
      level: 1,
      seq_from: 1,
      seq_to: 4,
      summary: "c",
      tokens: null,
    });

    const res = await app.request(
      `/api/chats/${chatId}/fork`,
      jsonInit("POST", { from_message_id: m3.id }),
    );
    expect(res.status).toBe(201);
    const childId = ((await res.json()) as { id: string }).id;

    const child = await listSummaries(childId);
    expect(child.map((s) => [s.level, s.seq_from, s.seq_to, s.summary])).toEqual([
      [0, 1, 2, "a"],
      [0, 3, 3, "b"], // [3..4] clamped to the fork point (seq 3)
      [1, 1, 3, "c"], // [1..4] clamped to the fork point (seq 3)
    ]);
    expect(child.every((s) => s.chat_id === childId)).toBe(true);
    // Copies are fresh rows: no id is shared with the parent.
    const parentIds = new Set([a.id, b.id, c.id]);
    expect(child.some((s) => parentIds.has(s.id))).toBe(false);
  });

  it("keeps parent and child memories independent", async () => {
    const { m3 } = seedMessages();
    const a = repos.summaries.create(chatId, {
      level: 0,
      seq_from: 1,
      seq_to: 2,
      summary: "a",
      tokens: null,
    });
    const b = repos.summaries.create(chatId, {
      level: 0,
      seq_from: 3,
      seq_to: 4,
      summary: "b",
      tokens: null,
    });

    const res = await app.request(
      `/api/chats/${chatId}/fork`,
      jsonInit("POST", { from_message_id: m3.id }),
    );
    expect(res.status).toBe(201);
    const childId = ((await res.json()) as { id: string }).id;

    // Forking leaves the parent's own memories untouched.
    expect(
      (await listSummaries(chatId)).map((s) => [s.id, s.seq_from, s.seq_to, s.summary]),
    ).toEqual([
      [a.id, 1, 2, "a"],
      [b.id, 3, 4, "b"],
    ]);

    const childBefore = await listSummaries(childId);

    // Deleting a parent memory must not affect the child's copies.
    expect(repos.summaries.delete(a.id)).toBe(true);
    expect((await listSummaries(chatId)).map((s) => s.summary)).toEqual(["b"]);
    expect(await listSummaries(childId)).toEqual(childBefore);
  });

  it("does not copy a summary starting after the fork point", async () => {
    const { m3 } = seedMessages();
    repos.summaries.create(chatId, {
      level: 0,
      seq_from: 1,
      seq_to: 2,
      summary: "before",
      tokens: null,
    });
    repos.summaries.create(chatId, {
      level: 0,
      seq_from: 4,
      seq_to: 4,
      summary: "after",
      tokens: null,
    });

    const res = await app.request(
      `/api/chats/${chatId}/fork`,
      jsonInit("POST", { from_message_id: m3.id }),
    );
    expect(res.status).toBe(201);
    const childId = ((await res.json()) as { id: string }).id;

    expect((await listSummaries(childId)).map((s) => s.summary)).toEqual(["before"]);
  });
});
