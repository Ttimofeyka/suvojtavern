/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { Repositories } from "@suvoj/core";
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

/** Character + persona + chat (one swipe group) + one-entry lorebook. */
function seed(repos: Repositories) {
  const character = repos.characters.create({ name: "Seraphina" });
  const persona = repos.personas.create({ name: "Alex" });
  const chat = repos.chats.create({
    character_id: character.id,
    persona_id: persona.id,
    title: "Moonlit talk",
  });
  repos.messages.insertMessage(chat.id, { role: "user", content: "Hi" });
  const greet = repos.messages.insertMessage(chat.id, { role: "assistant", content: "Greetings" });
  const alt = repos.messages.addVariant(chat.id, greet.id, "Salutations");
  repos.messages.setActiveVariant(alt.id);
  const book = repos.lorebooks.create({ name: "World Book" });
  repos.lorebooks.addEntry(book.id, {
    keys: ["moon"],
    content: "The moon is full.",
    comment: "moon facts",
  });
  return { chat, book };
}

describe("GET /api/export/chat/:id", () => {
  it("exports one JSONL line per message group (swipes included)", async () => {
    const { app, repos } = makeApp();
    const { chat } = seed(repos);
    const res = await app.request(`/api/export/chat/${chat.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Moonlit_talk.jsonl"',
    );
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      name: "Alex", // persona name, no stored message name
      is_user: true,
      mes: "Hi",
      user_name: "Alex",
      character_name: "Seraphina",
      swipes: ["Hi"],
    });
    expect(lines[1]).toMatchObject({
      name: "Seraphina",
      is_user: false,
      mes: "Salutations", // the active swipe
      swipe_id: 1,
      swipes: ["Greetings", "Salutations"],
    });
  });

  it("returns 404 for an unknown chat", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/export/chat/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "chat nope not found" });
  });
});

describe("GET /api/export/lorebook/:id", () => {
  it("exports ST world info keyed by uid", async () => {
    const { app, repos } = makeApp();
    const { book } = seed(repos);
    const res = await app.request(`/api/export/lorebook/${book.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="World_Book.json"');
    const body = (await res.json()) as {
      name: string;
      entries: Record<string, Record<string, unknown>>;
    };
    expect(body.name).toBe("World Book");
    expect(Object.keys(body.entries)).toEqual(["0"]); // display_index as uid
    expect(body.entries["0"]).toMatchObject({
      key: ["moon"],
      content: "The moon is full.",
      comment: "moon facts",
    });
  });

  it("returns 404 for an unknown lorebook", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/export/lorebook/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "lorebook nope not found" });
  });
});
