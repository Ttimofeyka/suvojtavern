/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { z } from "zod";
import type { Repositories } from "../../repositories";
import type { Preset } from "../preset";
import { summariesConfigSchema } from "./summaries";
import { trimConfigSchema } from "./trim";

/**
 * Global memory overrides (Settings page): the `memory_strategy` setting
 * re-selects the strategy, and `memory_config` holds per-strategy config
 * overrides (`{ trim?: {...}, summaries?: {...} }`) that merge over the
 * preset's own config field-by-field (global wins).
 */

/** Settings key holding the user-selected memory strategy. */
const MEMORY_STRATEGY_KEY = "memory_strategy";

/** Settings key holding per-strategy memory config overrides. */
const MEMORY_CONFIG_KEY = "memory_config";

/** Config schemas of the built-in strategies, by strategy id. */
const BUILTIN_CONFIG_SCHEMAS: Record<string, z.ZodType> = {
  trim: trimConfigSchema,
  summaries: summariesConfigSchema,
};

/** Memory wiring after the global overrides (the `settings.memory` shape). */
export interface ResolvedMemory {
  strategy: string;
  config: Record<string, unknown>;
}

/** True for plain JSON objects (the per-strategy config value shape). */
function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves a preset's memory wiring against the global settings. The
 * `memory_strategy` setting ("trim" | "summaries") overrides the strategy
 * selection while keeping the preset's config; the `memory_config` entry
 * of the active strategy then merges over that config (global wins
 * per-field). Any config a built-in strategy receives must pass that
 * strategy's own schema: the preset's config is kept only when the
 * effective schema accepts it — a config carrying a value the effective
 * schema rejects (e.g. `chunk_size: -1`) would throw in the strategy's
 * `apply` — otherwise the schema defaults stand; an invalid global config
 * is ignored (the validated base stands). Custom/unknown strategy ids
 * keep their config untouched. Keys the schema does not know (e.g. ones
 * removed by a schema rework) strip harmlessly at the strategy's parse.
 * The preset itself is not modified.
 */
export function resolveMemorySettings(repos: Repositories, preset: Preset): ResolvedMemory {
  const memory = preset.settings.memory;

  let strategy = memory.strategy;
  const globalStrategy = repos.settings.get<string>(MEMORY_STRATEGY_KEY);
  if (globalStrategy === "trim" || globalStrategy === "summaries") {
    strategy = globalStrategy;
  }

  let config = memory.config;
  const schema = BUILTIN_CONFIG_SCHEMAS[strategy];
  if (schema) {
    // The preset's config was written for the preset's own strategy, so it
    // survives only when the effective strategy's schema accepts it.
    const base = schema.safeParse(config).success ? config : {};
    const memoryConfig = repos.settings.get<Record<string, unknown>>(MEMORY_CONFIG_KEY);
    const override = memoryConfig?.[strategy];
    if (isConfigRecord(override)) {
      const merged = { ...base, ...override };
      config = schema.safeParse(merged).success ? merged : base;
    } else {
      config = base;
    }
  }

  return { strategy, config };
}
