/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Lorebook, LorebookEntry } from "@suvoj/core";
import { createRepositories, migrations, openDatabase, runMigrations } from "@suvoj/core";
import { Hono } from "hono";
import { createGateway } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { lorebooksRoutes } from "./lorebooks";

let app: Hono;
let bookId: string;

/** A full SillyTavern-surface entry (every field of the create schema). */
const fullEntry = {
  keys: ["alpha", "beta"],
  secondary: ["gamma"],
  content: "Some lore about the world.",
  comment: "memo",
  constant: true,
  selective: false,
  logic: 1,
  order: 200,
  position: 1,
  depth: 2,
  role: "user",
  probability: 80,
  enabled: false,
  sticky: 3,
  cooldown: 5,
  delay: 7,
  vectorized: true,
  case_sensitive: true,
  match_whole_words: false,
  scan_depth: 9,
  group: "g1",
  group_weight: 50,
  recursion: { excludeRecursion: true, preventRecursion: false, delayUntilRecursion: true },
  match_fields: { matchPersonaDescription: true },
  character_filter: { isExclude: true, names: ["N"], tags: ["t"] },
  display_index: 4,
  extra: { custom: "kept" },
};

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  const db = openDatabase(":memory:");
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const deps: RouteDeps = { repos, gateway: createGateway({ repos }) };
  app = new Hono();
  app.route("/", lorebooksRoutes(deps));
  const res = await app.request("/api/lorebooks", jsonInit("POST", { name: "World" }));
  bookId = ((await res.json()) as Lorebook).id;
});

async function addEntry(body: unknown = fullEntry): Promise<LorebookEntry> {
  const res = await app.request(`/api/lorebooks/${bookId}/entries`, jsonInit("POST", body));
  expect(res.status).toBe(201);
  return (await res.json()) as LorebookEntry;
}

async function listEntries(): Promise<LorebookEntry[]> {
  return (await (await app.request(`/api/lorebooks/${bookId}/entries`)).json()) as LorebookEntry[];
}

describe("lorebook entry routes", () => {
  it("adds a full ST entry and round-trips every field", async () => {
    const entry = await addEntry();
    expect(entry).toMatchObject({ ...fullEntry, lorebook_id: bookId });
    const listed = await listEntries();
    expect(listed.map((row) => row.id)).toEqual([entry.id]);
  });

  it("fills ST defaults for a minimal entry", async () => {
    expect(await addEntry({ keys: ["k"], content: "c" })).toMatchObject({
      keys: ["k"],
      content: "c",
      constant: false,
      order: 100,
      position: 0,
      depth: 4,
      enabled: true,
      match_whole_words: true,
      recursion: null,
    });
  });

  it("patches an entry partially, preserving unmentioned fields", async () => {
    const entry = await addEntry();
    const res = await app.request(
      `/api/lorebooks/${bookId}/entries/${entry.id}`,
      jsonInit("PATCH", { content: "updated", keys: ["x"], constant: true, depth: 8 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ...fullEntry,
      content: "updated",
      keys: ["x"],
      constant: true,
      depth: 8,
    });
  });

  it("404s for entries of another lorebook or unknown ids", async () => {
    const entry = await addEntry();
    const other = (await (
      await app.request("/api/lorebooks", jsonInit("POST", { name: "Other" }))
    ).json()) as Lorebook;
    const cross = await app.request(
      `/api/lorebooks/${other.id}/entries/${entry.id}`,
      jsonInit("PATCH", { content: "nope" }),
    );
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual({ error: "entry not found" });
    expect((await app.request("/api/lorebooks/missing/entries")).status).toBe(404);
  });

  it("deletes an entry and then it is gone", async () => {
    const entry = await addEntry();
    const res = await app.request(`/api/lorebooks/${bookId}/entries/${entry.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await listEntries()).toEqual([]);
    expect(
      (
        await app.request(`/api/lorebooks/${bookId}/entries/${entry.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
  });
});

describe("lorebook entry append semantics over HTTP", () => {
  /** A section of the current book (route-level, so its defaults apply). */
  async function createSection(name: string): Promise<string> {
    const res = await app.request(`/api/lorebooks/${bookId}/sections`, jsonInit("POST", { name }));
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it("appends three index-less creates at 0, 1, 2", async () => {
    // Assert the actual display_index values, not insertion order: `rowid`
    // ties would mask three entries all stuck at 0.
    const e0 = await addEntry({ content: "e0" });
    const e1 = await addEntry({ content: "e1" });
    const e2 = await addEntry({ content: "e2" });
    expect([e0.display_index, e1.display_index, e2.display_index]).toEqual([0, 1, 2]);
    // The persisted rows agree (and have distinct indexes).
    expect((await listEntries()).map((entry) => entry.display_index)).toEqual([0, 1, 2]);
  });

  it("honors an explicit display_index of 0 as 0", async () => {
    // The default is 0; an explicit 0 must be indistinguishable from it and
    // must NOT trigger the append branch (which would also be 0 here — assert
    // via a follow-up append landing at 1).
    const explicitZero = await addEntry({ content: "zero", display_index: 0 });
    expect(explicitZero.display_index).toBe(0);
    expect((await addEntry({ content: "next" })).display_index).toBe(1);
  });

  it("appends within a section after its existing entries, and after a reorder", async () => {
    const section = await createSection("S");
    const s0 = await addEntry({ content: "s0", section_id: section });
    const s1 = await addEntry({ content: "s1", section_id: section });
    const s2 = await addEntry({ content: "s2", section_id: section });
    expect([s0.display_index, s1.display_index, s2.display_index]).toEqual([0, 1, 2]);

    // Reorder the section so s2 is first, then a new create appends at the end
    // of the NEW order (index 3), not the old one.
    const order = await app.request(
      `/api/lorebooks/${bookId}/entries/order`,
      jsonInit("PUT", { section_id: section, ids: [s2.id, s0.id, s1.id] }),
    );
    expect(order.status).toBe(200);
    const appended = await addEntry({ content: "s3", section_id: section });
    expect(appended.display_index).toBe(3);
  });

  it("starts each container at 0 independently", async () => {
    const section = await createSection("S");
    expect((await addEntry({ content: "u0" })).display_index).toBe(0);
    expect((await addEntry({ content: "s0", section_id: section })).display_index).toBe(0);
    // Each container's second entry is 1, unaffected by the other.
    expect((await addEntry({ content: "u1" })).display_index).toBe(1);
    expect((await addEntry({ content: "s1", section_id: section })).display_index).toBe(1);
  });
});
