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
  return { app: new Hono().route("/", charactersRoutes(deps)), repos, db };
}

const jsonHeaders = { "Content-Type": "application/json" };

async function post(app: Hono, body: string): Promise<Response> {
  return app.request("/api/characters", { method: "POST", body, headers: jsonHeaders });
}

describe("POST /api/characters", () => {
  it("creates a character from a minimal body, filling defaults", async () => {
    const { app } = makeApp();
    const res = await post(app, JSON.stringify({ name: "Seraphina" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      name: "Seraphina",
      description: "",
      personality: "",
      first_mes: "",
      alternate_greetings: [],
      tags: [],
      avatar_path: null,
      card_raw: null,
      id: expect.any(String),
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
  });

  it("accepts the full field set", async () => {
    const { app } = makeApp();
    const res = await post(
      app,
      JSON.stringify({
        name: "Full",
        description: "d",
        tags: ["elf"],
        alternate_greetings: ["hi"],
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "Full", description: "d", tags: ["elf"] });
  });

  it("rejects bodies without a name with 400", async () => {
    const { app } = makeApp();
    expect((await post(app, JSON.stringify({}))).status).toBe(400);
    expect((await post(app, JSON.stringify({ name: 7 }))).status).toBe(400);
    expect((await post(app, "nope")).status).toBe(400);
  });
});

describe("GET /api/characters", () => {
  it("reports chat_count per character", async () => {
    const { app, repos } = makeApp();
    const created = await post(app, JSON.stringify({ name: "Counter" }));
    const id = (await created.json()).id;
    expect(await (await app.request("/api/characters")).json()).toMatchObject({
      items: [expect.objectContaining({ id, chat_count: 0 })],
      total: 1,
      tags: [],
      limit: 100,
      offset: 0,
    });
    repos.chats.create({ character_id: id, title: "first chat" });
    expect(await (await app.request("/api/characters")).json()).toMatchObject({
      items: [expect.objectContaining({ id, chat_count: 1 })],
      total: 1,
    });
  });

  it("returns only the slim list fields (no card bodies)", async () => {
    const { app } = makeApp();
    await post(app, JSON.stringify({ name: "Slim", description: "long prose" }));
    const body = (await (await app.request("/api/characters")).json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items[0]).toEqual({
      id: expect.any(String),
      name: "Slim",
      avatar_path: null,
      tags: [],
      created_at: expect.any(String),
      updated_at: expect.any(String),
      chat_count: 0,
    });
    expect(body.items[0]).not.toHaveProperty("description");
    expect(body.items[0]).not.toHaveProperty("card_raw");
  });

  it("pages with limit/offset; total ignores paging", async () => {
    const { app } = makeApp();
    for (const name of ["Alice", "Bob", "Cera", "Dana"]) {
      await post(app, JSON.stringify({ name }));
    }

    const page = async (
      query: string,
    ): Promise<{ items: unknown[]; total: number; tags: string[] }> =>
      (await (await app.request(`/api/characters${query}`)).json()) as {
        items: unknown[];
        total: number;
        tags: string[];
      };
    const first = await page("?limit=2");
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(4);
    expect(first.tags).toEqual([]);
    const second = await page("?limit=2&offset=2");
    expect(second.items).toHaveLength(2);
    expect(second.total).toBe(4);
    const past = await page("?limit=2&offset=99");
    expect(past.items).toEqual([]);
    expect(past.total).toBe(4);

    // A filtered page's total reflects the filter, not the limit.
    await post(app, JSON.stringify({ name: "Elf", tags: ["elf"] }));
    const filtered = await page("?tag=elf&limit=1");
    expect(filtered.items).toHaveLength(1);
    expect(filtered.total).toBe(1);
    expect(filtered.tags).toEqual(["elf"]);
  });

  it("returns a distinct-tag facet that covers tags beyond the first page", async () => {
    const { app } = makeApp();
    // Ten characters named so the tag-bearing one sorts LAST; page 0 with a
    // limit of one therefore cannot contain it, but the facet still must.
    for (const name of ["A", "B", "C", "D", "E", "F", "G", "H", "I"]) {
      await post(app, JSON.stringify({ name }));
    }
    await post(app, JSON.stringify({ name: "Zed", tags: ["rare"] }));

    const body = (await (await app.request("/api/characters?limit=1")).json()) as {
      items: Array<{ name: string; tags: string[] }>;
      total: number;
      tags: string[];
    };
    expect(body.items.map((c) => c.name)).toEqual(["A"]);
    expect(body.total).toBe(10);
    expect(body.tags).toEqual(["rare"]);
  });

  it("clamps limit and rejects an invalid limit/offset with 400", async () => {
    const { app } = makeApp();
    await post(app, JSON.stringify({ name: "One" }));

    const tooHigh = (await (await app.request("/api/characters?limit=99999")).json()) as {
      limit: number;
    };
    expect(tooHigh.limit).toBe(500);
    const tooLow = (await (await app.request("/api/characters?limit=0")).json()) as {
      limit: number;
    };
    expect(tooLow.limit).toBe(1);

    for (const query of ["?limit=abc", "?offset=-1", "?offset=abc"]) {
      const res = await app.request(`/api/characters${query}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Invalid query parameters",
        details: expect.any(Array),
      });
    }
  });

  it("rejects an offset beyond the safe-integer range with 400, not 500", async () => {
    const { app } = makeApp();
    await post(app, JSON.stringify({ name: "One" }));

    // Beyond 2^63 Zod still parses it as an int; binding it to OFFSET would
    // throw `datatype mismatch` in bun:sqlite and surface as an unhandled 500.
    const res = await app.request("/api/characters?offset=99999999999999999999");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid query parameters",
      details: expect.any(Array),
    });
  });

  it("filters by tag and by name search; empty filters are disabled", async () => {
    const { app } = makeApp();
    await post(app, JSON.stringify({ name: "Alice", tags: ["elf", "mage"] }));
    await post(app, JSON.stringify({ name: "Alicia", tags: ["dwarf"] }));
    await post(app, JSON.stringify({ name: "Bob", tags: ["elf"] }));

    const names = async (query: string): Promise<string[]> =>
      (
        (await (await app.request(`/api/characters${query}`)).json()) as {
          items: Array<{ name: string }>;
        }
      ).items.map((c) => c.name);

    expect(await names("?tag=elf")).toEqual(["Alice", "Bob"]);
    expect(await names("?tag=orc")).toEqual([]);
    // Repeated `tag` params AND together: only a character carrying all of
    // them matches (Alice has elf+mage; nobody has elf+dwarf).
    expect(await names("?tag=elf&tag=mage")).toEqual(["Alice"]);
    expect(await names("?tag=elf&tag=dwarf")).toEqual([]);
    expect(await names("?search=alic")).toEqual(["Alice", "Alicia"]);
    expect(await names("?search=BOB")).toEqual(["Bob"]);
    expect((await names("?tag=")).length).toBe(3);
    expect((await names("?search=")).length).toBe(3);
  });

  it("sorts by created/recent, leaves the default name order, and 400s a bad sort", async () => {
    const { app, repos, db } = makeApp();
    const create = async (name: string): Promise<string> =>
      ((await (await post(app, JSON.stringify({ name }))).json()) as { id: string }).id;
    const aliceId = await create("Alice");
    const bobId = await create("Bob");
    const ceraId = await create("Cera");
    const danaId = await create("Dana");

    const names = async (query: string): Promise<string[]> =>
      (
        (await (await app.request(`/api/characters${query}`)).json()) as {
          items: Array<{ name: string }>;
        }
      ).items.map((c) => c.name);

    // No sort (and an explicit/empty "name") keeps the historical ordering.
    expect(await names("")).toEqual(["Alice", "Bob", "Cera", "Dana"]);
    expect(await names("?sort=name")).toEqual(["Alice", "Bob", "Cera", "Dana"]);
    expect(await names("?sort=")).toEqual(["Alice", "Bob", "Cera", "Dana"]);

    // Distinct created_at values, so "created" is decided by the timestamp
    // rather than the rowid tiebreak.
    for (const [id, at] of [
      [aliceId, "2024-01-01T00:00:00.000Z"],
      [bobId, "2024-03-01T00:00:00.000Z"],
      [ceraId, "2024-02-01T00:00:00.000Z"],
      [danaId, "2024-04-01T00:00:00.000Z"],
    ] as const) {
      db.run("UPDATE characters SET created_at = ? WHERE id = ?", [at, id]);
    }
    expect(await names("?sort=created")).toEqual(["Dana", "Bob", "Cera", "Alice"]);

    // "recent": newest chat activity first; characters without chats last.
    const aliceChat = repos.chats.create({ character_id: aliceId });
    const ceraChat = repos.chats.create({ character_id: ceraId });
    db.run("UPDATE chats SET updated_at = ? WHERE id = ?", [
      "2024-05-01T00:00:00.000Z",
      aliceChat.id,
    ]);
    db.run("UPDATE chats SET updated_at = ? WHERE id = ?", [
      "2024-06-01T00:00:00.000Z",
      ceraChat.id,
    ]);
    expect(await names("?sort=recent")).toEqual(["Cera", "Alice", "Dana", "Bob"]);

    const res = await app.request("/api/characters?sort=bogus");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid query parameters",
      details: expect.any(Array),
    });
  });
});
