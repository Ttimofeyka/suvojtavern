/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { api } from "./api";

/** Chat roles a message can carry (mirrors @suvoj/core's MessageRole). */
export type MessageRole = "system" | "user" | "assistant";

export interface MessageVariant {
  id: string;
  content: string;
  active: boolean;
  created_at: string;
  /** Whether this ROW (one swipe) carries a tracker snapshot. Server-derived
   *  and per-swipe — independent of the tracker's enabled switch and of its
   *  injection count, so an old snapshot on a hidden swipe is still flagged.
   *  The message hover's tracker action renders only when it is true. */
  has_tracker: boolean;
}

/** All swipes that share one chat position (`seq`); `active_id` picks the shown one. */
export interface MessageGroup {
  seq: number;
  role: MessageRole;
  name: string | null;
  /** Id of the group's chosen swipe; null only for a corrupted group. */
  active_id: string | null;
  variants: MessageVariant[];
}

/** A stored chat row (GET /api/chats/:id, POST /api/chats, …). */
export interface ChatInfo {
  id: string;
  character_id: string;
  persona_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  branch_root_id: string | null;
  active_branch: string | null;
}

/** Chat row plus the list-view extras (GET /api/chats returns these flat):
 *  the owning character's identity (chats are organized BY CHARACTER) next
 *  to the message stats. */
export interface ChatSummaryInfo extends ChatInfo {
  character_name: string;
  character_avatar_path: string | null;
  message_count: number;
  last_preview: string | null;
}

/** Envelope returned by GET /api/chats: the requested window plus the unpaged
 *  `total`, so the sidebar can append pages and stop at the end. */
export interface ChatListPage {
  items: ChatSummaryInfo[];
  total: number;
  limit: number;
  offset: number;
}

/** Default page size for the chat list; the endpoint clamps to 1..500. */
export const CHAT_PAGE_SIZE = 50;

/** Filters and paging accepted by {@link listChats}. */
export interface ChatListParams {
  characterId?: string;
  limit?: number;
  offset?: number;
}

/** A stored message row (addMessage / editMessage responses). */
export interface MessageInfo {
  id: string;
  chat_id: string;
  seq: number;
  role: MessageRole;
  name: string | null;
  content: string;
  variant_of: string | null;
  active: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface CreateChatInput {
  character_id: string;
  persona_id?: string;
  title?: string;
}

export interface UpdateChatInput {
  title?: string | null;
  persona_id?: string | null;
}

export interface AddMessageInput {
  role: MessageRole;
  content: string;
  name?: string;
}

/** Response of POST /api/chats — the fresh chat plus its greeting group
 *  (null when the character has no first_mes; the chat then starts empty). */
export interface CreateChatResult {
  chat: ChatInfo;
  greeting: MessageGroup | null;
}

export interface ForkChatResult {
  id: string;
  chat: ChatInfo;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** Chats of one character (or every character's), newest activity first.
 *  Always sends `limit`; omits `offset` at 0 and `character_id` when unset,
 *  matching the server's "an empty query value counts as absent" rule. */
export function listChats(params?: ChatListParams): Promise<ChatListPage> {
  const query = new URLSearchParams();
  if (params?.characterId !== undefined) {
    query.set("character_id", params.characterId);
  }
  query.set("limit", String(params?.limit ?? CHAT_PAGE_SIZE));
  if (params?.offset !== undefined && params.offset > 0) {
    query.set("offset", String(params.offset));
  }
  return api<ChatListPage>(`/api/chats?${query.toString()}`);
}

/** Creates a chat and inserts the character's greeting as its first group
 *  (no group when the character has no first_mes). */
export function createChat(input: CreateChatInput): Promise<CreateChatResult> {
  return api("/api/chats", jsonInit("POST", input));
}

export function getChat(id: string): Promise<ChatInfo> {
  return api(`/api/chats/${id}`);
}

export function updateChat(id: string, patch: UpdateChatInput): Promise<ChatInfo> {
  return api(`/api/chats/${id}`, jsonInit("PATCH", patch));
}

export function deleteChat(id: string): Promise<{ ok: boolean }> {
  return api(`/api/chats/${id}`, { method: "DELETE" });
}

/** Forks a chat into a new branch starting at `fromMessageId`. */
export function forkChat(
  id: string,
  fromMessageId: string,
  title?: string,
): Promise<ForkChatResult> {
  return api(`/api/chats/${id}/fork`, jsonInit("POST", { from_message_id: fromMessageId, title }));
}

/** All message groups of a chat (every swipe), ordered by position. */
export function listMessages(
  chatId: string,
  window?: { before?: number; from?: number; limit?: number },
): Promise<MessageGroup[]> {
  const query = new URLSearchParams();
  if (window?.before !== undefined) query.set("before", String(window.before));
  if (window?.from !== undefined) query.set("from", String(window.from));
  if (window?.limit !== undefined) query.set("limit", String(window.limit));
  return api(`/api/chats/${chatId}/messages${query.size ? `?${query}` : ""}`);
}

/** Appends a message as a new active position at the end of the chat. */
export function addMessage(chatId: string, input: AddMessageInput): Promise<MessageInfo> {
  return api(`/api/chats/${chatId}/messages`, jsonInit("POST", input));
}

export function editMessage(messageId: string, content: string): Promise<MessageInfo> {
  return api(`/api/messages/${messageId}`, jsonInit("PATCH", { content }));
}

export function activateMessage(messageId: string): Promise<{ ok: boolean }> {
  return api(`/api/messages/${messageId}/activate`, { method: "POST" });
}

export function deleteMessage(messageId: string): Promise<{ ok: boolean }> {
  return api(`/api/messages/${messageId}`, { method: "DELETE" });
}

/** Bulk-deletes every message at or after position `fromSeq` (inclusive). */
export function deleteMessagesFrom(
  chatId: string,
  fromSeq: number,
): Promise<{ ok: boolean; deleted: number }> {
  return api(`/api/chats/${chatId}/messages/delete-from`, jsonInit("POST", { from_seq: fromSeq }));
}
