/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { variablesRoutes } from "./variables";

/** Stand-in fetch (with Bun's `preconnect` member); never called by these routes. */
const fetchImpl = Object.assign(
  async (): Promise<Response> => new Response("{}", { status: 200 }),
  { preconnect: () => {} },
);

function makeApp() {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }) };
  return { app: new Hono().route("/", variablesRoutes(deps)), repos };
}

const jsonHeaders = { "Content-Type": "application/json" };

async function putVar(app: Hono, pathName: string, body: string): Promise<Response> {
  return app.request(pathName, { method: "PUT", body, headers: jsonHeaders });
}

describe("global variables", () => {
  it("sets, gets, lists, and deletes", async () => {
    const { app } = makeApp();
    expect((await app.request("/api/variables/mood")).status).toBe(404);
    expect(
      (await putVar(app, "/api/variables/mood", JSON.stringify({ value: "happy" }))).status,
    ).toBe(200);
    expect(await (await app.request("/api/variables/mood")).json()).toEqual({ value: "happy" });
    expect(await (await app.request("/api/variables")).json()).toEqual({ mood: "happy" });

    await putVar(app, "/api/variables/list", JSON.stringify({ value: [1, "a"] }));
    expect(await (await app.request("/api/variables")).json()).toEqual({
      mood: "happy",
      list: [1, "a"],
    });

    const del = await app.request("/api/variables/mood", { method: "DELETE" });
    expect(await del.json()).toEqual({ ok: true });
    expect((await app.request("/api/variables/mood")).status).toBe(404);
    expect(await (await app.request("/api/variables")).json()).toEqual({ list: [1, "a"] });
  });

  it("rejects a body without a value with 400", async () => {
    const { app } = makeApp();
    const res = await putVar(app, "/api/variables/x", JSON.stringify({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request body", details: expect.any(Array) });
  });
});

describe("chat-scoped variables", () => {
  it("are isolated from the global scope", async () => {
    const { app, repos } = makeApp();
    const chatId = repos.chats.create({
      character_id: repos.characters.create({ name: "Var" }).id,
    }).id;
    await putVar(app, "/api/variables/shared", JSON.stringify({ value: "global" }));
    expect(
      (
        await putVar(
          app,
          `/api/chats/${chatId}/variables/shared`,
          JSON.stringify({ value: "chat" }),
        )
      ).status,
    ).toBe(200);

    expect(await (await app.request(`/api/chats/${chatId}/variables/shared`)).json()).toEqual({
      value: "chat",
    });
    expect(await (await app.request("/api/variables/shared")).json()).toEqual({ value: "global" });
    expect(await (await app.request(`/api/chats/${chatId}/variables`)).json()).toEqual({
      shared: "chat",
    });
    expect(await (await app.request("/api/variables")).json()).toEqual({ shared: "global" });

    const del = await app.request(`/api/chats/${chatId}/variables/shared`, { method: "DELETE" });
    expect(await del.json()).toEqual({ ok: true });
    expect((await app.request(`/api/chats/${chatId}/variables/shared`)).status).toBe(404);
  });

  it("404 on an unknown chat", async () => {
    const { app } = makeApp();
    expect((await app.request("/api/chats/nope/variables")).status).toBe(404);
    expect((await app.request("/api/chats/nope/variables/k")).status).toBe(404);
    const put = await putVar(app, "/api/chats/nope/variables/k", JSON.stringify({ value: 1 }));
    expect(put.status).toBe(404);
    expect(await put.json()).toEqual({ error: "Chat not found" });
  });
});
