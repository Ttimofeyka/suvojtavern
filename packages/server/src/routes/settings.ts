/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  characterGeneration,
  characterGenerationConfigSchema,
  lorebookGeneration,
  lorebookGenerationConfigSchema,
  tracker,
  trackerConfigSchema,
} from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import { resolveEndpoint } from "../gateway";
import { resolveActiveProfile } from "../profiles";
import { badRequest, parseJsonBody, type RouteDeps } from "../routes-deps";

/**
 * App-level setting keys surfaced by GET/PUT /api/settings.
 *
 * `regex_rules` is deliberately absent: a rule set is a validated, ordered
 * document, and letting an arbitrary client PUT write it would allow a
 * half-valid (or empty) array to wipe the user's rules. The dedicated
 * routes in ./regex.ts are its only writers.
 */
export const SETTINGS_KEYS = [
  "theme",
  "layout",
  // Client-owned appearance preferences — an object
  // ({ accent, motion, surfaces }); the server stores it verbatim without
  // interpretation.
  "appearance",
  "message_formatting",
  "timestamps",
  // Client-owned chat history display preferences — an object
  // ({ maxMessages: number }); the server stores it verbatim without
  // interpretation.
  "chat_history",
  // Client-owned display preferences for the top-of-chat tracker generation
  // indicator — an object ({ show: boolean, label: string, dot: boolean });
  // the server stores it verbatim without interpretation.
  "tracker_indicator",
  // Client-owned display preferences for the top-of-chat summarization
  // indicator — an object ({ show: boolean, label: string, dot: boolean });
  // the server stores it verbatim without interpretation.
  "summarization_indicator",
  // Client-owned display preferences for the top-of-chat streaming indicator
  // — an object ({ show: boolean, label: string, dot: boolean }); the server
  // stores it verbatim without interpretation.
  "streaming_indicator",
  // Client-owned chat display preference for how a streaming reply reveals
  // itself — a style id string ("instant" | "smooth" | "typewriter" | "flow");
  // the server stores it verbatim without interpretation.
  "writing_style",
  "memory_strategy",
  "memory_config",
  "default_preset_id",
  "last_selected_chat_id",
  // Client-owned reasoning display preferences — an arbitrary JSON object
  // ({ show, expandLive, autoCollapse, expandStored }); the server stores
  // it verbatim without interpretation.
  "reasoning",
  // The tracker configuration (the Suvoj Tracker surface) — validated through
  // core's trackerConfigSchema on write, so the stored value (and thus
  // every GET) is always a complete, defaults-filled object.
  "tracker_config",
  // The AI-assisted character-description configuration — validated through
  // core's characterGenerationConfigSchema on write (exactly like
  // tracker_config), so the stored value is always complete and the
  // settings form resolves it through core's accessor rather than raw JSON.
  "character_generation",
  // The AI-assisted lorebook-entry configuration — validated through core's
  // lorebookGenerationConfigSchema on write (exactly like character_generation),
  // so the stored value is always complete and the settings form resolves it
  // through core's accessor rather than raw JSON.
  "lorebook_generation",
] as const;

export type SettingKey = (typeof SETTINGS_KEYS)[number];

/** Settings values are arbitrary JSON (`theme` is an object, `memory_config` an object). */
const settingValue = z
  .union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.unknown()),
    z.record(z.string(), z.unknown()),
  ])
  .nullable();

const putSettingsSchema = z.object({
  theme: settingValue.optional(),
  layout: settingValue.optional(),
  appearance: settingValue.optional(),
  message_formatting: settingValue.optional(),
  timestamps: settingValue.optional(),
  chat_history: settingValue.optional(),
  tracker_indicator: settingValue.optional(),
  summarization_indicator: settingValue.optional(),
  streaming_indicator: settingValue.optional(),
  writing_style: settingValue.optional(),
  memory_strategy: settingValue.optional(),
  memory_config: settingValue.optional(),
  default_preset_id: settingValue.optional(),
  last_selected_chat_id: settingValue.optional(),
  reasoning: settingValue.optional(),
  tracker_config: settingValue.optional(),
  character_generation: settingValue.optional(),
  lorebook_generation: settingValue.optional(),
});

/** The `{ key: value | null }` snapshot shared by the GET and PUT responses.
 *  `tracker_config`, `character_generation` and `lorebook_generation` always
 *  resolve through core's accessors, so the web settings form sees a complete
 *  config even before anything is stored. */
