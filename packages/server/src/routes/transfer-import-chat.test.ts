/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { transferRoutes } from "./transfer";

function makeApp() {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos }) };
  return { app: new Hono().route("/", transferRoutes(deps)), repos };
}

/** ST chat JSONL: an assistant line with two swipes (second one active) + a user line. */
const JSONL = [
  JSON.stringify({
    name: "Luna",
    is_user: false,
    send_date: "2024-01-01T00:00:00.000Z",
    mes: "Hello there",
    swipes: ["Hello there", "Hi!"],
    swipe_id: 1,
  }),
  JSON.stringify({ name: "Alex", is_user: true, mes: "Hey", send_date: 1700000000000 }),
].join("\n");

async function postChat(
  app: Hono,
  text: string,
  fields: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([text], "chat.jsonl", { type: "application/x-ndjson" }));
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return app.request("/api/import/chat", { method: "POST", body: form });
}

describe("POST /api/import/chat", () => {
  it("imports JSONL with swipes via character_id", async () => {
    const { app, repos } = makeApp();
    const luna = repos.characters.create({ name: "Luna" });
    const res = await postChat(app, JSONL, { character_id: luna.id });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      chat: { id: string; character_id: string; title: string | null };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.chat).toMatchObject({ character_id: luna.id, title: "chat" }); // file name stem
    expect(body.messages.map((m) => [m.role, m.content])).toEqual([
      ["assistant", "Hi!"], // swipe_id 1 picked the second swipe
      ["user", "Hey"],
    ]);
    // All rows exist: group root + sibling swipe, then the user position.
    expect(repos.messages.listAll(body.chat.id).map((m) => m.content)).toEqual([
      "Hello there",
      "Hi!",
      "Hey",
    ]);
  });

  it("resolves character_name case-insensitively", async () => {
    const { app, repos } = makeApp();
    const luna = repos.characters.create({ name: "Luna" });
    const res = await postChat(app, JSONL, { character_name: "LUNA" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { chat: { character_id: string } };
    expect(body.chat.character_id).toBe(luna.id);
  });

  it("requires a character reference and 404s unknown ones", async () => {
    const { app, repos } = makeApp();
    const luna = repos.characters.create({ name: "Luna" });
    const none = await postChat(app, JSONL);
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({
      error: "either character_id or character_name is required",
    });

    const unknownId = await postChat(app, JSONL, { character_id: "missing" });
    expect(unknownId.status).toBe(404);
    expect(await unknownId.json()).toEqual({ error: "character missing not found" });

    const unknownName = await postChat(app, JSONL, { character_name: "Nobody" });
    expect(unknownName.status).toBe(404);
    expect(await unknownName.json()).toEqual({ error: 'no character named "Nobody"' });
    expect(repos.chats.listByCharacter(luna.id)).toEqual([]); // nothing was created
  });

  it("rejects malformed JSONL with 400", async () => {
    const { app, repos } = makeApp();
    repos.characters.create({ name: "Luna" });
    const res = await postChat(app, "this is not json", { character_name: "Luna" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("JSON") });
  });

  it("skips a real-ST chat_metadata header line", async () => {
    const { app, repos } = makeApp();
    const luna = repos.characters.create({ name: "Luna" });
    const withHeader = [
      JSON.stringify({ chat_metadata: { integrity: "b2394bd8-4378-42bf-9020-0ada0e083f5c" } }),
      JSONL,
    ].join("\n");
    const res = await postChat(app, withHeader, { character_id: luna.id });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      chat: { id: string };
      messages: Array<{ role: string; content: string }>;
    };
    // The header is not a message: only the two real lines come back.
    expect(body.messages).toHaveLength(2);
    expect(body.messages.map((m) => m.content)).toEqual(["Hi!", "Hey"]);
    expect(repos.messages.listAll(body.chat.id).map((m) => m.content)).toEqual([
      "Hello there",
      "Hi!",
      "Hey",
    ]);
  });
});
