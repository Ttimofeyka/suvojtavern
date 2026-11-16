/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { engine, type Lorebook, lorebookInputSchema, st } from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import type { RouteDeps } from "../routes-deps";
import { badRequest, parseJsonBody } from "../routes-deps";
import { lorebookEntryRoutes } from "./lorebook-entries";
import { lorebookSectionsRoutes } from "./lorebook-sections";

/** PATCH subset of the create fields; absent fields are left untouched. */
const lorebookPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
});

const attachSchema = z.object({ character_id: z.string().min(1) });

/** Body of the enabled-toggle routes (character link + global flag). */
const enabledSchema = z.object({ enabled: z.boolean() });

/** Body of POST /api/lorebooks/import: ST lorebook JSON text + name override. */
const importSchema = z.object({
  raw: z.string().min(1),
  name: z.string().min(1).optional(),
});

/** Reads the `lorebooks:global` settings key as a set of lorebook ids. */
function globalLorebookIds(deps: RouteDeps): Set<string> {
  const global = deps.repos.settings.get<{ ids?: unknown }>(engine.GLOBAL_LOREBOOKS_KEY);
  return new Set(
    Array.isArray(global?.ids)
      ? global.ids.filter((id): id is string => typeof id === "string")
      : [],
  );
}

/** A lorebook row plus the management extras every lorebook response carries. */
function withMeta(
  deps: RouteDeps,
  lorebook: Lorebook,
): Lorebook & { global: boolean; attached_character_count: number } {
  return {
    ...lorebook,
    global: globalLorebookIds(deps).has(lorebook.id),
    attached_character_count: deps.repos.lorebooks.attachmentCounts().get(lorebook.id) ?? 0,
  };
}

/** Lorebook CRUD, character links, and ST world info import — /api/lorebooks. */
export function lorebooksRoutes(deps: RouteDeps): Hono {
  const app = new Hono();
  app.route("/", lorebookEntryRoutes(deps)); // nested /api/lorebooks/:id/entries
  app.route("/", lorebookSectionsRoutes(deps)); // nested /api/lorebooks/:id/sections

  app.post("/api/lorebooks", async (c) => {
    const parsed = parseJsonBody(lorebookInputSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    return c.json(withMeta(deps, deps.repos.lorebooks.create(parsed.value)), 201);
  });

  app.get("/api/lorebooks", (c) => {
    // Both meta lookups are computed once for the whole list, not per row.
    const globalIds = globalLorebookIds(deps);
    const counts = deps.repos.lorebooks.attachmentCounts();
    return c.json(
      deps.repos.lorebooks.list().map((lorebook) => ({
        ...lorebook,
        global: globalIds.has(lorebook.id),
        attached_character_count: counts.get(lorebook.id) ?? 0,
      })),
    );
  });

  app.get("/api/lorebooks/:id", (c) => {
    const lorebook = deps.repos.lorebooks.get(c.req.param("id"));
    if (!lorebook) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    return c.json({
      ...withMeta(deps, lorebook),
      entries: deps.repos.lorebooks.listEntries(lorebook.id),
      sections: deps.repos.lorebooks.listSections(lorebook.id),
    });
  });

  app.patch("/api/lorebooks/:id", async (c) => {
    const parsed = parseJsonBody(lorebookPatchSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const updated = deps.repos.lorebooks.update(c.req.param("id"), parsed.value);
    if (!updated) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    return c.json(withMeta(deps, updated));
  });

  app.delete("/api/lorebooks/:id", (c) => {
    const id = c.req.param("id");
    if (!deps.repos.lorebooks.delete(id)) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    // Prune the deleted book from the global ids so the key never dangles.
    const globalIds = globalLorebookIds(deps);
    if (globalIds.delete(id)) {
      deps.repos.settings.set(engine.GLOBAL_LOREBOOKS_KEY, { ids: [...globalIds] });
    }
    return c.json({ ok: true });
  });

  /** Toggles the global (every-chat) flag stored in the lorebooks:global settings. */
  app.patch("/api/lorebooks/:id/global", async (c) => {
    const lorebook = deps.repos.lorebooks.get(c.req.param("id"));
    if (!lorebook) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    const parsed = parseJsonBody(enabledSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const globalIds = globalLorebookIds(deps);
    globalIds.delete(lorebook.id);
    if (parsed.value.enabled) {
      globalIds.add(lorebook.id);
    }
    deps.repos.settings.set(engine.GLOBAL_LOREBOOKS_KEY, { ids: [...globalIds] });
    return c.json({ ok: true, global: parsed.value.enabled });
  });

  app.post("/api/lorebooks/:id/attach", async (c) => {
    const lorebook = deps.repos.lorebooks.get(c.req.param("id"));
    if (!lorebook) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    const parsed = parseJsonBody(attachSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    if (!deps.repos.characters.get(parsed.value.character_id)) {
      return c.json({ error: "character not found" }, 404);
    }
    deps.repos.lorebooks.attachToCharacter(parsed.value.character_id, lorebook.id);
    return c.json({ ok: true });
  });

  /** Detach — 404 when the lorebook is not attached to that character. */
  app.delete("/api/lorebooks/:id/attach/:characterId", (c) => {
    const lorebook = deps.repos.lorebooks.get(c.req.param("id"));
    if (!lorebook) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    const characterId = c.req.param("characterId");
    if (!deps.repos.lorebooks.detachFromCharacter(characterId, lorebook.id)) {
      return c.json({ error: "lorebook is not attached to this character" }, 404);
    }
    return c.json({ ok: true });
  });

  /** Character links with their enabled state — the chat popover surface. */
  app.get("/api/characters/:id/lorebooks", (c) => {
    if (!deps.repos.characters.get(c.req.param("id"))) {
      return c.json({ error: "character not found" }, 404);
    }
    return c.json(deps.repos.lorebooks.listAttachmentsForCharacter(c.req.param("id")));
  });

  /** Toggles a character link — 404 when the book is not attached. */
  app.patch("/api/characters/:id/lorebooks/:bookId", async (c) => {
    const characterId = c.req.param("id");
    if (!deps.repos.characters.get(characterId)) {
      return c.json({ error: "character not found" }, 404);
    }
    const lorebook = deps.repos.lorebooks.get(c.req.param("bookId"));
    if (!lorebook) {
      return c.json({ error: "lorebook not found" }, 404);
    }
    const parsed = parseJsonBody(enabledSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    if (
      !deps.repos.lorebooks.setAttachmentEnabled(characterId, lorebook.id, parsed.value.enabled)
    ) {
      return c.json({ error: "lorebook is not attached to this character" }, 404);
    }
    return c.json({ ok: true, enabled: parsed.value.enabled });
  });

  app.post("/api/lorebooks/import", async (c) => {
    const parsed = parseJsonBody(importSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    let source: unknown;
    try {
      source = JSON.parse(parsed.value.raw);
    } catch {
      return c.json(badRequest("raw is not valid JSON"), 400);
    }
    try {
      const result = st.importLorebook(source, deps.repos.lorebooks, { name: parsed.value.name });
      // A replacing import wipes sections (ST files carry none), so the
      // detail's `sections` is always empty here — but it must be present:
      // consumers reconcile the returned detail and would index `undefined`.
      return c.json(
        {
          ...withMeta(deps, result.lorebook),
          entries: result.entries,
          sections: deps.repos.lorebooks.listSections(result.lorebook.id),
        },
        201,
      );
    } catch (err) {
      return c.json(badRequest(err instanceof Error ? err.message : "invalid lorebook file"), 400);
    }
  });

  return app;
}
