/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Web-side AI character-description generation: the request helper for
 * POST /api/characters/generate-description and the `character_generation`
 * settings value.
 *
 * Mirrors `@suvoj/core`'s `characterGenerationConfigSchema`
 * (schema/character-generation.ts): the web package never imports core (it
 * would leave the browser bundle), so the default system prompt below is a
 * deliberate VERBATIM copy of core's `DEFAULT_CHARACTER_GENERATION_PROMPT` —
 * do not reflow or "fix" its wording. `normalizeCharacterGenerationConfig`
 * applies the same per-field catch rules as the server's zod schema, so
 * whatever the panel holds round-trips through PUT /api/settings without
 * surprises. That includes the `enabled` master switch, whose default (true)
 * keeps an absent or invalid flag from silently disabling the feature.
 */

import { api } from "./api";

/** The `character_generation` settings value (see core's config module). */
export interface CharacterGenerationConfig {
  /** Master on/off for the feature; when false the editor hides the action. */
  enabled: boolean;
  /** Connection profile for the generator; "" → default profile. */
  profile_id: string;
  /** System prompt steering the generator (user block built by the server). */
  system_prompt: string;
  /** Generation max_tokens override. */
  max_response_tokens: number;
}

/**
 * The default (user-editable) system prompt — a verbatim copy of core's
 * `DEFAULT_CHARACTER_GENERATION_PROMPT` (see schema/character-generation.ts).
 * The "Reset to default" button restores this text.
 */
export const DEFAULT_CHARACTER_GENERATION_PROMPT = `You write the \`description\` field of a roleplay character card. You are given the
character's NAME, TAGS, the user's IDEA, and the current description (possibly empty).

Rules:
- ALWAYS open the description with a world-framing line in this spirit:
  "{{char}} is not a character but a world." Use the literal macro {{char}}.
- {{char}}'s WORLD is the focus: setting, atmosphere, places, factions, mood,
  and the people who live in it.
- Describe the world's NPCs as supporting cast — who they are, their role, a line
  or two each — but do NOT make the NPCs the main accent. {{char}} and the world
  stay central.
- Be uncensored. NSFW, adult, dark, and taboo themes are allowed and should be
  written frankly when they fit the concept.
- Prefer timeless, static description over moment-to-moment state. Do NOT bake in
  dynamic facts (changing relationships, current events). If a dynamic fact is
  essential, state it as a starting condition, e.g.
  "(they are dating, by the start of the scenario)".
- Third person, present tense, plain prose. No title line, no preamble, no quotes,
  no commentary — return ONLY the description text.
- Match the language of the IDEA (English when no idea is given).`;

/** The POST /api/characters/generate-description request body (snake_case). */
export interface GenerateDescriptionInput {
  name: string;
  tags: string[];
  idea: string;
  current_description: string;
}

/** True for plain JSON objects (the character_generation value shape). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a string field, falling back to the default (zod `.catch`). */
function readString(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  return typeof record?.[key] === "string" ? record[key] : fallback;
}

/**
 * Reads an integer field with a minimum, falling back to the default on any
 * invalid value (mirrors z.number().int().min(n).catch(default) — a value
 * below the minimum is replaced, not clamped).
 */
function readInt(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
  min: number,
): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isInteger(value) && value >= min ? value : fallback;
}

/**
 * Reads a boolean field, falling back on any non-boolean (mirrors
 * z.boolean().catch(default)). A bad flag must not silently flip the feature
 * off — the default decides.
 */
