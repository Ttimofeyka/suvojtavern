/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Character, Chat, Persona } from "@suvoj/core";
import { engine } from "@suvoj/core";
import type { Repos } from "../routes-deps";
import type { MessageGroup, MessageVariant } from "./messages";

/**
 * Inserts the opening message of a fresh chat with SillyTavern parity:
 * `first_mes` becomes the active first assistant message (named after the
 * character) and every `alternate_greetings` entry is added as an inactive
 * swipe variant of it, so swiping cycles through the greetings.
 *
 * A character with no greeting (empty or whitespace-only `first_mes`) gets
 * no opening message at all: alternate greetings are swipes OF the greeting,
 * so they only apply when one exists — the function returns null and the chat
 * starts empty.
 *
 * Macros are evaluated with the same context shape the engine builds for
 * generation: {{char}} / {{user}} / {{persona}}, chat-scoped variables.
 */
export function insertGreeting(
  repos: Repos,
  chat: Chat,
  character: Character,
  persona: Persona | null,
): MessageGroup | null {
  if (character.first_mes.trim() === "") {
    return null;
  }
  const macros: engine.MacroContext = {
    char: character.name,
    user: persona?.name ?? "User",
    persona: persona?.description ?? "",
    chatId: chat.id,
    vars: repos.variables,
  };
  const greeting = repos.messages.insertMessage(chat.id, {
    role: "assistant",
    name: character.name,
    content: engine.evaluateMacros(character.first_mes, macros),
  });
  const variants: MessageVariant[] = [
    {
      id: greeting.id,
      content: greeting.content,
      active: true,
      created_at: greeting.created_at,
      metadata: greeting.metadata,
      // Freshly inserted: no tracker could have been generated for it yet.
      has_tracker: false,
    },
  ];
  for (const alternate of character.alternate_greetings) {
    const variant = repos.messages.addVariant(
      chat.id,
      greeting.id,
      engine.evaluateMacros(alternate, macros),
      "assistant",
      { name: character.name },
    );
    variants.push({
      id: variant.id,
      content: variant.content,
      active: variant.active,
      created_at: variant.created_at,
      metadata: variant.metadata,
      has_tracker: false,
    });
  }
  return {
    seq: greeting.seq,
    role: greeting.role,
    name: greeting.name,
    active_id: greeting.id,
    variants,
  };
}
