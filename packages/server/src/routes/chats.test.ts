/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Chat } from "@suvoj/core";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { chatsRoutes } from "./chats";
import type { MessageGroup } from "./messages";

let app: Hono;
let repos: ReturnType<typeof createRepositories>;
let characterId: string;
let personaId: string;

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos }) };
  app = new Hono();
  app.route("/", chatsRoutes(deps));
  characterId = repos.characters.create({
    name: "Seraphina",
    first_mes: "Hello {{user}}, I am {{char}}.",
    alternate_greetings: ["Hi {{user}}!", "Hey."],
  }).id;
  personaId = repos.personas.create({ name: "Alice", description: "kind" }).id;
});

interface ChatSummary extends Chat {
  character_name: string;
  character_avatar_path: string | null;
  message_count: number;
  last_preview: string | null;
}

/** Envelope returned by GET /api/chats. `total` ignores limit/offset. */
interface ChatListPage {
  items: ChatSummary[];
  total: number;
  limit: number;
  offset: number;
}

async function createChat(body: unknown): Promise<{ chat: Chat; greeting: MessageGroup | null }> {
  const res = await app.request("/api/chats", jsonInit("POST", body));
  expect(res.status).toBe(201);
  return (await res.json()) as { chat: Chat; greeting: MessageGroup | null };
}

describe("POST /api/chats (greeting parity)", () => {
  it("seeds a macro-evaluated greeting with first_mes active and alternates as swipes", async () => {
    const { chat, greeting } = await createChat({ character_id: characterId });
    expect(chat).toMatchObject({ character_id: characterId, persona_id: null, title: null });

    expect(greeting?.seq).toBe(1);
    expect(greeting?.role).toBe("assistant");
    expect(greeting?.name).toBe("Seraphina");
    expect(greeting?.variants.map((variant) => variant.content)).toEqual([
      "Hello User, I am Seraphina.",
      "Hi User!",
      "Hey.",
    ]);
    const active = greeting?.variants.filter((variant) => variant.active) ?? [];
    expect(active.length).toBe(1);
    expect(greeting?.active_id).toBe(active[0]?.id ?? null);
  });

  it("evaluates {{user}} against the chat's persona", async () => {
    const body = await createChat({ character_id: characterId, persona_id: personaId });
    expect(body.chat.persona_id).toBe(personaId);
    expect(body.greeting?.variants[0]?.content).toBe("Hello Alice, I am Seraphina.");
  });

  it("inserts nothing when first_mes is blank, even with alternate greetings", async () => {
    const quietId = repos.characters.create({
      name: "Mute",
      first_mes: "   ",
      alternate_greetings: ["Hi!"],
    }).id;
    const { chat, greeting } = await createChat({ character_id: quietId });
    expect(greeting).toBeNull();
    expect(repos.messages.listAll(chat.id)).toEqual([]);
    expect(repos.messages.listActive(chat.id)).toEqual([]);
  });

  it("404s on unknown character/persona and 400s on an invalid body", async () => {
    const unknownCharacter = await app.request(
      "/api/chats",
      jsonInit("POST", { character_id: "missing" }),
    );
    expect(unknownCharacter.status).toBe(404);
    expect(await unknownCharacter.json()).toEqual({ error: "character missing not found" });

    const unknownPersona = await app.request(
      "/api/chats",
      jsonInit("POST", { character_id: characterId, persona_id: "missing" }),
    );
    expect(unknownPersona.status).toBe(404);
    expect(await unknownPersona.json()).toEqual({ error: "persona missing not found" });

    expect((await app.request("/api/chats", jsonInit("POST", {}))).status).toBe(400);
  });
});

