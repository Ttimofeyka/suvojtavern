/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Lorebook } from "@suvoj/core";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { lorebooksRoutes } from "./lorebooks";

type BookWithEntries = Lorebook & { entries: unknown[] };
type BookWithMeta = Lorebook & { global: boolean; attached_character_count: number };
type AttachedBook = Lorebook & { enabled: boolean };

let app: Hono;
let repos: ReturnType<typeof createRepositories>;

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  repos = createRepositories(db);
  const deps: RouteDeps = {
    repos,
    gateway: createGateway({ repos }),
  };
  app = new Hono();
  app.route("/", lorebooksRoutes(deps));
});

async function createBook(body: unknown): Promise<BookWithEntries> {
  const res = await app.request("/api/lorebooks", jsonInit("POST", body));
  expect(res.status).toBe(201);
  return (await res.json()) as BookWithEntries;
}

async function listBooks(): Promise<BookWithMeta[]> {
  return (await (await app.request("/api/lorebooks")).json()) as BookWithMeta[];
}

describe("lorebook CRUD", () => {
  it("creates a lorebook; GET /:id returns it with its (empty) entries", async () => {
    const book = await createBook({ name: "World", description: "d" });
    expect(book).toMatchObject({ name: "World", description: "d" });
    expect("entries" in book).toBe(false); // entries only on GET /:id

    const got = (await (await app.request(`/api/lorebooks/${book.id}`)).json()) as BookWithEntries;
    expect(got).toMatchObject({ id: book.id, name: "World" });
    expect(got.entries).toEqual([]);

    const list = await listBooks();
    expect(list.map((entry) => entry.id)).toEqual([book.id]);
  });

  it("rejects an invalid create body", async () => {
    const res = await app.request("/api/lorebooks", jsonInit("POST", { description: "no name" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid request body" });
  });

  it("returns 404 for an unknown lorebook", async () => {
    const res = await app.request("/api/lorebooks/missing");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "lorebook not found" });
  });

  it("patches partially, preserving unmentioned fields", async () => {
    const book = await createBook({ name: "World", description: "keep me" });
    const res = await app.request(`/api/lorebooks/${book.id}`, jsonInit("PATCH", { name: "W2" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: book.id,
      name: "W2",
      description: "keep me",
    });
    const missing = await app.request("/api/lorebooks/missing", jsonInit("PATCH", { name: "X" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "lorebook not found" });
  });

  it("deletes a lorebook and then it is gone", async () => {
    const book = await createBook({ name: "World" });
    const res = await app.request(`/api/lorebooks/${book.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await app.request(`/api/lorebooks/${book.id}`)).status).toBe(404);
    expect((await app.request(`/api/lorebooks/${book.id}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("lorebook global flag", () => {
  it("lists books with global=false and a zero attach count by default", async () => {
    const book = await createBook({ name: "World" });
    expect(book).toMatchObject({ global: false, attached_character_count: 0 });
    const list = await listBooks();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: book.id, global: false, attached_character_count: 0 });
  });

  it("toggles the global flag via PATCH /:id/global", async () => {
    const book = await createBook({ name: "World" });
    const res = await app.request(
      `/api/lorebooks/${book.id}/global`,
      jsonInit("PATCH", { enabled: true }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, global: true });
    expect((await listBooks())[0]?.global).toBe(true);

    const off = await app.request(
      `/api/lorebooks/${book.id}/global`,
      jsonInit("PATCH", { enabled: false }),
    );
    expect(off.status).toBe(200);
    expect((await listBooks())[0]?.global).toBe(false);
  });

  it("rejects unknown books and invalid bodies on the global toggle", async () => {
    const missing = await app.request(
      "/api/lorebooks/missing/global",
      jsonInit("PATCH", { enabled: true }),
    );
    expect(missing.status).toBe(404);
    const book = await createBook({ name: "World" });
    const bad = await app.request(
      `/api/lorebooks/${book.id}/global`,
      jsonInit("PATCH", { enabled: 1 }),
    );
    expect(bad.status).toBe(400);
  });

  it("prunes a deleted book from the global ids", async () => {
    const book = await createBook({ name: "World" });
    await app.request(`/api/lorebooks/${book.id}/global`, jsonInit("PATCH", { enabled: true }));
    expect(repos.settings.get<{ ids: string[] }>("lorebooks:global")).toEqual({ ids: [book.id] });
    await app.request(`/api/lorebooks/${book.id}`, { method: "DELETE" });
    // The settings key no longer carries the deleted id.
    expect(repos.settings.get<{ ids: string[] }>("lorebooks:global")).toEqual({ ids: [] });
  });
});

describe("character lorebook links", () => {
  it("lists a character's books with their enabled state", async () => {
    const book = await createBook({ name: "World" });
    const character = repos.characters.create({ name: "Alice" });
    await app.request(
      `/api/lorebooks/${book.id}/attach`,
      jsonInit("POST", { character_id: character.id }),
    );

    const missing = await app.request("/api/characters/missing/lorebooks");
    expect(missing.status).toBe(404);

    const res = await app.request(`/api/characters/${character.id}/lorebooks`);
    expect(res.status).toBe(200);
    const attached = (await res.json()) as AttachedBook[];
    expect(attached).toMatchObject([{ id: book.id, name: "World", enabled: true }]);

    // The attach count surfaces on the list endpoint.
    expect((await listBooks())[0]?.attached_character_count).toBe(1);
  });

  it("toggles a link via PATCH /api/characters/:id/lorebooks/:bookId", async () => {
    const book = await createBook({ name: "World" });
    const character = repos.characters.create({ name: "Alice" });
    await app.request(
      `/api/lorebooks/${book.id}/attach`,
      jsonInit("POST", { character_id: character.id }),
    );

    const res = await app.request(
      `/api/characters/${character.id}/lorebooks/${book.id}`,
      jsonInit("PATCH", { enabled: false }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: false });
    const attached = (await (
      await app.request(`/api/characters/${character.id}/lorebooks`)
    ).json()) as AttachedBook[];
    expect(attached).toMatchObject([{ id: book.id, enabled: false }]);

    // Unknown character / book / unattached link → 404; bad body → 400.
    expect(
      (
        await app.request(
          "/api/characters/missing/lorebooks/x",
          jsonInit("PATCH", { enabled: true }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/api/characters/${character.id}/lorebooks/missing`,
          jsonInit("PATCH", { enabled: true }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/api/characters/${character.id}/lorebooks/${book.id}`,
          jsonInit("PATCH", { enabled: "yes" }),
        )
      ).status,
    ).toBe(400);
    const unattached = await createBook({ name: "Other" });
    expect(
      (
        await app.request(
          `/api/characters/${character.id}/lorebooks/${unattached.id}`,
          jsonInit("PATCH", { enabled: true }),
        )
      ).status,
    ).toBe(404);
  });
});