function readBool(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: boolean,
): boolean {
  const value = record?.[key];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Merges an unknown `character_generation` into a complete config, applying the
 * same per-field catch rules as the server's zod schema: a non-object yields
 * all defaults, and each invalid field falls back to its default. GET
 * /api/settings already answers with a complete object — this is the safety net
 * for anything older or hand-made.
 */
export function normalizeCharacterGenerationConfig(raw: unknown): CharacterGenerationConfig {
  const record = isRecord(raw) ? raw : {};
  return {
    enabled: readBool(record, "enabled", true),
    profile_id: readString(record, "profile_id", ""),
    system_prompt: readString(record, "system_prompt", DEFAULT_CHARACTER_GENERATION_PROMPT),
    max_response_tokens: readInt(record, "max_response_tokens", 2048, 1),
  };
}

/** Generates a character description from the current editor draft. */
export function generateCharacterDescription(
  input: GenerateDescriptionInput,
): Promise<{ text: string }> {
  return api("/api/characters/generate-description", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** The prose fields the studio can generate or enhance. */
export type CharacterFieldKey =
  | "description"
  | "personality"
  | "scenario"
  | "first_mes"
  | "mes_example"
  | "creator_notes";

/** Human labels for the field names, shared by the studio and its AI dialog. */
export const CHARACTER_FIELD_LABELS: Record<CharacterFieldKey, string> = {
  description: "Description",
  personality: "Personality",
  scenario: "Scenario",
  first_mes: "First message",
  mes_example: "Example dialogue",
  creator_notes: "Creator notes",
};

/**
 * The card fields the batch AI seed pass can write. Unlike the single-field
 * keys above, this includes identity fields (name/tags) and the alternate
 * greeting list.
 */
export type SeedFieldKey =
  | "name"
  | "tags"
  | "description"
  | "personality"
  | "scenario"
  | "first_mes"
  | "alternate_greetings"
  | "mes_example"
  | "creator_notes";

/** Canonical order for summaries and requests. */
export const SEED_FIELD_ORDER: readonly SeedFieldKey[] = [
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

/** Human labels for the batch seed fields. */
export const SEED_FIELD_LABELS: Record<SeedFieldKey, string> = {
  name: "Name",
  tags: "Tags",
  description: "Description",
  personality: "Personality",
  scenario: "Scenario",
  first_mes: "First message",
  alternate_greetings: "Alternate greetings",
  mes_example: "Example dialogue",
  creator_notes: "Creator notes",
};

/** A generated value: prose is a string, tags and greetings are lists. */
export type SeedFieldValue = string | string[];

/** The POST /api/characters/generate-seed request body. */
export interface GenerateCharacterSeedInput {
  /** Freeform concept notes; never saved to the card. */
  notes: string;
  name: string;
  tags: string[];
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  alternate_greetings: string[];
  mes_example: string;
  creator_notes: string;
  /** Exactly the fields the author marked for this pass. */
  generate: SeedFieldKey[];
  /** Optional per-field directions, keyed by field. */
  directions: Partial<Record<SeedFieldKey, string>>;
  /** How many alternate greetings to write when that field is marked. */
  alternate_count: number;
}

/** The generated subset, keyed by seed field. */
export interface GenerateCharacterSeedResult {
  fields: Partial<Record<SeedFieldKey, SeedFieldValue>>;
}

/**
 * Runs one batch AI seed pass. The server reads every field in the body as
 * canon and returns only the fields listed in `generate`.
 */
export function generateCharacterSeed(
  input: GenerateCharacterSeedInput,
): Promise<GenerateCharacterSeedResult> {
  return api("/api/characters/generate-seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** The POST /api/characters/generate-field request body (snake_case). */
export interface GenerateCharacterFieldInput {
  field: CharacterFieldKey;
  name: string;
  tags: string[];
  /** Optional author direction for this pass. */
  idea: string;
  /** The field's current text; empty when generating from scratch. */
  current_text: string;
  /** A compact block of the card's other fields, for coherence. */
  context: string;
}

/**
 * Generates or enhances one prose card field. The server picks the field's
 * prompt (description keeps the user-configured prompt from Settings) and
 * answers with the assembled text.
 */
export function generateCharacterField(
  input: GenerateCharacterFieldInput,
): Promise<{ text: string }> {
  return api("/api/characters/generate-field", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
