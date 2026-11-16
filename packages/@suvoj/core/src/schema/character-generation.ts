/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * AI-assisted character description generation.
 *
 * The default system prompt and the config schema live here (rather than in
 * the `character-generation` module) so the flat schema layer stays the single
 * source of truth: the server default, any UI default, and the stored-config
 * fallback all resolve to {@link DEFAULT_CHARACTER_GENERATION_PROMPT}, and a
 * partial or partially-invalid stored object always resolves to a complete
 * config through the per-field `.catch(...)` fallbacks.
 */

/**
 * The default (user-editable) system prompt for description generation. The
 * user message is built separately by `buildCharacterDescriptionMessages`
 * (see the `character-generation` module) and carries the NAME/TAGS/IDEA/
 * current-description block, so the output-format rules live here and the
 * varying inputs live there.
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

/**
 * How a character description is generated (stored under the
 * `character_generation` settings key). Every field catches to its default, so
 * parsing a missing, partial or partially-invalid object yields a complete
 * config (invalid values fall back per-field, not wholesale). The `enabled`
 * master switch is part of that contract too: an absent or invalid flag falls
 * back to its own default rather than turning the feature off.
 */
export const characterGenerationConfigSchema = z.object({
  /** Master on/off for the feature; when false the editor hides the action
   *  and the server rejects requests. */
  enabled: z.boolean().catch(true),
  /** Connection profile for the generator; '' → default profile. */
  profile_id: z.string().catch(""),
  /** System prompt steering the generator (user block built by the caller). */
  system_prompt: z.string().catch(DEFAULT_CHARACTER_GENERATION_PROMPT),
  /** Generation max_tokens override. */
  max_response_tokens: z.number().int().min(1).catch(2048),
});

export type CharacterGenerationConfig = z.infer<typeof characterGenerationConfigSchema>;
