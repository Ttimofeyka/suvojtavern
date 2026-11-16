/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PromptMessage } from "../engine/prompt";

/**
 * Builds the messages for AI-assisted lorebook entry generation.
 *
 * The system message is the caller-resolved system prompt (from the stored
 * config), and the user block carries the varying inputs as stable,
 * clearly-labelled plain text in a fixed order: DESCRIPTION, INSTRUCTIONS,
 * then the CURRENT CONTENT. Empty inputs render explicit placeholders so the
 * model never sees a bare label, and the block stays byte-stable for tests.
 */

/** Inputs the user block renders (the system prompt comes from the stored config). */
export interface LorebookEntryPromptInput {
  systemPrompt: string;
  description: string;
  instructions: string;
  currentContent: string;
}

/** Builds the system + user messages for one lorebook entry generation. */
export function buildLorebookEntryMessages(input: LorebookEntryPromptInput): PromptMessage[] {
  const description =
    input.description.trim() !== ""
      ? input.description
      : "(none provided — write a fitting entry from the instructions)";
  const instructions = input.instructions.trim() !== "" ? input.instructions : "(none)";
  const currentContent = input.currentContent.trim() !== "" ? input.currentContent : "(none)";
  const user = [
    `DESCRIPTION: ${description}`,
    `INSTRUCTIONS: ${instructions}`,
    `CURRENT CONTENT: ${currentContent}`,
  ].join("\n");
  return [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: user },
  ];
}
