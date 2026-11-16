/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Chat, Message } from "@suvoj/core";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { chatsRoutes } from "./chats";
import { type MessageGroup, messagesRoutes } from "./messages";

let app: Hono;
let repos: ReturnType<typeof createRepositories>;
let chatId: string;

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos }) };
  app = new Hono();
  app.route("/", chatsRoutes(deps));
  app.route("/", messagesRoutes(deps));
  const characterId = repos.characters.create({
    name: "Sera",
    first_mes: "Greetings, {{user}}.",
    alternate_greetings: ["Yo, {{user}}!"],
  }).id;
  const res = await app.request("/api/chats", jsonInit("POST", { character_id: characterId }));
  const body = (await res.json()) as { chat: Chat };
  chatId = body.chat.id;
});

async function groups(): Promise<MessageGroup[]> {
  return (await (await app.request(`/api/chats/${chatId}/messages`)).json()) as MessageGroup[];
}

/** Posts a message into the test chat, expecting 201. */
async function postMessage(body: unknown): Promise<Message> {
  const res = await app.request(`/api/chats/${chatId}/messages`, jsonInit("POST", body));
  expect(res.status).toBe(201);
  return (await res.json()) as Message;
}

/** The greeting group: root (first_mes) plus one inactive alternate swipe. */
async function greetingIds(): Promise<{ rootId: string; altId: string }> {
  const [first] = await groups();
  const rootId = first?.active_id ?? "";
  const alt = first?.variants.find((variant) => !variant.active);
  expect(alt).toBeDefined();
  return { rootId, altId: alt?.id ?? "" };
}

describe("GET /api/chats/:id/messages", () => {
  it("returns the greeting as one group with exactly one active variant", async () => {
    const [first] = await groups();
    expect(first).toMatchObject({ seq: 1, role: "assistant", name: "Sera" });
    expect(first?.variants.map((variant) => variant.content)).toEqual([
      "Greetings, User.",
      "Yo, User!",
    ]);
    expect(first?.variants.filter((variant) => variant.active).length).toBe(1);
    expect(first?.active_id).toBe(first?.variants.find((variant) => variant.active)?.id);
    expect((await app.request("/api/chats/missing/messages")).status).toBe(404);
  });

  it("pages by sequence without splitting swipes or counting deleted positions", async () => {
    const deleted = await postMessage({ role: "user", content: "deleted" });
    await postMessage({ role: "assistant", content: "latest" });
    await app.request(`/api/messages/${deleted.id}`, { method: "DELETE" });
    const url = `/api/chats/${chatId}/messages`;
    const latest = (await (await app.request(`${url}?limit=1`)).json()) as MessageGroup[];
    expect(latest.map((group) => group.seq)).toEqual([3]);
    const older = (await (await app.request(`${url}?before=3&limit=1`)).json()) as MessageGroup[];
    expect(older.map((group) => group.seq)).toEqual([1]);
    expect(older[0]?.variants).toHaveLength(2);
    const refreshed = (await (await app.request(`${url}?from=3`)).json()) as MessageGroup[];
    expect(refreshed).toEqual(latest);
    expect((await app.request(`${url}?limit=0`)).status).toBe(400);
  });

  it("stamps every variant with its row's created_at", async () => {
    const message = await postMessage({ role: "user", content: "stamp me" });
    const list = await groups();
    const group = list[list.length - 1];
    expect(group?.variants).toEqual([
      {
        id: message.id,
        content: message.content,
        active: message.active,
        created_at: message.created_at,
        metadata: message.metadata ?? null,
        has_tracker: false,
      },
    ]);
  });

  it("flags has_tracker from the row's snapshots, per swipe", async () => {
    const tracked = await postMessage({ role: "user", content: "track me" });
    const untracked = await postMessage({ role: "user", content: "leave me" });
    // Create the snapshot directly (no generation): the flag is a pure
    // reflection of `tracker_snapshots`, independent of the tracker settings.
    repos.trackers.create(chatId, {
      message_id: tracked.id,
      data: { time: "10:00:00" },
      schema_key: "default",
    });

    const list = await groups();
    const byId = new Map(list.flatMap((g) => g.variants).map((v) => [v.id, v]));
    expect(byId.get(tracked.id)?.has_tracker).toBe(true);
    expect(byId.get(untracked.id)?.has_tracker).toBe(false);
    // Untouched rows — the greeting's active and inactive swipes — stay false.
    const [first] = list;
    expect(first?.variants.every((variant) => variant.has_tracker === false)).toBe(true);
  });
});

