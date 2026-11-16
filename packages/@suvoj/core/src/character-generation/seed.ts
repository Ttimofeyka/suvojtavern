/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PromptMessage } from "../engine/prompt";
import { parseJsonObject } from "../tracker/parser";

/**
 * One AI pass over a whole partial character card. The author fills any
 * fields, marks the ones the AI should write, and can add a short direction
 * per marked field. The model receives every filled field as canon and returns
 * one JSON object containing only the marked keys.
 *
 * Alternate greetings are special: their output is an array and the UI asks
 * for a count first, so the prompt carries that count explicitly.
 */

/** Every field the seed pass can write. */
export type CharacterSeedFieldKey =
  | "name"
  | "tags"
  | "description"
  | "personality"
  | "scenario"
  | "first_mes"
  | "alternate_greetings"
  | "mes_example"
  | "creator_notes";

/** Canonical display/order of seed fields; the prompt and parser use it. */
export const CHARACTER_SEED_FIELD_KEYS: readonly CharacterSeedFieldKey[] = [
  "name",
  "tags",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "alternate_greetings",
  "mes_example",
  "creator_notes",
];

/** A parsed seed response: strings for prose, arrays for tags/greetings. */
export type CharacterSeedFieldValue = string | string[];

/** Only the keys the model actually returned, and only requested ones. */
export type CharacterSeedFields = Partial<Record<CharacterSeedFieldKey, CharacterSeedFieldValue>>;

/** Everything the user block needs; the system prompt is fixed below. */
export interface CharacterSeedPromptInput {
  /** Freeform concept/theme notes, never saved to the card. */
  notes: string;
  name: string;
  tags: readonly string[];
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  alternateGreetings: readonly string[];
  mesExample: string;
  creatorNotes: string;
  /** The fields the author marked for this pass. */
  generate: readonly CharacterSeedFieldKey[];
  /** Optional per-field directions, keyed by seed field. */
  directions: Readonly<Record<string, string>>;
  /** How many alternate greetings to write when that field is marked. */
  alternateCount: number;
}

/**
 * The fixed system prompt for a batch seed pass. It deliberately does not use
 * the user-editable description prompt from Settings: that prompt is scoped to
 * one field, while this pass has to coordinate several fields in one JSON
 * object.
 */
export const CHARACTER_SEED_PROMPT = `You complete a roleplay character card from a partial seed. The user gives you
CONCEPT NOTES, every card field they have already filled, an optional
per-field direction, and a GENERATE list.

Rules:
- Treat every provided field and the concept notes as canon. Never contradict a
  filled field.
- Write ONLY the fields in GENERATE. Do not return or rewrite any other field.
- A marked field's existing text may be a draft or a direction. Use it as
  guidance and return the finished field.
- DESCRIPTION frames the world and the character; PERSONALITY adds temperament,
  habits, desires, fears, speech manner, and contradictions; SCENARIO is the
  starting stage the roleplay opens on. Do not repeat one field in another.
- FIRST_MES is the default opening message in the character's voice. Write one
  opening beat, keep the scene open for the user's reply, and do not write the
  user's side.
- ALTERNATE_GREETINGS is an array of exactly ALTERNATE GREETINGS COUNT complete
  openings. Make each one a different mood, place, or first move, and keep every
  one open for the user's reply. Do not copy the default opening.
- MES_EXAMPLE uses the SillyTavern transcript conventions: <START>, {{user}}:
  and {{char}}: turns. Write two or three compact beats.
- CREATOR_NOTES are author-facing and are not part of the chat prompt. Include
  tone, content warnings, and how to play the card well.
- NAME is a short character name. TAGS is an array of short lowercase tags with
  no duplicates.
- Use the literal macros {{char}} and {{user}} where a name is needed.
- Be uncensored. NSFW, adult, dark, and taboo themes are allowed and should be
  written frankly when they fit the seed.
- Match the language of the concept notes and filled fields (English when none
  is given).
- Return ONLY one JSON object with exactly the requested keys. Strings for
  name, description, personality, scenario, first_mes, mes_example, and
  creator_notes; arrays of strings for tags and alternate_greetings. No markdown
  fence, no commentary.`;

