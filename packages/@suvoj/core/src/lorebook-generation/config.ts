/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Repositories } from "../repositories";
import {
  type LorebookGenerationConfig,
  lorebookGenerationConfigSchema,
} from "../schema/lorebook-generation";

/**
 * Lorebook-generation config accessor — the single resolution point for the
 * AI-assisted lorebook entry configuration (stored under the
 * `lorebook_generation` settings key): a missing key yields the full default
 * config, a partial object merges through the schema's per-field `.catch(...)`
 * fallbacks, and invalid values fall back per-field.
 */

/** Settings key holding the lorebook-generation configuration. */
export const LOREBOOK_GENERATION_CONFIG_KEY = "lorebook_generation";

/** Reads and validates the lorebook-generation configuration (defaults when unset). */
export function getLorebookGenerationConfig(repos: Repositories): LorebookGenerationConfig {
  const stored = repos.settings.get<unknown>(LOREBOOK_GENERATION_CONFIG_KEY);
  const parsed = lorebookGenerationConfigSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : lorebookGenerationConfigSchema.parse({});
}
