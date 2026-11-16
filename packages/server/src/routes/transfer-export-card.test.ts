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

function seedCharacter(repos: Repositories) {
  return repos.characters.create({
    name: "Seraphina",
    description: "a moonlit guide",
    first_mes: "Hello, dear traveler!",
    alternate_greetings: ["Hi!", "Hey there!"],
  });
}

describe("GET /api/export/card/:id", () => {
  it("exports a PNG attachment by default", async () => {
    const { app, repos } = makeApp();
    const character = seedCharacter(repos);
    const res = await app.request(`/api/export/card/${character.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Seraphina.png"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  });

  it("?format=json exports the native shape (not V2-wrapped)", async () => {
    const { app, repos } = makeApp();
    const character = seedCharacter(repos);
    const res = await app.request(`/api/export/card/${character.id}?format=json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Seraphina.json"');
    expect(await res.json()).toMatchObject({
      id: character.id,
      name: "Seraphina",
      description: "a moonlit guide",
      first_mes: "Hello, dear traveler!",
      alternate_greetings: ["Hi!", "Hey there!"],
      card_raw: null, // repo-created characters carry no raw card
    });
  });

  it("returns 404 for an unknown character", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/export/card/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "character nope not found" });
  });
});
