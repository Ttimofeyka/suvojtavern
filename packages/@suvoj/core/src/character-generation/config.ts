/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Repositories } from "../repositories";
import {
  type CharacterGenerationConfig,
  characterGenerationConfigSchema,
} from "../schema/character-generation";

/**
 * Character-generation config accessor — the single resolution point for the
 * AI-assisted description configuration (stored under the
 * `character_generation` settings key): a missing key yields the full default
 * config, a partial object merges through the schema's per-field `.catch(...)`
 * fallbacks, and invalid values fall back per-field.
 */

/** Settings key holding the character-generation configuration. */
export const CHARACTER_GENERATION_CONFIG_KEY = "character_generation";

/** Reads and validates the character-generation configuration (defaults when unset). */
export function getCharacterGenerationConfig(repos: Repositories): CharacterGenerationConfig {
  const stored = repos.settings.get<unknown>(CHARACTER_GENERATION_CONFIG_KEY);
  const parsed = characterGenerationConfigSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : characterGenerationConfigSchema.parse({});
}
