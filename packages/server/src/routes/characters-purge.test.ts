/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { charactersRoutes } from "./characters";

/** Stand-in fetch (with Bun's `preconnect` member): every remote call succeeds. */
const fetchImpl = Object.assign(
  async (): Promise<Response> => new Response("{}", { status: 200 }),
  { preconnect: () => {} },
);

function makeApp() {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }) };
  return { app: new Hono().route("/", charactersRoutes(deps)), repos };
}

const jsonHeaders = { "Content-Type": "application/json" };

async function purge(app: Hono, body: string): Promise<Response> {
  return app.request("/api/characters/purge", { method: "POST", body, headers: jsonHeaders });
}

/** Three characters, the first of which has a chat. */
function seed(repos: ReturnType<typeof createRepositories>) {
  const keep = repos.characters.create({ name: "Keep" });
  const drop1 = repos.characters.create({ name: "Drop1" });
  const drop2 = repos.characters.create({ name: "Drop2" });
  const chat = repos.chats.create({ character_id: keep.id, title: "chat" });
  return { keep, drop1, drop2, chat };
}

describe("POST /api/characters/purge", () => {
  it("without ids, deletes only zero-chat characters", async () => {
    const { app, repos } = makeApp();
    const { keep, drop1, drop2 } = seed(repos);
    const res = await purge(app, "{}");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted_ids).toHaveLength(2);
    expect(body.deleted_ids).toEqual(expect.arrayContaining([drop1.id, drop2.id]));
    expect(body.deleted_ids).not.toContain(keep.id);
    expect(repos.characters.get(keep.id)).not.toBeNull();
    expect(repos.characters.get(drop1.id)).toBeNull();
    expect(repos.characters.get(drop2.id)).toBeNull();
  });

  it("with ids, deletes exactly those (unknown ids ignored) along with their chats", async () => {
    const { app, repos } = makeApp();
    const { keep, chat } = seed(repos);
    const res = await purge(app, JSON.stringify({ ids: [keep.id, "unknown-id"] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted_ids: [keep.id] });
    expect(repos.characters.get(keep.id)).toBeNull();
    expect(repos.chats.get(chat.id)).toBeNull();
    expect(repos.chats.listByCharacter(keep.id)).toEqual([]);
  });

  it("deletes nothing when there is nothing to delete", async () => {
    const { app } = makeApp();
    const res = await purge(app, "{}");
    expect(await res.json()).toEqual({ deleted_ids: [] });
  });

  it("rejects an invalid or missing body with 400", async () => {
    const { app, repos } = makeApp();
    seed(repos);
    const invalid = await purge(app, JSON.stringify({ ids: "not-an-array" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "Invalid request body",
      details: expect.any(Array),
    });
    const empty = await app.request("/api/characters/purge", { method: "POST" });
    expect(empty.status).toBe(400);
    // nothing was deleted by the rejected calls
    const listed = (await (await app.request("/api/characters")).json()) as { items: unknown[] };
    expect(listed.items.length).toBe(3);
  });
});
