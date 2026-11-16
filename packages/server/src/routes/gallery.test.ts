/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { galleryRoutes } from "./gallery";

/** 1×1 transparent PNG. */
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const dataDir = await mkdtemp(path.join(tmpdir(), "suvoj-gallery-"));
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** Stand-in fetch (with Bun's `preconnect` member); never called by these routes. */
const fetchImpl = Object.assign(
  async (): Promise<Response> => new Response("{}", { status: 200 }),
  { preconnect: () => {} },
);

function makeApp() {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos, fetchImpl }), dataDir };
  return { app: new Hono().route("/", galleryRoutes(deps)), repos };
}

/** Uploads `bytes` as the multipart `file` for a character. */
async function upload(
  app: Hono,
  characterId: string,
  bytes: Uint8Array<ArrayBuffer> = png,
): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([bytes], "avatar.png", { type: "image/png" }));
  return app.request(`/api/characters/${characterId}/images`, { method: "POST", body: form });
}

async function patch(
  app: Hono,
  characterId: string,
  imageId: string,
  body: unknown,
): Promise<Response> {
  return app.request(`/api/characters/${characterId}/images/${imageId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/characters/:id/images", () => {
  it("stores a webp blob, records it, and auto-sets the avatar on the first image", async () => {
    const { app, repos } = makeApp();
    const character = repos.characters.create({ name: "A" });
    const res = await upload(app, character.id);
    expect(res.status).toBe(201);
    const image = await res.json();
    expect(image).toMatchObject({ character_id: character.id, sort: 0 });
    expect(image.blob_path.endsWith(".webp")).toBe(true);
    expect(existsSync(image.blob_path)).toBe(true);
    expect(repos.characters.get(character.id)?.avatar_path).toBe(image.blob_path);

    const second = await (await upload(app, character.id)).json();
    expect(second.sort).toBe(1);
    expect(repos.characters.get(character.id)?.avatar_path).toBe(image.blob_path);
    expect(await (await app.request(`/api/characters/${character.id}/images`)).json()).toHaveLength(
      2,
    );
  });

  it("400 for a missing, empty, or undecodable file; 404 for an unknown character", async () => {
    const { app, repos } = makeApp();
    const character = repos.characters.create({ name: "C" });
    const noFile = new FormData();
    noFile.append("other", "x");
    expect(
      (
        await app.request(`/api/characters/${character.id}/images`, {
          method: "POST",
          body: noFile,
        })
      ).status,
    ).toBe(400);
    expect((await upload(app, character.id, new Uint8Array())).status).toBe(400);
    expect((await upload(app, character.id, new Uint8Array(Buffer.from("no image")))).status).toBe(
      400,
    );
    expect((await upload(app, "nope")).status).toBe(404);
  });
});

describe("GET/PATCH/DELETE /api/characters/:id/images/:imageId", () => {
  it("switches the avatar via PATCH and falls back on DELETE", async () => {
    const { app, repos } = makeApp();
    const character = repos.characters.create({ name: "D" });
    const first = await (await upload(app, character.id)).json();
    const second = await (await upload(app, character.id)).json();

    const patched = await patch(app, character.id, second.id, { avatar: true, sort: 5 });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ id: second.id, sort: 5 });
    expect(repos.characters.get(character.id)?.avatar_path).toBe(second.blob_path);
    expect((await patch(app, character.id, second.id, { avatar: "yes" })).status).toBe(400);

    // deleting the avatar falls back to the first remaining image…
    await app.request(`/api/characters/${character.id}/images/${second.id}`, { method: "DELETE" });
    expect(repos.characters.get(character.id)?.avatar_path).toBe(first.blob_path);
    // …and to null once the gallery is empty
    await app.request(`/api/characters/${character.id}/images/${first.id}`, { method: "DELETE" });
    expect(repos.characters.get(character.id)?.avatar_path).toBeNull();
    expect(await (await app.request(`/api/characters/${character.id}/images`)).json()).toEqual([]);
  });

  it("404 for unknown characters, images, or foreign images", async () => {
    const { app, repos } = makeApp();
    const owner = repos.characters.create({ name: "E" });
    const other = repos.characters.create({ name: "F" });
    const image = await (await upload(app, owner.id)).json();
    expect((await app.request(`/api/characters/nope/images/${image.id}`)).status).toBe(404);
    expect((await app.request(`/api/characters/${owner.id}/images/nope`)).status).toBe(404);
    expect((await app.request(`/api/characters/${other.id}/images/${image.id}`)).status).toBe(404);
    expect(
      (await app.request(`/api/characters/${other.id}/images/${image.id}`, { method: "DELETE" }))
        .status,
    ).toBe(404);
    expect(repos.characters.getImage(image.id)).not.toBeNull();
  });
});
