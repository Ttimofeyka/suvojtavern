/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Persona } from "@suvoj/core";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { personasRoutes } from "./personas";

let app: Hono;

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = {
    repos,
    gateway: createGateway({ repos }),
  };
  app = new Hono();
  app.route("/", personasRoutes(deps));
});

async function createPersona(body: unknown): Promise<Persona> {
  const res = await app.request("/api/personas", jsonInit("POST", body));
  expect(res.status).toBe(201);
  return (await res.json()) as Persona;
}

describe("personas routes", () => {
  it("creates a persona with defaults applied, lists and gets it", async () => {
    const bob = await createPersona({ name: "Bob" });
    expect(bob).toMatchObject({ name: "Bob", description: "", avatar_path: null });
    await createPersona({ name: "Alice", description: "kind" });

    const list = (await (await app.request("/api/personas")).json()) as Persona[];
    expect(list.map((persona) => persona.name)).toEqual(["Alice", "Bob"]);

    const got = (await (await app.request(`/api/personas/${bob.id}`)).json()) as Persona;
    expect(got).toMatchObject({ id: bob.id, name: "Bob", description: "" });
  });

  it("rejects an invalid create body", async () => {
    const res = await app.request("/api/personas", jsonInit("POST", { description: "no name" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid request body" });
  });

  it("returns 404 for an unknown persona", async () => {
    const res = await app.request("/api/personas/missing");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "persona not found" });
  });

  it("patches partially, preserving unmentioned fields", async () => {
    const bob = await createPersona({
      name: "Bob",
      description: "original",
      avatar_path: "a.png",
    });
    const res = await app.request(`/api/personas/${bob.id}`, jsonInit("PATCH", { name: "Bobby" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: bob.id,
      name: "Bobby",
      description: "original",
      avatar_path: "a.png",
    });
  });

  it("patches unknown personas with 404", async () => {
    const res = await app.request("/api/personas/missing", jsonInit("PATCH", { name: "X" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "persona not found" });
  });

  it("deletes a persona and then it is gone", async () => {
    const bob = await createPersona({ name: "Bob" });
    const res = await app.request(`/api/personas/${bob.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await app.request(`/api/personas/${bob.id}`)).status).toBe(404);
    expect((await app.request(`/api/personas/${bob.id}`, { method: "DELETE" })).status).toBe(404);
  });
});

/** 1×1 transparent PNG. */
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** Upload tests write real blobs — keep them out of the repo's ./data. */
const dataDir = await mkdtemp(path.join(tmpdir(), "suvoj-personas-"));
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** App like the shared beforeEach builds, but with an isolated dataDir. */
function makeAvatarApp(): Hono {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos }), dataDir };
  return new Hono().route("/", personasRoutes(deps));
}

/** Uploads `bytes` as the multipart `file` for a persona avatar. */
async function uploadAvatar(app: Hono, bytes: Uint8Array<ArrayBuffer> = png): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([bytes], "avatar.png", { type: "image/png" }));
  return app.request("/api/personas/avatar", { method: "POST", body: form });
}

describe("POST /api/personas/avatar", () => {
  it("stores a webp blob and returns its path", async () => {
    const res = await uploadAvatar(makeAvatarApp());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { avatar_path: string };
    expect(body.avatar_path.endsWith(".webp")).toBe(true);
    expect(existsSync(body.avatar_path)).toBe(true);
  });

  it("400 for a missing, empty, or undecodable file", async () => {
    const app = makeAvatarApp();
    const noFile = new FormData();
    noFile.append("other", "x");
    expect(
      (await app.request("/api/personas/avatar", { method: "POST", body: noFile })).status,
    ).toBe(400);
    expect((await uploadAvatar(app, new Uint8Array())).status).toBe(400);
    expect((await uploadAvatar(app, new Uint8Array(Buffer.from("no image")))).status).toBe(400);
  });
});
