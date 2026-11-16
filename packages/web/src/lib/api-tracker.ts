/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { api } from "./api";

/**
 * Tracker API — typed wrappers for the server's Suvoj Tracker surface
 * (packages/server/src/routes/tracker.ts).
 */

/** One generated tracker state (the wire shape of a snapshot row). */
export interface TrackerSnapshotDto {
  id: string;
  /** The message/swipe row the snapshot is attached to (the selected
   *  variant); null for manual runs. */
  message_id: string | null;
  /** The schema preset the snapshot was generated against. */
  schema_key: string;
  /** The JSON the tracker model produced (the template data root). */
  data: Record<string, unknown>;
  created_at: string;
}

/** GET/POST /api/chats/:id/tracker response: config flags, the latest
 *  snapshot, and the active schema preset's rendering (`render` present
 *  whenever the tracker is enabled — even without a snapshot). */
export interface ChatTrackerResponse {
  /** The GLOBAL master switch (`tracker_config.enabled`). */
  enabled: boolean;
  /** This chat's own switch (`chats.tracker_enabled`). Tracking runs only
   *  when both are on; the drawer renders its toggle from this. */
  chat_enabled: boolean;
  /** True hides the tracker UI while snapshots keep injecting into prompts. */
  invisible: boolean;
  mechanism: string;
  snapshot: TrackerSnapshotDto | null;
  render: { html: string; css: string } | null;
}

/** GET /api/messages/:id/tracker response: ONE message/swipe row's own newest
 *  snapshot and the active preset's rendering. Both are null when the row has
 *  no tracker, and `render` is present iff `snapshot` is. Unlike the chat
 *  payload this is read lazily per swipe and ignores the enabled/injection
 *  settings, so a persisted snapshot stays viewable after the tracker is
 *  turned off. */
export interface MessageTrackerResponse {
  snapshot: TrackerSnapshotDto | null;
  render: { html: string; css: string } | null;
}

export function getChatTracker(chatId: string): Promise<ChatTrackerResponse> {
  return api(`/api/chats/${encodeURIComponent(chatId)}/tracker`);
}

/** Reads the tracker attached to one message/swipe row (the hover action's
 *  viewer) — `{ snapshot: null, render: null }` when the row has none. */
export function getMessageTracker(messageId: string): Promise<MessageTrackerResponse> {
  return api(`/api/messages/${encodeURIComponent(messageId)}/tracker`);
}

/** Runs one manual tracker generation; the response carries the fresh snapshot. */
export function generateChatTracker(chatId: string): Promise<ChatTrackerResponse> {
  return api(`/api/chats/${encodeURIComponent(chatId)}/tracker/generate`, { method: "POST" });
}

/** Flips this chat's own tracker switch (the global master is a Settings
 *  key); responds with the summary payload so the panel repaints from truth. */
export function setChatTrackerEnabled(
  chatId: string,
  enabled: boolean,
): Promise<ChatTrackerResponse> {
  return api(`/api/chats/${encodeURIComponent(chatId)}/tracker/enabled`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

/** Drops the tracker(s) attached to one message/swipe row (204 — resolves
 *  with undefined). A chat-wide clear is {@link deleteChatTracker}. */
export function deleteMessageTracker(messageId: string): Promise<void> {
  return api(`/api/messages/${encodeURIComponent(messageId)}/tracker`, { method: "DELETE" });
}

/** Clears every tracker of the chat — all messages and swipes
 *  (204 — resolves with undefined). */
export function deleteChatTracker(chatId: string): Promise<void> {
  return api(`/api/chats/${encodeURIComponent(chatId)}/tracker`, { method: "DELETE" });
}