describe("chat list / get / patch / delete", () => {
  it("lists chats with message_count and a truncated last_preview", async () => {
    const { chat } = await createChat({ character_id: characterId, title: "T" });
    repos.messages.insertMessage(chat.id, { role: "user", content: "x".repeat(205) });

    const body = (await (await app.request("/api/chats")).json()) as ChatListPage;
    expect(body.items.length).toBe(1);
    expect(body.items[0]).toMatchObject({ id: chat.id, message_count: 2 });
    expect(body.items[0]?.last_preview).toBe(`${"x".repeat(200)}...`);
    expect(body).toMatchObject({ total: 1, limit: 100, offset: 0 });

    const query = async (qs: string): Promise<ChatListPage> =>
      (await (await app.request(`/api/chats${qs}`)).json()) as ChatListPage;
    expect((await query(`?character_id=${characterId}`)).items.length).toBe(1);
    expect((await query("?character_id=missing")).items).toEqual([]);

    const got = (await (await app.request(`/api/chats/${chat.id}`)).json()) as Chat;
    expect(got).toMatchObject({ id: chat.id, title: "T" });
    expect((await app.request("/api/chats/missing")).status).toBe(404);
  });

  it("lists summaries carrying their character's name and avatar", async () => {
    const otherId = repos.characters.create({
      name: "Bob",
      first_mes: "Yo.",
      avatar_path: "data/blobs/bob.webp",
    }).id;
    await createChat({ character_id: characterId });
    await createChat({ character_id: characterId }); // second chat, same character
    await createChat({ character_id: otherId });

    const body = (await (await app.request("/api/chats")).json()) as ChatListPage;
    expect(body.items.length).toBe(3);
    for (const summary of body.items) {
      if (summary.character_id === characterId) {
        expect(summary.character_name).toBe("Seraphina");
        expect(summary.character_avatar_path).toBeNull();
      } else {
        expect(summary.character_name).toBe("Bob");
        expect(summary.character_avatar_path).toBe("data/blobs/bob.webp");
      }
    }
  });

  it("pages with limit/offset; total ignores paging", async () => {
    // Newest-updated first; rowid DESC breaks same-millisecond ties, so the
    // listing order is the reverse of creation order here.
    const a = (await createChat({ character_id: characterId, title: "A" })).chat.id;
    const b = (await createChat({ character_id: characterId, title: "B" })).chat.id;
    const c = (await createChat({ character_id: characterId, title: "C" })).chat.id;
    const d = (await createChat({ character_id: characterId, title: "D" })).chat.id;

    const page = async (qs: string): Promise<ChatListPage> =>
      (await (await app.request(`/api/chats${qs}`)).json()) as ChatListPage;

    const first = await page("?limit=2&offset=0");
    expect(first.items.map((chat) => chat.id)).toEqual([d, c]);
    expect(first).toMatchObject({ total: 4, limit: 2, offset: 0 });

    const second = await page("?limit=2&offset=2");
    expect(second.items.map((chat) => chat.id)).toEqual([b, a]);
    expect(second).toMatchObject({ total: 4, limit: 2, offset: 2 });

    // The two slices are disjoint and together cover the whole list.
    const pageIds = new Set([...first.items, ...second.items].map((chat) => chat.id));
    expect(pageIds.size).toBe(4);

    const past = await page("?limit=2&offset=99");
    expect(past.items).toEqual([]);
    expect(past.total).toBe(4);

    // A filtered page's total reflects the filter, not the limit.
    const filtered = await page(`?character_id=${characterId}&limit=1`);
    expect(filtered.items).toHaveLength(1);
    expect(filtered.total).toBe(4);
  });

  it("clamps limit and rejects an invalid limit/offset with 400", async () => {
    await createChat({ character_id: characterId });
    const page = async (qs: string): Promise<ChatListPage> =>
      (await (await app.request(`/api/chats${qs}`)).json()) as ChatListPage;

    expect((await page("?limit=99999")).limit).toBe(500);
    expect((await page("?limit=0")).limit).toBe(1);

    for (const query of ["?limit=abc", "?offset=-1", "?offset=abc"]) {
      const res = await app.request(`/api/chats${query}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Invalid query parameters",
        details: expect.any(Array),
      });
    }

    // Beyond 2^63 Zod still parses it as an int; binding it to OFFSET would
    // throw `datatype mismatch` in bun:sqlite and surface as an unhandled 500.
    expect((await app.request("/api/chats?offset=99999999999999999999")).status).toBe(400);
  });

  it("treats empty query values as absent", async () => {
    await createChat({ character_id: characterId });
    const body = (await (
      await app.request("/api/chats?limit=&offset=&character_id=")
    ).json()) as ChatListPage;
    expect(body).toMatchObject({ total: 1, limit: 100, offset: 0 });
    expect(body.items).toHaveLength(1);
  });

  it("patches title and persona_id with unknown-persona and unknown-chat 404s", async () => {
    const { chat } = await createChat({ character_id: characterId });
    const res = await app.request(
      `/api/chats/${chat.id}`,
      jsonInit("PATCH", { title: "Renamed", persona_id: personaId }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: "Renamed", persona_id: personaId });

    const badPersona = await app.request(
      `/api/chats/${chat.id}`,
      jsonInit("PATCH", { persona_id: "missing" }),
    );
    expect(badPersona.status).toBe(404);
    expect((await app.request("/api/chats/missing", jsonInit("PATCH", { title: "" }))).status).toBe(
      404,
    );
  });

  it("deletes a chat and then it is gone", async () => {
    const { chat } = await createChat({ character_id: characterId });
    const res = await app.request(`/api/chats/${chat.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await app.request(`/api/chats/${chat.id}`)).status).toBe(404);
    expect((await app.request(`/api/chats/${chat.id}`, { method: "DELETE" })).status).toBe(404);
  });
});
