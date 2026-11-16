/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CharactersRepository } from "../repositories/characters";
import type { ChatsRepository } from "../repositories/chats";
import type { MessagesRepository } from "../repositories/messages";
import type { Chat } from "../schema/chats";
import type { Message } from "../schema/messages";

/**
 * SillyTavern chat JSONL import. Each line is one message position with
 * its swipes: `mes` is the chosen swipe, `swipes` are all variants,
 * `swipe_id` picks the active one. Native mapping: one message group per
 * line — `insertMessage` for the first swipe, `addVariant` for the rest,
 * `setActiveVariant` for `swipe_id`. A real file opens with a
 * `{"chat_metadata":…}` HEADER line that carries no `mes`/swipes; it is
 * file metadata, not a message, and is skipped rather than imported as a
 * spurious empty position.
 */

// --- line parsing ---------------------------------------------------------------

interface StChatLine {
  name?: unknown;
  user_name?: unknown;
  character_name?: unknown;
  is_user?: unknown;
  is_system?: unknown;
  send_date?: unknown;
  mes?: unknown;
  swipe_id?: unknown;
  swipes?: unknown;
  extra?: unknown;
  /** Present only on the file's leading header line (file-level metadata). */
  chat_metadata?: unknown;
}

function asLine(value: unknown): StChatLine | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as StChatLine) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asSwipes(line: StChatLine): string[] {
  if (!Array.isArray(line.swipes)) {
    return [];
  }
  return line.swipes.filter((swipe): swipe is string => typeof swipe === "string");
}

/** ST `send_date`: epoch ms/s number, numeric string, or a date string. */
function parseSendDate(value: unknown): Date | null {
  let raw: number | string | null = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    raw = value;
  } else if (typeof value === "string") {
    const asNumber = Number(value);
    raw = Number.isFinite(asNumber) && value.trim() !== "" ? asNumber : value;
  }
  if (raw === null) {
    return null;
  }
  if (typeof raw === "number") {
    // Seconds vs milliseconds heuristics.
    const ms = raw > 1e12 ? raw : raw > 1e9 ? raw * 1000 : null;
    return ms !== null && ms <= Date.now() + 86_400_000 * 366 ? new Date(ms) : null;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function metadataOf(line: StChatLine): Record<string, unknown> | null {
  const metadata: Record<string, unknown> = {};
  const sent = parseSendDate(line.send_date);
  if (sent) {
    metadata.created_at = sent.toISOString();
  } else if (line.send_date !== undefined && line.send_date !== null) {
    metadata.send_date = line.send_date;
  }
  if (line.extra && typeof line.extra === "object") {
    metadata.extra = line.extra;
    // ST's reasoning display stores thinking in extra.reasoning (+ a ms
    // duration in extra.reasoning_duration). Hoist both to top-level
    // metadata so the native reasoning surface sees imported thinking without
    // digging through `extra`; the duration is only meaningful alongside
    // reasoning, so they hoist as a pair. `extra` itself is kept verbatim.
    const extra = line.extra as { reasoning?: unknown; reasoning_duration?: unknown };
    if (typeof extra.reasoning === "string" && extra.reasoning !== "") {
      metadata.reasoning = extra.reasoning;
      if (typeof extra.reasoning_duration === "number") {
        metadata.reasoning_duration_ms = extra.reasoning_duration;
      }
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

/** Parses JSONL text (or a pre-parsed line array) into chat lines. */
function parseChatLines(raw: string | unknown[]): StChatLine[] {
  const values = typeof raw === "string" ? raw.split(/\r?\n/) : raw;
  const lines: StChatLine[] = [];
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : value;
    if (text === "" || text === null || text === undefined) {
      continue;
    }
    const parsed = typeof text === "string" ? (JSON.parse(text) as unknown) : text;
    const line = asLine(parsed);
    if (line) {
      lines.push(line);
    }
  }
  return lines;
}

// --- import ------------------------------------------------------------------------

/** The repositories the chat importer touches. */
export interface ChatImportRepos {
  characters: CharactersRepository;
  chats: ChatsRepository;
  messages: MessagesRepository;
}

export interface ChatImportOptions {
  /** Target character id; required unless resolvable via `character_name`. */
  characterId?: string;
  /** Character to attach the chat to; overrides the file's `character_name`. */
  characterName?: string;
  personaId?: string | null;
  /** Chat title (the server usually passes the file name stem). */
  title?: string | null;
}

export interface ChatImportResult {
  chat: Chat;
  /** Active messages (one per position), in order. */
  messages: Message[];
}

export function importChat(
  raw: string | unknown[],
  repos: ChatImportRepos,
  opts: ChatImportOptions = {},
): ChatImportResult {
  const lines = parseChatLines(raw);

  // A real SillyTavern file opens with a `{"chat_metadata":{…}}` header line,
  // which is file metadata, not a message. Only import lines that actually
  // carry a message, i.e. a string `mes`; anything else (the header, or a
  // malformed line without `mes`) is skipped. `mes: ""` is still a string, so
  // a legitimately empty message is preserved. Character resolution below
  // scans ALL parsed lines — including the header — exactly as before.
  const messageLines = lines.filter(
    (line) => line.chat_metadata === undefined && typeof line.mes === "string",
  );

  // Character resolution: explicit id → explicit name → the file's
  // character_name (case-insensitive); anything else is an error.
  let characterId = opts.characterId ?? null;
  if (!characterId) {
    const characterName =
      opts.characterName ??
      asString(lines.find((line) => asString(line.character_name))?.character_name);
    if (!characterName) {
      throw new Error("chat import requires a target character (characterId or character_name)");
    }
    const found = repos.characters
      .list()
      .find((character) => character.name.toLowerCase() === characterName.toLowerCase());
    if (!found) {
      throw new Error(`no character named "${characterName}" for chat import`);
    }
    characterId = found.id;
  }

  const chat = repos.chats.create({
    character_id: characterId,
    persona_id: opts.personaId ?? null,
    title: opts.title ?? null,
  });

  for (const line of messageLines) {
    const role = line.is_user === true ? "user" : line.is_system === true ? "system" : "assistant";
    const content = typeof line.mes === "string" ? line.mes : "";
    const name = asString(line.name);
    const metadata = metadataOf(line);
    const swipes = asSwipes(line);

    if (swipes.length <= 1) {
      repos.messages.insertMessage(chat.id, { role, content, name, metadata });
      continue;
    }
    // Swipe group: first swipe is the root, the rest are sibling variants.
    const first = asString(swipes[0]) ?? content;
    const root = repos.messages.insertMessage(chat.id, { role, content: first, name, metadata });
    const groupIds = [root.id];
    for (let index = 1; index < swipes.length; index += 1) {
      groupIds.push(
        repos.messages.addVariant(chat.id, root.id, swipes[index] ?? "", role, { name, metadata })
          .id,
      );
    }
    const swipeId =
      typeof line.swipe_id === "number" && Number.isInteger(line.swipe_id)
        ? Math.min(Math.max(line.swipe_id, 0), groupIds.length - 1)
        : 0;
    if (swipeId > 0) {
      const target = groupIds[swipeId];
      if (target) {
        repos.messages.setActiveVariant(target);
      }
    }
  }

  return { chat, messages: repos.messages.listActive(chat.id) };
}
