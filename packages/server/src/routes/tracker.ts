/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { gatewayStatus } from "../gateway";
import type { RouteDeps } from "../routes-deps";
import { parseJsonBody } from "../routes-deps";
import {
  generateTrackerSnapshot,
  TrackerRequestError,
  type TrackerSummaryPayload,
  trackerSnapshotForMessage,
  trackerSummaryPayload,
} from "../tracker/service";

/**
 * Tracker routes (the Suvoj Tracker surface):
 *
 * - `GET    /api/chats/:id/tracker` — the summary payload: config flags,
 *   the latest snapshot, and the active schema preset's rendering.
 * - `POST   /api/chats/:id/tracker/generate` — one manual tracker run
 *   (the same service the auto modes call); responds with the summary
 *   payload, the fresh snapshot as its `snapshot`.
 * - `PUT    /api/chats/:id/tracker/enabled` — flips THIS chat's own
 *   `tracker_enabled` switch (the global master stays `tracker_config.enabled`);
 *   responds with the summary payload so the panel repaints from server truth.
 * - `DELETE /api/chats/:id/tracker` — drops every snapshot of the chat.
 * - `GET    /api/messages/:id/tracker` — one message ROW's newest snapshot
 *   plus the active preset's rendering (both null when untracked).
 * - `DELETE /api/messages/:id/tracker` — drops the snapshots attached to one
 *   message (a swipe) only.
 */

/** Body for PUT /tracker/enabled — the chat's own tracker switch. */
const trackerEnabledSchema = z.object({ enabled: z.boolean() });

/** Maps service failures to responses: 400 for request-shaped errors
 *  (disabled / nothing to track / no profile); a client-status GatewayError
 *  (e.g. the 400 for an unconfigured profile) passes its status through;
 *  every other upstream failure is a 502 with the underlying message. */
function trackerErrorResponse(err: unknown): {
  status: ContentfulStatusCode;
  body: { error: string };
} {
  if (err instanceof TrackerRequestError) {
    return { status: 400, body: { error: err.message } };
  }
  const message =
    err instanceof Error && err.message !== "" ? err.message : "Tracker generation failed";
  return { status: gatewayStatus(err), body: { error: message } };
}

export function trackerRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/api/chats/:id/tracker", (c) => {
    const chatId = c.req.param("id");
    if (!deps.repos.chats.get(chatId)) {
      return c.json({ error: "Chat not found" }, 404);
    }
    return c.json(trackerSummaryPayload(deps.repos, chatId));
  });

  app.post("/api/chats/:id/tracker/generate", async (c) => {
    const chatId = c.req.param("id");
    if (!deps.repos.chats.get(chatId)) {
      return c.json({ error: "Chat not found" }, 404);
    }
    try {
      await generateTrackerSnapshot(deps, chatId, { signal: c.req.raw.signal });
    } catch (err) {
      const { status, body } = trackerErrorResponse(err);
      return c.json(body, status);
    }
    // The fresh snapshot is the chat's latest — the shared summary payload
    // picks it up (same shape as the GET response).
    const payload: TrackerSummaryPayload = trackerSummaryPayload(deps.repos, chatId);
    return c.json(payload);
  });

  app.delete("/api/chats/:id/tracker", (c) => {
    const chatId = c.req.param("id");
    if (!deps.repos.chats.get(chatId)) {
      return c.json({ error: "Chat not found" }, 404);
    }
    deps.repos.trackers.deleteByChat(chatId);
    return c.body(null, 204);
  });

  // Per-chat switch: flips `chats.tracker_enabled` and answers with the
  // summary payload, so the panel (and the header pill) repaint from server
  // truth. The global master is untouched — with it off, turning a chat's
  // switch on changes nothing until the master is on again.
  app.put("/api/chats/:id/tracker/enabled", async (c) => {
    const chatId = c.req.param("id");
    if (!deps.repos.chats.get(chatId)) {
      return c.json({ error: "Chat not found" }, 404);
    }
    const parsed = parseJsonBody(trackerEnabledSchema, await c.req.json().catch(() => null));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    deps.repos.chats.update(chatId, { tracker_enabled: parsed.value.enabled });
    return c.json(trackerSummaryPayload(deps.repos, chatId));
  });

  // Per-swipe tracker read: ONE message ROW's newest snapshot plus the active
  // preset's rendering. Deliberately idempotent — no message-exists guard and
  // no master-switch/injection gate (mirroring the DELETE below): an unknown
  // or untracked id yields `{ snapshot: null, render: null }` with a 200, and
  // a row that carries a snapshot stays readable even while the tracker is
  // disabled. The web calls this lazily per variant flagged `has_tracker`.
  app.get("/api/messages/:id/tracker", (c) => {
    return c.json(trackerSnapshotForMessage(deps.repos, c.req.param("id")));
  });

  // Per-swipe delete: removes the snapshots attached to ONE message row,
  // leaving every other swipe's tracker intact (the chat-wide DELETE above
  // clears all of them). Deliberately idempotent — no message-exists guard:
  // a stale client may target a row the deletion cascade already removed,
  // and deleting the (by then orphaned) snapshots of a missing message is a
  // harmless no-op, so this always answers 204 rather than 404.
  app.delete("/api/messages/:id/tracker", (c) => {
    deps.repos.trackers.deleteForMessage(c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}
