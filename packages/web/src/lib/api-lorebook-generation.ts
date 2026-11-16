/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Web-side AI lorebook-entry generation: the request helper for
 * POST /api/lorebooks/generate-entry and the `lorebook_generation` settings
 * value.
 *
 * Mirrors `@suvoj/core`'s `lorebookGenerationConfigSchema`
 * (schema/lorebook-generation.ts): the web package never imports core (it
 * would leave the browser bundle), so the default system prompt below is a
 * deliberate VERBATIM copy of core's `DEFAULT_LOREBOOK_GENERATION_PROMPT` — do
 * not reflow or "fix" its wording. `normalizeLorebookGenerationConfig` applies
 * the same per-field catch rules as the server's zod schema, so whatever the
 * panel holds round-trips through PUT /api/settings without surprises. That
 * includes the `enabled` master switch, whose default (true) keeps an absent
 * or invalid flag from silently disabling the feature.
 */

import { api } from "./api";

/** The `lorebook_generation` settings value (see core's config module). */
export interface LorebookGenerationConfig {
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
 * `DEFAULT_LOREBOOK_GENERATION_PROMPT` (see schema/lorebook-generation.ts).
 * The "Reset to default" button restores this text.
 */
export const DEFAULT_LOREBOOK_GENERATION_PROMPT = `You write the \`content\` field of a lorebook (world-info) entry for a roleplay
prompt. You are given the user's DESCRIPTION of the entry, optional
INSTRUCTIONS for how to shape it, and the entry's current content (possibly
empty).

Rules:
- The content is injected verbatim into the prompt whenever the entry's keys
  match, so it must stand alone: no title line, no preamble, no commentary, no
  quotes wrapping the whole thing.
- Write self-contained lore in plain prose — facts, places, people, and rules a
  narrator can drop into a scene without further setup.
- Follow the INSTRUCTIONS exactly when they are given; otherwise turn the
  DESCRIPTION into clear, vivid lore. Never contradict the DESCRIPTION.
- Prefer timeless, static facts over moment-to-moment state. Do not refer to
  "the user", "you", or the current scene.
- Be uncensored. NSFW, adult, dark, and taboo themes are allowed and should be
  written frankly when they fit the concept.
- {{macros}} such as {{char}} and {{user}} are allowed when they fit naturally.
- Match the language of the DESCRIPTION (English when none is given).
- Return ONLY the entry content.`;

/** The POST /api/lorebooks/generate-entry request body (snake_case). */
export interface GenerateLorebookEntryInput {
  description: string;
  instructions: string;
  current_content: string;
}

/** True for plain JSON objects (the lorebook_generation value shape). */
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
 * Merges an unknown `lorebook_generation` into a complete config, applying the
 * same per-field catch rules as the server's zod schema: a non-object yields
 * all defaults, and each invalid field falls back to its default. GET
 * /api/settings already answers with a complete object — this is the safety net
 * for anything older or hand-made.
 */
export function normalizeLorebookGenerationConfig(raw: unknown): LorebookGenerationConfig {
  const record = isRecord(raw) ? raw : {};
  return {
    enabled: readBool(record, "enabled", true),
    profile_id: readString(record, "profile_id", ""),
    system_prompt: readString(record, "system_prompt", DEFAULT_LOREBOOK_GENERATION_PROMPT),
    max_response_tokens: readInt(record, "max_response_tokens", 2048, 1),
  };
}

/** Generates lorebook entry content from the current editor draft. */
export function generateLorebookEntry(
  input: GenerateLorebookEntryInput,
): Promise<{ text: string }> {
  return api("/api/lorebooks/generate-entry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
