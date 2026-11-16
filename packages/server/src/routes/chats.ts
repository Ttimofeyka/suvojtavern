/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Character, Chat, Persona } from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import type { RouteDeps } from "../routes-deps";
import { badRequest, parseJsonBody } from "../routes-deps";
import { insertGreeting } from "./chats-greeting";

/** Chat row plus the list-view extras (N+1 over the messages and characters
 *  repos): the client organizes chats BY CHARACTER, so every summary carries
 *  the owning character's identity alongside the message stats. */
interface ChatSummary extends Chat {
  character_name: string;
  character_avatar_path: string | null;
  message_count: number;
  last_preview: string | null;
}

/** Length cap (chars) for the `last_preview` of a chat list item. */
const PREVIEW_MAX = 200;

/** Default page size when `?limit=` is absent. */
const LIST_LIMIT_DEFAULT = 100;
/** Hard ceiling; larger numeric limits are clamped down to this. */
const LIST_LIMIT_MAX = 500;

/**
 * Query schema for GET /api/chats paging.
 *
 * `z.coerce.number()` accepts numeric query strings; non-numeric values become
 * NaN, which `.int()`/`.min(0)` reject → 400. Empty values are mapped to
 * `undefined` by the handler before parsing, so `?limit=` means "absent".
 * `limit` is deliberately NOT bounded here: a numeric limit outside 1..500 is
 * clamped in the handler (a friendly page-size request should not 400), while
 * `offset` must be a non-negative integer or it is rejected.
 *
 * `offset` is additionally capped at `Number.MAX_SAFE_INTEGER`: Zod's `.int()`
 * accepts integers far beyond 2^63, and binding one to `LIMIT ? OFFSET ?`
 * throws `datatype mismatch` in bun:sqlite — an unhandled 500 instead of the
 * `{error, details}` shape. Beyond the safe-integer range the value cannot
 * identify a real row anyway, so 400 is the honest answer.
 */
const listQuerySchema = z.object({
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

/** Empty query values count as absent, disabling that filter. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

const createChatSchema = z.object({
  character_id: z.string().min(1),
  persona_id: z.string().min(1).optional(),
  title: z.string().optional(),
});

const patchChatSchema = z.object({
  title: z.string().nullable().optional(),
  persona_id: z.string().nullable().optional(),
});

const forkChatSchema = z.object({
  from_message_id: z.string().min(1),
  title: z.string().optional(),
});

function chatSummary(
  deps: RouteDeps,
  chat: Chat,
  /** Per-request character memo so a list resolves each character once. */
  characters: Map<string, Character | null>,
): ChatSummary {
  const active = deps.repos.messages.listActive(chat.id);
  const content = active[active.length - 1]?.content ?? null;
  let character = characters.get(chat.character_id);
  if (character === undefined) {
    character = deps.repos.characters.get(chat.character_id);
    characters.set(chat.character_id, character);
  }
  return {
    ...chat,
    // Chats are deleted before their character (repo contract), so a miss is
    // a data-integrity edge — degrade to a placeholder name rather than failing.
    character_name: character?.name ?? "Unknown character",
    character_avatar_path: character?.avatar_path ?? null,
    message_count: active.length,
    last_preview:
      content !== null && content.length > PREVIEW_MAX
        ? `${content.slice(0, PREVIEW_MAX)}...`
        : content,
  };
}

export function chatsRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/api/chats", (c) => {
    const raw = c.req.query();
    const parsed = listQuerySchema.safeParse({
      limit: nonEmpty(raw.limit),
      offset: nonEmpty(raw.offset),
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
    // Empty `?character_id=` means "every chat", matching the other filters.
    const characterId = nonEmpty(raw.character_id);
    const chats = deps.repos.chats.list({ characterId, limit, offset });
    // The page is already N+1 over messages; this map keeps the character
    // lookups at one per distinct character per request instead of per chat.
    // Paging now bounds both to the returned page's size.
    const characters = new Map<string, Character | null>();
    const items = chats.map((chat) => chatSummary(deps, chat, characters));
    return c.json({
      items,
      total: deps.repos.chats.count(characterId),
      limit,
      offset,
    });
  });

  app.post("/api/chats", async (c) => {
    const parsed = parseJsonBody(createChatSchema, await c.req.json().catch(() => null));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const character = deps.repos.characters.get(parsed.value.character_id);
    if (!character) {
      return c.json({ error: `character ${parsed.value.character_id} not found` }, 404);
    }
    let persona: Persona | null = null;
    if (parsed.value.persona_id !== undefined) {
      persona = deps.repos.personas.get(parsed.value.persona_id);
      if (!persona) {
        return c.json({ error: `persona ${parsed.value.persona_id} not found` }, 404);
      }
    }
    const chat = deps.repos.chats.create({
      character_id: character.id,
      persona_id: persona?.id ?? null,
      title: parsed.value.title ?? null,
    });
    // Null when the character has no first_mes — the chat then starts empty.
    const greeting = insertGreeting(deps.repos, chat, character, persona);
    return c.json({ chat, greeting }, 201);
  });

  app.get("/api/chats/:id", (c) => {
    const chat = deps.repos.chats.get(c.req.param("id"));
    if (!chat) {
      return c.json({ error: "chat not found" }, 404);
    }
    return c.json(chat);
  });

  app.patch("/api/chats/:id", async (c) => {
    const parsed = parseJsonBody(patchChatSchema, await c.req.json().catch(() => null));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const personaId = parsed.value.persona_id;
    if (typeof personaId === "string" && !deps.repos.personas.get(personaId)) {
      return c.json({ error: `persona ${personaId} not found` }, 404);
    }
    const updated = deps.repos.chats.update(c.req.param("id"), {
      title: parsed.value.title,
      persona_id: personaId,
    });
    if (!updated) {
      return c.json({ error: "chat not found" }, 404);
    }
    return c.json(updated);
  });

  app.delete("/api/chats/:id", (c) => {
    if (!deps.repos.chats.delete(c.req.param("id"))) {
      return c.json({ error: "chat not found" }, 404);
    }
    return c.json({ ok: true });
  });

  app.post("/api/chats/:id/fork", async (c) => {
    const id = c.req.param("id");
    const parsed = parseJsonBody(forkChatSchema, await c.req.json().catch(() => null));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const point = deps.repos.messages.get(parsed.value.from_message_id);
    if (!point || point.chat_id !== id) {
      return c.json({ error: "fork point message not found in chat" }, 404);
    }
    const fork = deps.repos.chats.forkChat(parsed.value.from_message_id, {
      title: parsed.value.title,
    });
    return c.json({ id: fork.id, chat: fork }, 201);
  });

  return app;
}
