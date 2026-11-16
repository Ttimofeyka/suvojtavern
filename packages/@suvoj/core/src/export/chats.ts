/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Message } from "../schema/messages";

/**
 * Chat export into SillyTavern JSONL: one line per message position, with
 * the active swipe in `mes` and the full variant set in `swipes`.
 */

export interface ChatExportOptions {
  /** Name used for user lines without a stored name (default "User"). */
  userName?: string;
  /** Character name; also written as the file's `character_name` header. */
  characterName?: string;
}

/** One message group: the root plus its swipes, root first. */
function groupMessages(messages: ReadonlyArray<Message>): Message[][] {
  const groups: Message[][] = [];
  const byRoot = new Map<string, Message[]>();
  for (const message of messages) {
    if (message.variant_of === null) {
      const group = [message];
      groups.push(group);
      byRoot.set(message.id, group);
    } else {
      const group = byRoot.get(message.variant_of);
      if (group) {
        group.push(message);
      } else {
        // Orphaned variant (root deleted): keep it as its own position.
        groups.push([message]);
      }
    }
  }
  return groups;
}

function sendDateOf(message: Message): string | number {
  const metadata = message.metadata ?? {};
  if (typeof metadata.created_at === "string") {
    return metadata.created_at;
  }
  if (typeof metadata.send_date === "string" || typeof metadata.send_date === "number") {
    return metadata.send_date;
  }
  return message.created_at;
}

/**
 * Serializes a chat into ST JSONL text (pass `messages.listAll(chatId)` —
 * all messages, swipes included). The first line carries the
 * `user_name`/`character_name` header fields ST expects.
 */
export function exportChat(messages: ReadonlyArray<Message>, opts: ChatExportOptions = {}): string {
  const userName = opts.userName ?? "User";
  const groups = groupMessages(messages);
  const lines: Array<Record<string, unknown>> = [];

  groups.forEach((group, groupIndex) => {
    const activeIndex = Math.max(
      group.findIndex((message) => message.active),
      0,
    );
    const active = group[activeIndex] ?? group[0];
    if (!active) {
      return;
    }
    const line: Record<string, unknown> = {
      name:
        active.name ??
        (active.role === "user" ? userName : (opts.characterName ?? active.name ?? "Character")),
      is_user: active.role === "user",
      is_system: active.role === "system",
      send_date: sendDateOf(active),
      mes: active.content,
      swipe_id: activeIndex,
      swipes: group.map((message) => message.content),
    };
    if (groupIndex === 0) {
      line.user_name = userName;
      line.character_name = opts.characterName ?? null;
    }
    // ST's reasoning display reads extra.reasoning / extra.reasoning_duration;
    // re-emit stored thinking on the line under ST's own field names. Any
    // other metadata.extra fields ride along so the export stays lossless.
    const metadata = active.metadata;
    if (metadata && typeof metadata.reasoning === "string" && metadata.reasoning !== "") {
      const extra: Record<string, unknown> =
        metadata.extra && typeof metadata.extra === "object" ? { ...metadata.extra } : {};
      extra.reasoning = metadata.reasoning;
      if (typeof metadata.reasoning_duration_ms === "number") {
        extra.reasoning_duration = metadata.reasoning_duration_ms;
      }
      line.extra = extra;
    }
    lines.push(line);
  });

  return lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length > 0 ? "\n" : "");
}
