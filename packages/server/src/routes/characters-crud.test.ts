/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { charactersRoutes } from "./characters";

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
  return { app: new Hono().route("/", charactersRoutes(deps)), repos };
}

const jsonHeaders = { "Content-Type": "application/json" };

async function post(app: Hono, body: string): Promise<Response> {
  return app.request("/api/characters", { method: "POST", body, headers: jsonHeaders });
}

async function createNamed(app: Hono, name: string): Promise<string> {
  return (await (await post(app, JSON.stringify({ name }))).json()).id;
}

describe("GET /api/characters/:id", () => {
  it("returns the full row for a known id, 404 for unknown", async () => {
    const { app } = makeApp();
    const id = await createNamed(app, "Known");
    const got = await app.request(`/api/characters/${id}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ id, name: "Known", card_raw: null });
    const missing = await app.request("/api/characters/nope");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "character nope not found" });
  });
});

describe("PATCH /api/characters/:id", () => {
  it("patches fields, 400 on an invalid body, 404 when unknown", async () => {
    const { app } = makeApp();
    const id = await createNamed(app, "Patch");
    const patch = await app.request(`/api/characters/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "updated" }),
      headers: jsonHeaders,
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ name: "Patch", description: "updated" });
    const invalid = await app.request(`/api/characters/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: 1 }),
      headers: jsonHeaders,
    });
    expect(invalid.status).toBe(400);
    expect(
      (
        await app.request("/api/characters/nope", {
          method: "PATCH",
          body: "{}",
          headers: jsonHeaders,
        })
      ).status,
    ).toBe(404);
  });
});

describe("PATCH /api/characters/:id absent fields", () => {
  it("leaves defaulted fields untouched when absent from the body", async () => {
    const { app } = makeApp();
    const created = await post(
      app,
      JSON.stringify({
        name: "Keep",
        avatar_path: "data/blobs/x.webp",
        system_prompt: "sys",
        post_history_instructions: "phi",
        card_raw: { foo: "bar" },
      }),
    );
    const { id } = await created.json();

    const patch = await app.request(`/api/characters/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "updated" }),
      headers: jsonHeaders,
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({
      name: "Keep",
      description: "updated",
      avatar_path: "data/blobs/x.webp",
      system_prompt: "sys",
      post_history_instructions: "phi",
    });

    const got = await (await app.request(`/api/characters/${id}`)).json();
    expect(got).toMatchObject({
      avatar_path: "data/blobs/x.webp",
      system_prompt: "sys",
      post_history_instructions: "phi",
    });
    expect(got.card_raw).toEqual({ foo: "bar" });
  });

  it("clears avatar_path when explicitly patched with null", async () => {
    const { app } = makeApp();
    const created = await post(
      app,
      JSON.stringify({
        name: "Clear",
        avatar_path: "data/blobs/x.webp",
        system_prompt: "sys",
        post_history_instructions: "phi",
      }),
    );
    const { id } = await created.json();

    const patch = await app.request(`/api/characters/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ avatar_path: null }),
      headers: jsonHeaders,
    });
    expect(patch.status).toBe(200);
    const body = await patch.json();
    expect(body.avatar_path).toBeNull();
    expect(body.system_prompt).toBe("sys");
    expect(body.post_history_instructions).toBe("phi");
  });

  it("sets avatar_path when explicitly patched with a value", async () => {
    const { app } = makeApp();
    const id = await createNamed(app, "Set");
    const patch = await app.request(`/api/characters/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ avatar_path: "data/blobs/new.webp" }),
      headers: jsonHeaders,
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).avatar_path).toBe("data/blobs/new.webp");
  });
});

describe("DELETE /api/characters/:id", () => {
  it("deletes a character together with its chats", async () => {
    const { app, repos } = makeApp();
    const id = await createNamed(app, "Doomed");
    const chat = repos.chats.create({ character_id: id, title: "chat" });
    const del = await app.request(`/api/characters/${id}`, { method: "DELETE" });
    expect(await del.json()).toEqual({ ok: true });
    expect((await app.request(`/api/characters/${id}`)).status).toBe(404);
    expect(repos.chats.listByCharacter(id)).toEqual([]);
    expect(repos.chats.get(chat.id)).toBeNull();
    expect(await (await app.request("/api/characters")).json()).toMatchObject({
      items: [],
      total: 0,
    });
    expect((await app.request("/api/characters/nope", { method: "DELETE" })).status).toBe(404);
  });
});
