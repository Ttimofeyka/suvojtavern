/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LorebookSection } from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import type { RouteDeps } from "../routes-deps";
import { parseJsonBody } from "../routes-deps";

/**
 * POST body: only `name` is accepted — `display_index` is always assigned by
 * the repository (append), so a client cannot splice a new section in.
 */
const sectionCreateSchema = z.object({ name: z.string().min(1) });

/**
 * PATCH accepts `name` and/or `display_index`. Written explicitly with
 * `.optional()` — never `.partial()` of the create schema, whose `.default()`
 * would survive and wipe `display_index` on every rename.
 */
const sectionPatchSchema = z.object({
  name: z.string().min(1).optional(),
  display_index: z.number().int().optional(),
});

/** Body of PUT /:id/sections/order: every current section id, reordering them. */
const reorderSectionsSchema = z.object({ ids: z.array(z.string()) });

/** A section known to belong to `lorebookId`, or null (unknown / cross-book). */
function findSection(
  deps: RouteDeps,
  lorebookId: string,
  sectionId: string,
): LorebookSection | null {
  const section = deps.repos.lorebooks.getSection(sectionId);
  return section && section.lorebook_id === lorebookId ? section : null;
}

/**
 * Lorebook section CRUD + ordering — /api/lorebooks/:id/sections.
 * Sections are a native organizational layer only; they never affect
 * generation (see migration 007 and the repository ordering comments).
 */
export function lorebookSectionsRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/api/lorebooks/:id/sections", (c) => {
    const lorebook = deps.repos.lorebooks.get(c.req.param("id"));
    if (!lorebook) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    return c.json(deps.repos.lorebooks.listSections(lorebook.id));
  });

  app.post("/api/lorebooks/:id/sections", async (c) => {
    const lorebook = deps.repos.lorebooks.get(c.req.param("id"));
    if (!lorebook) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    const parsed = parseJsonBody(sectionCreateSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    return c.json(deps.repos.lorebooks.createSection(lorebook.id, parsed.value), 201);
  });

  // Registered before `:sectionId` for clarity. Hono routes on method + path,
  // so `PUT .../sections/order` cannot be swallowed by the PATCH/DELETE
  // `:sectionId` routes (they are different methods); ordering here just keeps
  // the literal segment ahead of the wildcard for future readers.
  app.put("/api/lorebooks/:id/sections/order", async (c) => {
    const lorebook = deps.repos.lorebooks.get(c.req.param("id"));
    if (!lorebook) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    const parsed = parseJsonBody(reorderSectionsSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const sections = deps.repos.lorebooks.reorderSections(lorebook.id, parsed.value.ids);
    if (!sections) {
      return c.json({ error: "ids must be a permutation of the book's section ids" }, 400);
    }
    return c.json({ sections });
  });

  app.patch("/api/lorebooks/:id/sections/:sectionId", async (c) => {
    const lorebook = deps.repos.lorebooks.get(c.req.param("id"));
    if (!lorebook) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    const section = findSection(deps, lorebook.id, c.req.param("sectionId"));
    if (!section) {
      return c.json({ error: "section not found" }, 404);
    }
    const parsed = parseJsonBody(sectionPatchSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const updated = deps.repos.lorebooks.updateSection(section.id, parsed.value);
    if (!updated) {
      return c.json({ error: "section not found" }, 404);
    }
    return c.json(updated);
  });

  app.delete("/api/lorebooks/:id/sections/:sectionId", (c) => {
    const lorebook = deps.repos.lorebooks.get(c.req.param("id"));
    if (!lorebook) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    const section = findSection(deps, lorebook.id, c.req.param("sectionId"));
    if (!section) {
      return c.json({ error: "section not found" }, 404);
    }
    // Entries survive as ungrouped — never deleted with their section.
    deps.repos.lorebooks.deleteSection(section.id);
    return c.json({ ok: true });
  });

  return app;
}
