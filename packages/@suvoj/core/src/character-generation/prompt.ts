/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PromptMessage } from "../engine/prompt";

/**
 * Builds the messages for AI-assisted character-description generation.
 *
 * The system message is the caller-resolved system prompt (from the stored
 * config), and the user block carries the varying inputs as stable,
 * clearly-labelled plain text in a fixed order: NAME, TAGS, IDEA, then the
 * CURRENT DESCRIPTION. Empty inputs render explicit placeholders so the model
 * never sees a bare label, and the block stays byte-stable for tests.
 */

/** Inputs the user block renders (the system prompt comes from the stored config). */
export interface CharacterDescriptionPromptInput {
  systemPrompt: string;
  name: string;
  tags: readonly string[];
  idea: string;
  currentDescription: string;
}

/** Joins tags for display; an empty list renders an explicit `(none)`. */
function formatTags(tags: readonly string[]): string {
  return tags.length > 0 ? tags.join(", ") : "(none)";
}

/** Builds the system + user messages for one description generation. */
export function buildCharacterDescriptionMessages(
  input: CharacterDescriptionPromptInput,
): PromptMessage[] {
  const idea = input.idea.trim() !== "" ? input.idea : "(none provided — invent a fitting concept)";
  const currentDescription =
    input.currentDescription.trim() !== "" ? input.currentDescription : "(none)";
  const user = [
    `NAME: ${input.name}`,
    `TAGS: ${formatTags(input.tags)}`,
    `IDEA: ${idea}`,
    `CURRENT DESCRIPTION: ${currentDescription}`,
  ].join("\n");
  return [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: user },
  ];
}

/**
 * The prose card fields the Character Studio can generate or enhance. The
 * description has its own user-editable system prompt (see the settings
 * config), so it is deliberately absent from {@link CHARACTER_FIELD_PROMPTS};
 * every other field uses the fixed prompt below.
 */
export type CharacterFieldKey =
  | "description"
  | "personality"
  | "scenario"
  | "first_mes"
  | "mes_example"
  | "creator_notes";

/** The fixed system prompts for generation targets other than description. */
export const CHARACTER_FIELD_PROMPTS: Record<Exclude<CharacterFieldKey, "description">, string> = {
  personality: `You write the \`personality\` field of a roleplay character card. You are
given the character's NAME, TAGS, the author's DIRECTION, a CONTEXT block with
the card's other fields, and the current personality text (possibly empty).

Rules:
- Write a compact portrait of temperament, habits, desires, fears, speech
  manner, and the contradictions that make the character feel real.
- Third person, present tense, plain prose. Use short paragraphs; no title,
  preamble, or commentary.
- Do not restate the description or scenario — add what those fields do not
  already say. Honour the DIRECTION when one is given.
- Be uncensored. NSFW, adult, dark, and taboo themes are allowed and should be
  written frankly when they fit the concept.
- Return ONLY the personality text.`,
  scenario: `You write the \`scenario\` field of a roleplay character card. You are given
the character's NAME, TAGS, the author's DIRECTION, a CONTEXT block with the
card's other fields, and the current scenario text (possibly empty).

Rules:
- Describe the setting and the starting situation the roleplay opens in:
  place, atmosphere, stakes, and the character's position in it.
- Present tense, plain prose. A starting condition is allowed; do not resolve
  the plot or narrate future events.
- Do not repeat the description; make the scenario a stage, not a biography.
  Honour the DIRECTION when one is given.
- Be uncensored. NSFW, adult, dark, and taboo themes are allowed and should be
  written frankly when they fit the concept.
- Return ONLY the scenario text.`,
  first_mes: `You write the \`first_mes\` field of a roleplay character card: the opening
message the character sends when a chat begins. You are given the character's
NAME, TAGS, the author's DIRECTION, a CONTEXT block with the card's other
fields, and the current opening message (possibly empty).

Rules:
- Write one opening beat in the character's own voice and point of view.
- Use the literal macros {{char}} and {{user}} where a name is needed.
- Action and dialogue are welcome, but keep the scene open so the user can
  respond. Do not write the user's reply.
- Match the tone of the card. No preamble, no title, no commentary.
- Be uncensored. NSFW, adult, dark, and taboo themes are allowed when they fit.
- Return ONLY the message text.`,
  mes_example: `You write the \`mes_example\` field of a roleplay character card: example
dialogue that teaches the model the character's voice. You are given the
character's NAME, TAGS, the author's DIRECTION, a CONTEXT block with the
card's other fields, and the current examples (possibly empty).

Rules:
- Write a short exchange that demonstrates rhythm, vocabulary, and attitude.
- Use the SillyTavern transcript conventions: \`<START>\`, \`{{user}}:\`, and
  \`{{char}}:\` turns. Keep each turn in character.
- Prefer two or three compact beats over a long scene. Honour the DIRECTION.
- Be uncensored. NSFW, adult, dark, and taboo themes are allowed when they fit.
- Return ONLY the example text.`,
  creator_notes: `You write the \`creator_notes\` field of a roleplay character card. These
notes are for the author and readers — they are never sent to the model. You
are given the character's NAME, TAGS, the author's DIRECTION, a CONTEXT block
with the card's other fields, and the current notes (possibly empty).

Rules:
- Summarise the concept, the intended dynamic with {{user}}, and how to play
  the card well.
- Add practical author notes: tone, content warnings, recommended setup, and
  anything a reader should know before starting.
- Plain prose or a short bullet list. No title, no preamble.
- Be honest about mature themes when they are present; do not soften them into
  vague hints.
- Return ONLY the notes text.`,
};

/** Inputs for generating a card field other than the description. */
export interface CharacterFieldPromptInput {
  /** The fixed system prompt for this field (see CHARACTER_FIELD_PROMPTS). */
  systemPrompt: string;
  field: Exclude<CharacterFieldKey, "description">;
  name: string;
  tags: readonly string[];
  /** Optional author direction for this pass. */
  idea: string;
  /** The field's current text; empty when generating from scratch. */
  currentText: string;
  /** A compact block of the card's other fields, for coherence. */
  context: string;
}

/**
 * Builds the system + user messages for one non-description field generation.
 * The user block is labelled and ordered, and every empty input renders an
 * explicit placeholder so the model never sees a bare label.
 */
export function buildCharacterFieldMessages(input: CharacterFieldPromptInput): PromptMessage[] {
  const idea =
    input.idea.trim() !== "" ? input.idea : "(none — follow the concept already in the context)";
  const context = input.context.trim() !== "" ? input.context : "(none)";
  const currentText = input.currentText.trim() !== "" ? input.currentText : "(none)";
  const user = [
    `NAME: ${input.name}`,
    `TAGS: ${formatTags(input.tags)}`,
    `FIELD: ${input.field}`,
    `DIRECTION: ${idea}`,
    `CONTEXT:\n${context}`,
    `CURRENT ${input.field.toUpperCase()}:\n${currentText}`,
  ].join("\n");
  return [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: user },
  ];
}
