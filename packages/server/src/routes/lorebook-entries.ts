/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  lorebookCharacterFilterSchema,
  lorebookEntryInputSchema,
  lorebookRecursionSchema,
} from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import type { RouteDeps } from "../routes-deps";
import { parseJsonBody } from "../routes-deps";

/**
 * PATCH accepts any subset of the full SillyTavern entry field set.
 * Absent fields are left untouched — no defaults are applied here,
 * unlike the create schema (which fills ST defaults per column).
 */
const entryPatchSchema = z.object({
  keys: z.array(z.string()).optional(),
  secondary: z.array(z.string()).optional(),
  content: z.string().optional(),
  comment: z.string().nullable().optional(),
  constant: z.boolean().optional(),
  selective: z.boolean().optional(),
  logic: z.number().int().optional(),
  order: z.number().int().optional(),
  position: z.number().int().optional(),
  depth: z.number().int().optional(),
  role: z.string().nullable().optional(),
  probability: z.number().int().optional(),
  enabled: z.boolean().optional(),
  sticky: z.number().int().optional(),
  cooldown: z.number().int().optional(),
  delay: z.number().int().optional(),
  vectorized: z.boolean().optional(),
  case_sensitive: z.boolean().optional(),
  match_whole_words: z.boolean().optional(),
  scan_depth: z.number().int().nullable().optional(),
  group: z.string().nullable().optional(),
  group_weight: z.number().int().nullable().optional(),
  recursion: lorebookRecursionSchema.nullable().optional(),
  match_fields: z.record(z.string(), z.boolean()).nullable().optional(),
  character_filter: lorebookCharacterFilterSchema.nullable().optional(),
  section_id: z.string().nullable().optional(),
  display_index: z.number().int().optional(),
  extra: z.record(z.string(), z.unknown()).nullable().optional(),
});

/**
 * Body of PUT /:id/entries/order. `section_id` names the container being
 * reordered and is REQUIRED (not optional): `null` explicitly means the
 * ungrouped bucket, `undefined` would be ambiguous.
 */
const reorderEntriesSchema = z.object({
  section_id: z.string().nullable(),
  ids: z.array(z.string()),
});

/**
 * Whether `sectionId` is a usable container for `lorebookId`: `null` is
 * always the ungrouped bucket, and a real id must resolve to a section of
 * THIS book. The FK on `lorebook_entries.section_id` only checks existence,
 * so this is the trust boundary that stops an entry being filed into another
 * lorebook's section.
 */
function sectionInBook(deps: RouteDeps, lorebookId: string, sectionId: string | null): boolean {
  if (sectionId === null) {
    return true;
  }
  return deps.repos.lorebooks.getSection(sectionId)?.lorebook_id === lorebookId;
}

/** Lorebook entry CRUD, nested under /api/lorebooks/:id/entries. */
export function lorebookEntryRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/api/lorebooks/:id/entries", (c) => {
    const lorebook = deps.repos.lorebooks.get(c.req.param("id"));
    if (!lorebook) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    return c.json(deps.repos.lorebooks.listEntries(lorebook.id));
  });

  app.post("/api/lorebooks/:id/entries", async (c) => {
    const lorebook = deps.repos.lorebooks.get(c.req.param("id"));
    if (!lorebook) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    const raw = await c.req.json().catch(() => undefined);
    const parsed = parseJsonBody(lorebookEntryInputSchema, raw);
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    if (!sectionInBook(deps, lorebook.id, parsed.value.section_id)) {
      return c.json({ error: "section not found in this lorebook" }, 400);
    }
    // Append semantics live in the repository, which treats an OMITTED
    // `display_index` as "append to the container". The schema materializes
    // the default 0, so the decision must be made on the RAW body: when the
    // client sent no index, force `undefined` so the repo appends; an explicit
    // index (including 0) still wins.
    const omittedDisplayIndex =
      typeof raw !== "object" || raw === null || !("display_index" in raw);
    return c.json(
      deps.repos.lorebooks.addEntry(
        lorebook.id,
        omittedDisplayIndex ? { ...parsed.value, display_index: undefined } : parsed.value,
      ),
      201,
    );
  });

  // Registered before `PATCH .../:entryId` and `DELETE .../:entryId` for
  // clarity. Method routing already separates them (this is the only PUT on
  // the path), so `entries/order` is never captured as an entry id.
  app.put("/api/lorebooks/:id/entries/order", async (c) => {
    const lorebook = deps.repos.lorebooks.get(c.req.param("id"));
    if (!lorebook) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    const parsed = parseJsonBody(reorderEntriesSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    // A foreign/unknown section would otherwise read as an empty container and
    // let `ids: []` succeed as a misleading no-op.
    if (!sectionInBook(deps, lorebook.id, parsed.value.section_id)) {
      return c.json({ error: "section not found in this lorebook" }, 400);
    }
    const entries = deps.repos.lorebooks.reorderEntries(
      lorebook.id,
      parsed.value.section_id,
      parsed.value.ids,
    );
    if (!entries) {
      return c.json({ error: "ids must be a permutation of the container's entry ids" }, 400);
    }
    return c.json({ entries });
  });

  app.patch("/api/lorebooks/:id/entries/:entryId", async (c) => {
    const lorebook = deps.repos.lorebooks.get(c.req.param("id"));
    if (!lorebook) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    const entry = deps.repos.lorebooks.getEntry(c.req.param("entryId"));
    if (!entry || entry.lorebook_id !== lorebook.id) {
      return c.json({ error: "entry not found" }, 404);
    }
    const parsed = parseJsonBody(entryPatchSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    // Only when the patch touches `section_id`; an omitted field is untouched.
    if (
      parsed.value.section_id !== undefined &&
      !sectionInBook(deps, lorebook.id, parsed.value.section_id)
    ) {
      return c.json({ error: "section not found in this lorebook" }, 400);
    }
    const updated = deps.repos.lorebooks.updateEntry(entry.id, parsed.value);
    if (!updated) {
      return c.json({ error: "entry not found" }, 404);
    }
    return c.json(updated);
  });

  app.delete("/api/lorebooks/:id/entries/:entryId", (c) => {
    const lorebook = deps.repos.lorebooks.get(c.req.param("id"));
    if (!lorebook) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    const entry = deps.repos.lorebooks.getEntry(c.req.param("entryId"));
    if (!entry || entry.lorebook_id !== lorebook.id) {
      return c.json({ error: "entry not found" }, 404);
    }
    deps.repos.lorebooks.deleteEntry(entry.id);
    return c.json({ ok: true });
  });

  return app;
}
