/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { Lorebook, LorebookEntry, LorebookSection } from "@suvoj/core";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { lorebooksRoutes } from "./lorebooks";

let app: Hono;
let bookId: string;

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  setSystemTime();
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos }) };
  app = new Hono();
  app.route("/", lorebooksRoutes(deps));
  const res = await app.request("/api/lorebooks", jsonInit("POST", { name: "World" }));
  bookId = ((await res.json()) as Lorebook).id;
});

async function createSection(name: string, book = bookId): Promise<LorebookSection> {
  const res = await app.request(`/api/lorebooks/${book}/sections`, jsonInit("POST", { name }));
  expect(res.status).toBe(201);
  return (await res.json()) as LorebookSection;
}

async function listSections(book = bookId): Promise<LorebookSection[]> {
  return (await (await app.request(`/api/lorebooks/${book}/sections`)).json()) as LorebookSection[];
}

async function addEntry(body: unknown): Promise<LorebookEntry> {
  const res = await app.request(`/api/lorebooks/${bookId}/entries`, jsonInit("POST", body));
  expect(res.status).toBe(201);
  return (await res.json()) as LorebookEntry;
}

/** Creates a second lorebook with one section — the cross-book fixture. */
async function foreignSection(name = "Other section"): Promise<LorebookSection> {
  const other = (await (
    await app.request("/api/lorebooks", jsonInit("POST", { name: "Other" }))
  ).json()) as Lorebook;
  return createSection(name, other.id);
}

async function getEntry(entryId: string): Promise<LorebookEntry | null> {
  const entries = (await (
    await app.request(`/api/lorebooks/${bookId}/entries`)
  ).json()) as LorebookEntry[];
  return entries.find((entry) => entry.id === entryId) ?? null;
}

