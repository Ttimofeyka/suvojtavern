/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { createRepositories, migrations, openDatabase, runMigrations, st } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { transferRoutes } from "./transfer";

/** Blob dir outside the repo so the avatar import never touches data/. */
const DATA_DIR = "/tmp/opencode/transfer-import-card-png-test";

function makeApp() {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos }), dataDir: DATA_DIR };
  return { app: new Hono().route("/", transferRoutes(deps)), repos };
}

async function postPng(app: Hono, bytes: Uint8Array, onConflict?: string): Promise<Response> {
  const form = new FormData();
  // Copy into a fresh Uint8Array so the File gets an ArrayBuffer-backed body.
  form.append("file", new File([new Uint8Array(bytes)], "card.png", { type: "image/png" }));
  if (onConflict !== undefined) {
    form.append("onConflict", onConflict);
  }
  return app.request("/api/import/card", { method: "POST", body: form });
}

/** A valid 1×1 PNG that carries no card tEXt chunk. */
const BARE_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

describe("POST /api/import/card (PNG)", () => {
  it("round-trips a character through exportCardPng → import (replace)", async () => {
    const { app, repos } = makeApp();
    const character = repos.characters.create({
      name: "Roundtrip",
      description: "a well-travelled card",
      personality: "curious",
      first_mes: "Hello again!",
      alternate_greetings: ["Welcome back!"],
    });
    const res = await postPng(app, await st.exportCardPng(character), "replace");
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      character: typeof character;
      lorebook: unknown;
      renamed: boolean;
    };
    expect(body.renamed).toBe(false);
    expect(body.lorebook).toBeNull(); // card carries no character_book
    expect(body.character.id).toBe(character.id); // replaced in place
    expect(body.character).toMatchObject({
      name: "Roundtrip",
      description: "a well-travelled card",
      personality: "curious",
      first_mes: "Hello again!",
      alternate_greetings: ["Welcome back!"],
    });
    expect(body.character.avatar_path).toMatch(/blobs\/.+\.webp$/); // avatar from the PNG
  });

  it("renames the re-import on conflict instead of erroring", async () => {
    const { app, repos } = makeApp();
    const character = repos.characters.create({ name: "Echo", first_mes: "Ping" });
    const res = await postPng(app, await st.exportCardPng(character), "rename");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ renamed: true, character: { name: "Echo (2)" } });
    expect(repos.characters.list().map((c) => c.name)).toEqual(["Echo", "Echo (2)"]);
  });

  it("rejects a PNG without card data with 400", async () => {
    const { app } = makeApp();
    const res = await postPng(app, BARE_PNG);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "PNG contains no character data (no parseable chara/ccv3 tEXt chunk)",
    });
  });
});