describe("POST /api/chats/:id/messages", () => {
  it("appends a message as a new position", async () => {
    const message = await postMessage({ role: "user", content: "my turn" });
    expect(message).toMatchObject({ seq: 2, role: "user", variant_of: null, active: true });
    expect((await groups()).length).toBe(2);

    const unknown = await app.request(
      "/api/chats/missing/messages",
      jsonInit("POST", { role: "user", content: "x" }),
    );
    expect(unknown.status).toBe(404);
    const invalid = await app.request(
      `/api/chats/${chatId}/messages`,
      jsonInit("POST", { content: "no role" }),
    );
    expect(invalid.status).toBe(400);
  });
});

describe("PATCH /api/messages/:id", () => {
  it("edits message content", async () => {
    const message = await postMessage({ role: "assistant", content: "draft" });
    const res = await app.request(
      `/api/messages/${message.id}`,
      jsonInit("PATCH", { content: "final" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: message.id, content: "final" });

    const missing = await app.request("/api/messages/missing", jsonInit("PATCH", { content: "x" }));
    expect(missing.status).toBe(404);
  });
});

describe("POST /api/messages/:id/activate", () => {
  it("flips the active swipe within the group", async () => {
    const { rootId, altId } = await greetingIds();
    const res = await app.request(`/api/messages/${altId}/activate`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [first] = await groups();
    expect(first?.active_id).toBe(altId);
    expect(first?.variants.find((variant) => variant.id === rootId)?.active).toBe(false);
    expect(first?.variants.find((variant) => variant.id === altId)?.active).toBe(true);

    expect((await app.request("/api/messages/missing/activate", { method: "POST" })).status).toBe(
      404,
    );
  });
});

describe("DELETE /api/messages/:id", () => {
  it("deletes the whole message, every swipe at the position", async () => {
    const { rootId, altId } = await greetingIds();
    const res = await app.request(`/api/messages/${rootId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The greeting's sibling swipe goes too — the position itself vanishes,
    // rather than surviving with a promoted root.
    expect(repos.messages.get(rootId)).toBeNull();
    expect(repos.messages.get(altId)).toBeNull();
    expect((await groups()).length).toBe(0);

    expect((await app.request("/api/messages/missing", { method: "DELETE" })).status).toBe(404);
  });
});

describe("POST /api/chats/:id/messages/delete-from", () => {
  it("deletes every swipe variant from a position to the end of the chat", async () => {
    await postMessage({ role: "user", content: "my turn" }); // seq 2
    const reply = await postMessage({ role: "assistant", content: "reply" }); // seq 3
    repos.messages.addVariant(chatId, reply.id, "reply (swipe)"); // second swipe at seq 3

    const res = await app.request(
      `/api/chats/${chatId}/messages/delete-from`,
      jsonInit("POST", { from_seq: 2 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 3 });

    // Everything before the cut survives (the greeting keeps both of its
    // swipes); everything from the cut, swipe variants included, is gone.
    const remaining = await groups();
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.seq).toBe(1);
    expect(remaining[0]?.variants).toHaveLength(2);
    expect(repos.messages.get(reply.id)).toBeNull();

    // A position beyond the last one deletes nothing and is not an error.
    const none = await app.request(
      `/api/chats/${chatId}/messages/delete-from`,
      jsonInit("POST", { from_seq: 99 }),
    );
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ ok: true, deleted: 0 });
    expect((await groups()).length).toBe(1);
  });

  it("wipes the whole chat, greeting swipes included, when from_seq is 1", async () => {
    const res = await app.request(
      `/api/chats/${chatId}/messages/delete-from`,
      jsonInit("POST", { from_seq: 1 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 2 });
    expect(await groups()).toEqual([]);
  });

  it("404s on an unknown chat and 400s on an invalid from_seq", async () => {
    const unknown = await app.request(
      "/api/chats/missing/messages/delete-from",
      jsonInit("POST", { from_seq: 1 }),
    );
    expect(unknown.status).toBe(404);

    for (const body of [{ from_seq: 0 }, { from_seq: 1.5 }, {}]) {
      const invalid = await app.request(
        `/api/chats/${chatId}/messages/delete-from`,
        jsonInit("POST", body),
      );
      expect(invalid.status).toBe(400);
    }
  });
});