describe("lorebook section routes", () => {
  it("creates, lists, renames and deletes sections", async () => {
    const a = await createSection("Places");
    const b = await createSection("People");
    expect(a).toMatchObject({ lorebook_id: bookId, name: "Places", display_index: 0 });
    expect(b.display_index).toBe(1);
    expect((await listSections()).map((section) => section.name)).toEqual(["Places", "People"]);

    const renamed = await app.request(
      `/api/lorebooks/${bookId}/sections/${a.id}`,
      jsonInit("PATCH", { name: "Locations" }),
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: a.id, name: "Locations" });

    const removed = await app.request(`/api/lorebooks/${bookId}/sections/${b.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect((await listSections()).map((section) => section.id)).toEqual([a.id]);
  });

  it("carries non-empty created_at/updated_at and advances updated_at on rename", async () => {
    setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    const created = await createSection("S");
    expect(created.created_at).not.toBe("");
    expect(created.updated_at).not.toBe("");
    expect(created.updated_at).toBe(created.created_at);

    // A rename later in time moves updated_at forward past created_at.
    setSystemTime(new Date("2024-01-02T00:00:00.000Z"));
    const renamed = (await (
      await app.request(
        `/api/lorebooks/${bookId}/sections/${created.id}`,
        jsonInit("PATCH", { name: "S2" }),
      )
    ).json()) as LorebookSection;
    expect(renamed.created_at).toBe(created.created_at);
    expect(renamed.updated_at).toBe("2024-01-02T00:00:00.000Z");
    expect(renamed.updated_at > renamed.created_at).toBe(true);
    setSystemTime();
  });

  it("404s for unknown books, unknown sections, and cross-book sections", async () => {
    const section = await createSection("S");
    expect((await app.request("/api/lorebooks/missing/sections")).status).toBe(404);

    const other = (await (
      await app.request("/api/lorebooks", jsonInit("POST", { name: "Other" }))
    ).json()) as Lorebook;

    // A section of another book is invisible through this book's routes.
    for (const makeReq of [
      () =>
        app.request(
          `/api/lorebooks/${other.id}/sections/${section.id}`,
          jsonInit("PATCH", { name: "x" }),
        ),
      () => app.request(`/api/lorebooks/${other.id}/sections/${section.id}`, { method: "DELETE" }),
    ]) {
      const res = await makeReq();
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "section not found" });
    }

    const unknown = await app.request(
      `/api/lorebooks/${bookId}/sections/missing`,
      jsonInit("PATCH", { name: "x" }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "section not found" });
    // The section was never touched.
    expect((await listSections()).map((s) => s.name)).toEqual(["S"]);
  });

  it("reorders sections and 400s on a non-permutation", async () => {
    const a = await createSection("A");
    const b = await createSection("B");
    const c = await createSection("C");

    const res = await app.request(
      `/api/lorebooks/${bookId}/sections/order`,
      jsonInit("PUT", { ids: [c.id, a.id, b.id] }),
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { sections: LorebookSection[] }).sections.map((s) => s.id),
    ).toEqual([c.id, a.id, b.id]);

    const bad = await app.request(
      `/api/lorebooks/${bookId}/sections/order`,
      jsonInit("PUT", { ids: [a.id, b.id] }),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: expect.any(String) });
    // Order is unchanged after the rejected call.
    expect((await listSections()).map((s) => s.id)).toEqual([c.id, a.id, b.id]);
  });

  it("includes sections in the lorebook detail response", async () => {
    const section = await createSection("S");
    const detail = (await (await app.request(`/api/lorebooks/${bookId}`)).json()) as Lorebook & {
      sections: LorebookSection[];
    };
    expect(detail.sections.map((s) => s.id)).toEqual([section.id]);
  });

  it("moves entries between sections and the ungrouped bucket via PATCH", async () => {
    const section = await createSection("S");
    const entry = await addEntry({ content: "c" });
    expect(entry.section_id).toBeNull();

    const moved = await app.request(
      `/api/lorebooks/${bookId}/entries/${entry.id}`,
      jsonInit("PATCH", { section_id: section.id }),
    );
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ id: entry.id, section_id: section.id });

    const ungrouped = await app.request(
      `/api/lorebooks/${bookId}/entries/${entry.id}`,
      jsonInit("PATCH", { section_id: null }),
    );
    expect(ungrouped.status).toBe(200);
    expect(await ungrouped.json()).toMatchObject({ id: entry.id, section_id: null });
  });

  it("reorders entries within a container and 400s on a mismatch", async () => {
    const section = await createSection("S");
    const u0 = await addEntry({ content: "u0" });
    const u1 = await addEntry({ content: "u1" });
    const s0 = await addEntry({ content: "s0", section_id: section.id });
    const s1 = await addEntry({ content: "s1", section_id: section.id });

    const res = await app.request(
      `/api/lorebooks/${bookId}/entries/order`,
      jsonInit("PUT", { section_id: section.id, ids: [s1.id, s0.id] }),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { entries: LorebookEntry[] };
    const indexOf = (id: string) => payload.entries.find((entry) => entry.id === id)?.display_index;
    expect(indexOf(s1.id)).toBe(0);
    expect(indexOf(s0.id)).toBe(1);

    // A cross-container id is not a permutation of the section's entries.
    const bad = await app.request(
      `/api/lorebooks/${bookId}/entries/order`,
      jsonInit("PUT", { section_id: section.id, ids: [s0.id, u0.id] }),
    );
    expect(bad.status).toBe(400);

    // An unknown book 404s; a missing section_id is a 400 (required field).
    expect(
      (
        await app.request(
          "/api/lorebooks/missing/entries/order",
          jsonInit("PUT", { section_id: null, ids: [] }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/api/lorebooks/${bookId}/entries/order`,
          jsonInit("PUT", { ids: [u0.id, u1.id] }),
        )
      ).status,
    ).toBe(400);
  });

  it("rejects filing an entry into another book's section (create, patch, order)", async () => {
    const foreign = await foreignSection();

    // POST with a foreign section_id.
    const create = await app.request(
      `/api/lorebooks/${bookId}/entries`,
      jsonInit("POST", { content: "c", section_id: foreign.id }),
    );
    expect(create.status).toBe(400);
    expect(await create.json()).toEqual({ error: "section not found in this lorebook" });

    // Same book still works.
    const own = await createSection("Own");
    expect((await addEntry({ content: "ok", section_id: own.id })).section_id).toBe(own.id);

    // PATCH with a foreign section_id leaves the entry unchanged.
    const entry = await addEntry({ content: "c" });
    const patch = await app.request(
      `/api/lorebooks/${bookId}/entries/${entry.id}`,
      jsonInit("PATCH", { section_id: foreign.id }),
    );
    expect(patch.status).toBe(400);
    expect(await patch.json()).toEqual({ error: "section not found in this lorebook" });
    expect((await getEntry(entry.id))?.section_id).toBeNull();
    // A same-book patch succeeds.
    const okPatch = await app.request(
      `/api/lorebooks/${bookId}/entries/${entry.id}`,
      jsonInit("PATCH", { section_id: own.id }),
    );
    expect(okPatch.status).toBe(200);
    expect((await getEntry(entry.id))?.section_id).toBe(own.id);

    // PUT entries/order with a foreign section_id is a 400, not an empty-
    // container success for `ids: []` (or a foreign-container mutation).
    const order = await app.request(
      `/api/lorebooks/${bookId}/entries/order`,
      jsonInit("PUT", { section_id: foreign.id, ids: [] }),
    );
    expect(order.status).toBe(400);
    expect(await order.json()).toEqual({ error: "section not found in this lorebook" });
  });
});
