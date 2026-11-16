/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * AI-assisted lorebook (world-info) entry generation.
 *
 * The default system prompt and the config schema live here (rather than in
 * the `lorebook-generation` module) so the flat schema layer stays the single
 * source of truth: the server default, any UI default, and the stored-config
 * fallback all resolve to {@link DEFAULT_LOREBOOK_GENERATION_PROMPT}, and a
 * partial or partially-invalid stored object always resolves to a complete
 * config through the per-field `.catch(...)` fallbacks.
 */

/**
 * The default (user-editable) system prompt for entry generation. The user
 * message is built separately by `buildLorebookEntryMessages` (see the
 * `lorebook-generation` module) and carries the DESCRIPTION/INSTRUCTIONS/
 * CURRENT CONTENT block, so the output-format rules live here and the varying
 * inputs live there. The exact wording is frozen: the web package carries a
 * verbatim copy for its editor preview.
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

/**
 * How a lorebook entry is generated (stored under the
 * `lorebook_generation` settings key). Every field catches to its default, so
 * parsing a missing, partial or partially-invalid object yields a complete
 * config (invalid values fall back per-field, not wholesale). The `enabled`
 * master switch is part of that contract too: an absent or invalid flag falls
 * back to its own default rather than turning the feature off.
 */
export const lorebookGenerationConfigSchema = z.object({
  /** Master on/off for the feature; when false the editor hides the action
   *  and the server rejects requests. */
  enabled: z.boolean().catch(true),
  /** Connection profile for the generator; '' → default profile. */
  profile_id: z.string().catch(""),
  /** System prompt steering the generator (user block built by the caller). */
  system_prompt: z.string().catch(DEFAULT_LOREBOOK_GENERATION_PROMPT),
  /** Generation max_tokens override. */
  max_response_tokens: z.number().int().min(1).catch(2048),
});

export type LorebookGenerationConfig = z.infer<typeof lorebookGenerationConfigSchema>;
