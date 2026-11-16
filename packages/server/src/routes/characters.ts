/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { characterInputSchema } from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import type { RouteDeps } from "../routes-deps";
import { badRequest, parseJsonBody } from "../routes-deps";

const purgeSchema = z.object({ ids: z.array(z.string()).optional() });

/** Default page size when `?limit=` is absent. */
const LIST_LIMIT_DEFAULT = 100;
/** Hard ceiling; larger numeric limits are clamped down to this. */
const LIST_LIMIT_MAX = 500;

/**
 * Query schema for GET /api/characters paging.
 *
 * `z.coerce.number()` accepts numeric query strings; non-numeric values
 * become NaN, which `.int()`/`.min(0)` reject → 400. Empty values are mapped
 * to `undefined` by the handler before parsing, so `?limit=` means "absent",
 * matching the tag/search convention. `limit` is deliberately NOT bounded
 * here: a numeric limit outside 1..500 is clamped in the handler (a friendly
 * page-size request should not 400), while `offset` must be a non-negative
 * integer or it is rejected.
 *
 * `offset` is additionally capped at `Number.MAX_SAFE_INTEGER`: Zod's `.int()`
 * accepts integers far beyond 2^63, and binding one to `LIMIT ? OFFSET ?`
 * throws `datatype mismatch` in bun:sqlite — an unhandled 500 instead of the
 * `{error, details}` shape. Beyond the safe-integer range the value cannot
 * identify a real row anyway, so 400 is the honest answer.
 *
 * `sort` selects the listing order (see `CharacterSort`); absent or empty
 * means `"name"`, so an invalid value is the only 400 case here.
 */
const listQuerySchema = z.object({
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  sort: z.enum(["name", "created", "recent"]).optional(),
});

/**
 * PATCH /api/characters/:id accepts any subset of the create fields.
 * Absent fields are left untouched — no defaults are applied here.
 * `characterInputSchema.partial()` cannot be used: its fields carry
 * `.default()`, which `.partial()` preserves, so absent keys would be
 * replaced by the default (wiping avatar_path, system_prompt,
 * post_history_instructions and card_raw on every edit).
 */
const characterPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  personality: z.string().optional(),
  scenario: z.string().optional(),
  first_mes: z.string().optional(),
  mes_example: z.string().optional(),
  creator_notes: z.string().optional(),
  system_prompt: z.string().optional(),
  post_history_instructions: z.string().optional(),
  alternate_greetings: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  avatar_path: z.string().nullable().optional(),
  card_raw: z.unknown().nullable().optional(),
});

/** Empty query values count as absent, disabling that filter. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

/**
 * Characters CRUD plus bulk purge.
 *
 * Deletion semantics: gallery rows cascade in SQL, but chats hold a
 * restrictive FK — a character's chats (and, cascading from them, their
 * messages and summaries) are deleted explicitly before the character row.
 */
export function charactersRoutes(deps: RouteDeps): Hono {
  const { repos } = deps;
  const app = new Hono();

  app.post("/api/characters", async (c) => {
    const parsed = parseJsonBody(characterInputSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    return c.json(repos.characters.create(parsed.value), 201);
  });

  app.get("/api/characters", (c) => {
    const raw = c.req.query();
    const parsed = listQuerySchema.safeParse({
      limit: nonEmpty(raw.limit),
      offset: nonEmpty(raw.offset),
      sort: nonEmpty(raw.sort),
    });
    if (!parsed.success) {
      return c.json(
        badRequest(
          "Invalid query parameters",
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        ),
        400,
      );
    }
    // Out-of-range limits clamp (a too-large page is a hint, not an error);
    // a negative/non-numeric offset already failed the schema above.
    const limit = Math.min(Math.max(parsed.data.limit ?? LIST_LIMIT_DEFAULT, 1), LIST_LIMIT_MAX);
    const offset = parsed.data.offset ?? 0;
    // Repeated `?tag=` params are the multi-tag filter: a character must carry
    // every listed tag. `c.req.query()` keeps only the first value, so read the
    // list explicitly; a lone `?tag=` (empty string) disables the filter.
    const tags = (c.req.queries("tag") ?? []).filter((tag) => tag !== "");
    const filters = {
      tags: tags.length > 0 ? tags : undefined,
      search: nonEmpty(raw.search),
    };
    const chatCounts = repos.chats.countsByCharacter();
    const items = repos.characters
      .list({ ...filters, sort: parsed.data.sort, limit, offset })
      .map((character) => ({
        ...character,
        chat_count: chatCounts.get(character.id) ?? 0,
      }));
    return c.json({
      items,
      total: repos.characters.count(filters),
      // Distinct tags across every character matching the filters (ignoring
      // paging), so the grid's chips offer tags that only occur beyond page 1.
      tags: repos.characters.listTags(filters),
      limit,
      offset,
    });
  });

  app.get("/api/characters/:id", (c) => {
    const id = c.req.param("id");
    const character = repos.characters.get(id);
    if (!character) {
      return c.json({ error: `character ${id} not found` }, 404);
    }
    return c.json(character);
  });

  app.patch("/api/characters/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = parseJsonBody(characterPatchSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const character = repos.characters.update(id, parsed.value);
    if (!character) {
      return c.json({ error: `character ${id} not found` }, 404);
    }
    return c.json(character);
  });

  app.delete("/api/characters/:id", (c) => {
    const id = c.req.param("id");
    if (!repos.characters.get(id)) {
      return c.json({ error: `character ${id} not found` }, 404);
    }
    deleteCharacterCascade(id);
    return c.json({ ok: true });
  });

  // With `ids`: exactly those characters (unknown ids ignored; chats go with
  // them, as in DELETE). Without: every character that has zero chats.
  app.post("/api/characters/purge", async (c) => {
    const parsed = parseJsonBody(purgeSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    let ids = parsed.value.ids;
    if (ids === undefined) {
      // One grouped count instead of a per-character chat lookup (N+1).
      // A character absent from the map simply has zero chats.
      const counts = repos.chats.countsByCharacter();
      ids = repos.characters
        .list()
        .filter((ch) => (counts.get(ch.id) ?? 0) === 0)
        .map((ch) => ch.id);
    }
    const deleted: string[] = [];
    for (const id of ids) {
      if (repos.characters.get(id) !== null && deleteCharacterCascade(id)) {
        deleted.push(id);
      }
    }
    return c.json({ deleted_ids: deleted });
  });

  /** Deletes a character's chats first — their FK blocks the row delete. */
  function deleteCharacterCascade(id: string): boolean {
    for (const chat of repos.chats.listByCharacter(id)) {
      repos.chats.delete(chat.id); // messages and summaries cascade in SQL
    }
    return repos.characters.delete(id);
  }

  return app;
}
