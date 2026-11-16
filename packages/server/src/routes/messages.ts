/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Message } from "@suvoj/core";
import { messageRoleSchema } from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import type { RouteDeps } from "../routes-deps";
import { parseJsonBody } from "../routes-deps";

/** One swipe of a message group. */
export interface MessageVariant {
  id: string;
  content: string;
  active: boolean;
  /** The swipe row's creation time (ISO 8601) — client message timestamp. */
  created_at: string;
  /** The swipe row's free-form metadata (e.g. persisted reasoning), verbatim. */
  metadata: Record<string, unknown> | null;
  /** Whether this ROW (one swipe) carries ≥1 tracker snapshot. */
  has_tracker: boolean;
}

/** All swipes that share one chat position (seq). */
export interface MessageGroup {
  seq: number;
  role: Message["role"];
  name: string | null;
  /** Id of the group's chosen swipe; null only for a corrupted group. */
  active_id: string | null;
  variants: MessageVariant[];
}

/**
 * Groups a chat's messages (as returned by `listAll`) by their shared seq.
 *
 * `trackedIds` is the set of message ROWS that carry a tracker snapshot (from
 * `listTrackedMessageIds`); a variant is flagged `has_tracker` when its row is
 * in it. Optional, defaulting to "no row is tracked", so the grouping stays
 * usable without a repository read.
 */
export function groupMessages(
  messages: Message[],
  trackedIds?: ReadonlySet<string>,
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let current: MessageGroup | null = null;
  for (const message of messages) {
    if (current === null || current.seq !== message.seq) {
      current = {
        seq: message.seq,
        role: message.role,
        name: message.name,
        active_id: null,
        variants: [],
      };
      groups.push(current);
    }
    current.variants.push({
      id: message.id,
      content: message.content,
      active: message.active,
      created_at: message.created_at,
      metadata: message.metadata,
      has_tracker: trackedIds?.has(message.id) ?? false,
    });
    if (message.active) {
      current.active_id = message.id;
    }
  }
  return groups;
}

const createMessageSchema = z.object({
  role: messageRoleSchema,
  content: z.string(),
  name: z.string().optional(),
});

const editMessageSchema = z.object({ content: z.string() });

/** Body of the bulk delete: `from_seq` is the 1-based chat position from
 *  which every swipe variant to the end of the chat is removed. */
const deleteFromSchema = z.object({
  from_seq: z.number().int().min(1),
});

const messageWindowSchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  from: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(501).optional(),
});

export function messagesRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/api/chats/:id/messages", (c) => {
    const id = c.req.param("id");
    if (!deps.repos.chats.get(id)) {
      return c.json({ error: "chat not found" }, 404);
    }
    const query = messageWindowSchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: "Invalid message window" }, 400);
    }
    const { before, from, limit } = query.data;
    const messages =
      before === undefined && from === undefined && limit === undefined
        ? deps.repos.messages.listAll(id)
        : deps.repos.messages.listWindow(id, query.data);
    return c.json(groupMessages(messages, deps.repos.trackers.listTrackedMessageIds(id)));
  });

  app.post("/api/chats/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!deps.repos.chats.get(id)) {
      return c.json({ error: "chat not found" }, 404);
    }
    const parsed = parseJsonBody(createMessageSchema, await c.req.json().catch(() => null));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const message = deps.repos.messages.insertMessage(id, {
      role: parsed.value.role,
      content: parsed.value.content,
      name: parsed.value.name ?? null,
    });
    return c.json(message, 201);
  });

  // SillyTavern's "delete selected message and everything below": wipes
  // every swipe variant from `from_seq` to the end of the chat in one
  // transaction. A position beyond the last message deletes nothing and is
  // not an error.
  app.post("/api/chats/:id/messages/delete-from", async (c) => {
    const id = c.req.param("id");
    if (!deps.repos.chats.get(id)) {
      return c.json({ error: "chat not found" }, 404);
    }
    const parsed = parseJsonBody(deleteFromSchema, await c.req.json().catch(() => null));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const deleted = deps.repos.messages.deleteFromSeq(id, parsed.value.from_seq);
    return c.json({ ok: true, deleted });
  });

  app.patch("/api/messages/:id", async (c) => {
    const parsed = parseJsonBody(editMessageSchema, await c.req.json().catch(() => null));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const updated = deps.repos.messages.editMessageContent(c.req.param("id"), parsed.value.content);
    if (!updated) {
      return c.json({ error: "message not found" }, 404);
    }
    return c.json(updated);
  });

  app.post("/api/messages/:id/activate", (c) => {
    const id = c.req.param("id");
    if (!deps.repos.messages.get(id)) {
      return c.json({ error: "message not found" }, 404);
    }
    deps.repos.messages.setActiveVariant(id);
    return c.json({ ok: true });
  });

  // SillyTavern's trash: removes the message at this position with every
  // swipe, so the position itself disappears (not just one variant).
  app.delete("/api/messages/:id", (c) => {
    if (!deps.repos.messages.deleteMessageGroup(c.req.param("id"))) {
      return c.json({ error: "message not found" }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}