/** Joins tags for display; an empty list renders an explicit `(none)`. */
function formatTags(tags: readonly string[]): string {
  return tags.length > 0 ? tags.join(", ") : "(none)";
}

/** Trims a field or renders the house placeholder. */
function present(value: string): string {
  const text = value.trim();
  return text !== "" ? text : "(none)";
}

/** Formats the existing alternates as numbered blocks. */
function formatGreetings(greetings: readonly string[]): string {
  const filled = greetings.map((greeting) => greeting.trim()).filter((greeting) => greeting !== "");
  if (filled.length === 0) {
    return "(none)";
  }
  return filled.map((greeting, index) => `#${index + 2}\n${greeting}`).join("\n\n");
}

/** Filters the generate list to known fields and canonical order. */
function normalizeGenerate(generate: readonly CharacterSeedFieldKey[]): CharacterSeedFieldKey[] {
  const wanted = new Set(generate);
  return CHARACTER_SEED_FIELD_KEYS.filter((field) => wanted.has(field));
}

/** One labelled direction per marked field, with an explicit placeholder. */
function formatDirections(
  directions: Readonly<Record<string, string>>,
  generate: readonly CharacterSeedFieldKey[],
): string {
  return generate
    .map((field) => {
      const direction = directions[field]?.trim() ?? "";
      return `${field.toUpperCase()}: ${
        direction !== "" ? direction : "(none — follow the concept and the other fields)"
      }`;
    })
    .join("\n");
}

/**
 * Builds the system + user messages for one batch seed pass. Every input is
 * labelled and fixed-order; empty fields render explicit placeholders so the
 * model never sees a bare label.
 */
export function buildCharacterSeedMessages(input: CharacterSeedPromptInput): PromptMessage[] {
  const generate = normalizeGenerate(input.generate);
  const user = [
    `CONCEPT NOTES:\n${present(input.notes)}`,
    `NAME: ${present(input.name)}`,
    `TAGS: ${formatTags(input.tags)}`,
    `DESCRIPTION:\n${present(input.description)}`,
    `PERSONALITY:\n${present(input.personality)}`,
    `SCENARIO:\n${present(input.scenario)}`,
    `FIRST MESSAGE:\n${present(input.firstMes)}`,
    `ALTERNATE GREETINGS:\n${formatGreetings(input.alternateGreetings)}`,
    `EXAMPLE DIALOGUE:\n${present(input.mesExample)}`,
    `CREATOR NOTES:\n${present(input.creatorNotes)}`,
    `ALTERNATE GREETINGS COUNT: ${input.alternateCount}`,
    `GENERATE: ${generate.join(", ")}`,
    `FIELD DIRECTIONS:\n${formatDirections(input.directions, generate)}`,
  ].join("\n\n");
  return [
    { role: "system", content: CHARACTER_SEED_PROMPT },
    { role: "user", content: user },
  ];
}

/** Trims a string field; blank strings are not a usable generation. */
function readText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  return text !== "" ? text : undefined;
}

/** Trims, drops blanks, and de-duplicates a string list. */
function readList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const text = item.trim();
    if (text === "" || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result.length > 0 ? result : undefined;
}

/**
 * Parses the model's JSON response and keeps only the requested fields with
 * valid values. Wrong types and unrequested keys are dropped; when nothing
 * usable remains, throws so the caller can answer with a clean 502.
 */
export function parseCharacterSeedResponse(
  raw: string,
  generate: readonly CharacterSeedFieldKey[],
): CharacterSeedFields {
  const parsed = parseJsonObject(raw);
  const fields: CharacterSeedFields = {};
  for (const field of normalizeGenerate(generate)) {
    const value = parsed[field];
    if (field === "tags" || field === "alternate_greetings") {
      const list = readList(value);
      if (list !== undefined) {
        fields[field] = list;
      }
      continue;
    }
    const text = readText(value);
    if (text !== undefined) {
      fields[field] = text;
    }
  }
  if (Object.keys(fields).length === 0) {
    throw new Error("The model did not return any of the marked fields");
  }
  return fields;
}