function settingsSnapshot(deps: RouteDeps): Record<SettingKey, unknown> {
  const out: Partial<Record<SettingKey, unknown>> = {};
  for (const key of SETTINGS_KEYS) {
    if (key === "tracker_config") {
      out[key] = tracker.getTrackerConfig(deps.repos);
    } else if (key === "character_generation") {
      out[key] = characterGeneration.getCharacterGenerationConfig(deps.repos);
    } else if (key === "lorebook_generation") {
      out[key] = lorebookGeneration.getLorebookGenerationConfig(deps.repos);
    } else {
      out[key] = deps.repos.settings.get(key);
    }
  }
  // Every key of SETTINGS_KEYS was assigned just above; the Partial is complete.
  return out as Record<SettingKey, unknown>;
}

export function settingsRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/api/settings", (c) => c.json(settingsSnapshot(deps)));

  app.put("/api/settings", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(badRequest("Invalid JSON body"), 400);
    }
    const parsed = parseJsonBody(putSettingsSchema, raw);
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    // The tracker config is a structured key: validate it through core's
    // schema UP FRONT (so nothing is half-stored) and store the parsed object
    // — its zod defaults make the stored value complete.
    let trackerConfig: ReturnType<typeof tracker.getTrackerConfig> | undefined;
    const trackerValue = parsed.value.tracker_config;
    if (trackerValue !== undefined && trackerValue !== null) {
      const parsedConfig = trackerConfigSchema.safeParse(trackerValue);
      if (!parsedConfig.success) {
        return c.json(
          badRequest(
            "Invalid tracker_config",
            parsedConfig.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          ),
          400,
        );
      }
      trackerConfig = parsedConfig.data;
    }
    // The character-generation config is another structured key, validated
    // and stored the same way (defaults-filled object, nothing half-stored).
    let characterGenerationConfig:
      | ReturnType<typeof characterGeneration.getCharacterGenerationConfig>
      | undefined;
    const characterGenerationValue = parsed.value.character_generation;
    if (characterGenerationValue !== undefined && characterGenerationValue !== null) {
      const parsedConfig = characterGenerationConfigSchema.safeParse(characterGenerationValue);
      if (!parsedConfig.success) {
        return c.json(
          badRequest(
            "Invalid character_generation",
            parsedConfig.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          ),
          400,
        );
      }
      characterGenerationConfig = parsedConfig.data;
    }
    // The lorebook-generation config is the last structured key, validated and
    // stored the same way (defaults-filled object, nothing half-stored).
    let lorebookGenerationConfig:
      | ReturnType<typeof lorebookGeneration.getLorebookGenerationConfig>
      | undefined;
    const lorebookGenerationValue = parsed.value.lorebook_generation;
    if (lorebookGenerationValue !== undefined && lorebookGenerationValue !== null) {
      const parsedConfig = lorebookGenerationConfigSchema.safeParse(lorebookGenerationValue);
      if (!parsedConfig.success) {
        return c.json(
          badRequest(
            "Invalid lorebook_generation",
            parsedConfig.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          ),
          400,
        );
      }
      lorebookGenerationConfig = parsedConfig.data;
    }
    for (const key of SETTINGS_KEYS) {
      let value = parsed.value[key];
      if (key === "tracker_config" && trackerConfig !== undefined) {
        value = trackerConfig;
      }
      if (key === "character_generation" && characterGenerationConfig !== undefined) {
        value = characterGenerationConfig;
      }
      if (key === "lorebook_generation" && lorebookGenerationConfig !== undefined) {
        value = lorebookGenerationConfig;
      }
      if (value === undefined) {
        continue;
      }
      if (value === null) {
        deps.repos.settings.delete(key);
      } else {
        deps.repos.settings.set(key, value);
      }
    }
    return c.json(settingsSnapshot(deps));
  });

  app.get("/api/models", async (c) => {
    // Models come from the ACTIVE connection profile's own endpoint + key.
    // With no profile (or one without a base_url) the gateway surfaces a clean
    // 400 rather than silently falling back anywhere.
    const profile = resolveActiveProfile(deps.repos);
    const endpoint = profile ? await resolveEndpoint(deps.repos, profile) : undefined;
    const models = await deps.gateway.getModels(endpoint);
    return c.json({ models });
  });

  return app;
}
