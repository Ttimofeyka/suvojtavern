/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Lorebook, LorebookEntry } from "@suvoj/core";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { lorebooksRoutes } from "./lorebooks";

/** The shipped sample lorebook (never written to). */
const EXAMPLE_LOREBOOK_RAW = readFileSync(
  join(import.meta.dir, "../../seed/EXAMPLE_LOREBOOK.json"),
  "utf8",
);

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

describe("lorebook attach/detach", () => {
  it("attaches a lorebook to a character and detaches it again", async () => {
    const lorebook = repos.lorebooks.create({ name: "World" });
    const character = repos.characters.create({ name: "Seraphina" });

    const attach = await app.request(`/api/lorebooks/${lorebook.id}/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ character_id: character.id }),
    });
    expect(attach.status).toBe(200);
    expect(await attach.json()).toEqual({ ok: true });
    expect(repos.lorebooks.listForCharacter(character.id).map((book) => book.id)).toEqual([
      lorebook.id,
    ]);

    const detach = await app.request(`/api/lorebooks/${lorebook.id}/attach/${character.id}`, {
      method: "DELETE",
    });
    expect(detach.status).toBe(200);
    expect(await detach.json()).toEqual({ ok: true });
    expect(repos.lorebooks.listForCharacter(character.id)).toEqual([]);

    const again = await app.request(`/api/lorebooks/${lorebook.id}/attach/${character.id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "lorebook is not attached to this character" });
  });

  it("404s when the lorebook or character of an attach is unknown", async () => {
    const character = repos.characters.create({ name: "Seraphina" });
    const missingBook = await app.request("/api/lorebooks/missing/attach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ character_id: character.id }),
    });
    expect(missingBook.status).toBe(404);
    expect(await missingBook.json()).toEqual({ error: "lorebook not found" });

    const lorebook = repos.lorebooks.create({ name: "World" });
    const missingCharacter = await app.request(`/api/lorebooks/${lorebook.id}/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ character_id: "missing" }),
    });
    expect(missingCharacter.status).toBe(404);
    expect(await missingCharacter.json()).toEqual({ error: "character not found" });
  });
});

describe("POST /api/lorebooks/import", () => {
  it("imports EXAMPLE_LOREBOOK.json with a name override and 13 entries", async () => {
    const res = await app.request(
      "/api/lorebooks/import",
      jsonInit("POST", { raw: EXAMPLE_LOREBOOK_RAW, name: "Imported Book" }),
    );
    expect(res.status).toBe(201);
    const imported = (await res.json()) as Lorebook & {
      entries: LorebookEntry[];
      sections: unknown[];
    };
    expect(imported.name).toBe("Imported Book");
    expect(imported.entries.length).toBe(13);
    // A replacing import drops all sections, so the required detail field is
    // present and empty — never `undefined`.
    expect(imported.sections).toEqual([]);

    const first = imported.entries.find((entry) => entry.display_index === 0);
    expect(first).toMatchObject({
      keys: ["earth", "world", "society", "city"],
      comment: "Earth - The Age of Drones",
      constant: true,
      selective: true,
      enabled: true,
    });
    expect(repos.lorebooks.get(imported.id)?.name).toBe("Imported Book");
    expect(repos.lorebooks.listEntries(imported.id).length).toBe(13);
  });

  it("reports sections for the newly created book without touching other books", async () => {
    // A section on an unrelated book must not leak into the import response
    // (which is generated from the imported book's id).
    const other = repos.lorebooks.create({ name: "Untouched" });
    const otherSection = repos.lorebooks.createSection(other.id, { name: "Keep" });
    const res = await app.request(
      "/api/lorebooks/import",
      jsonInit("POST", { raw: EXAMPLE_LOREBOOK_RAW, name: "Fresh" }),
    );
    expect(res.status).toBe(201);
    const imported = (await res.json()) as { id: string; sections: unknown[] };
    expect(imported.id).not.toBe(other.id);
    expect(imported.sections).toEqual([]);
    expect(repos.lorebooks.listSections(other.id).map((s) => s.id)).toEqual([otherSection.id]);
  });

  it("rejects raw that is not valid JSON", async () => {
    const res = await app.request("/api/lorebooks/import", jsonInit("POST", { raw: "{not json" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "raw is not valid JSON" });
  });

  it("rejects valid JSON that is not a lorebook", async () => {
    const res = await app.request("/api/lorebooks/import", jsonInit("POST", { raw: '{"a":1}' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "not a SillyTavern world info file: no entries" });
  });
});
