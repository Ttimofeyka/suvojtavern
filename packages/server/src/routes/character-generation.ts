/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { characterGeneration } from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import { resolveEndpoint } from "../gateway";
import { resolveCharacterGenerationProfile } from "../profiles";
import { badRequest, parseJsonBody, type RouteDeps } from "../routes-deps";

/**
 * AI-assisted character-card field generation.
 *
 * Three routes:
 *  - `POST /api/characters/generate-description` turns a name, tags, an
 *    optional idea and the current description into a fresh description.
 *  - `POST /api/characters/generate-field` does the same for any other prose
 *    field (personality, scenario, first message, example dialogue, creator
 *    notes) using the field-specific prompt from core, plus an optional
 *    context block of the card's other fields.
 *  - `POST /api/characters/generate-seed` completes a whole partial card in one
 *    pass: every filled field is canon, the author marks the fields to write,
 *    and the model returns one JSON object containing only those keys. The
 *    studio uses this for its AI marks and per-field directions.
 *
 * All three stream internally; the first two answer with `{ text }`, while the
 * seed pass parses the model's JSON and answers with `{ fields }`. The stored
 * config's `enabled` master switch is honored first (a disabled feature is a
 * 400, before any upstream call). The upstream then runs through the
 * character-generation config's connection profile, resolved by
 * {@link resolveCharacterGenerationProfile} — no profile at all is a 400,
 * mirroring the tracker (unlike summarization, these authoring calls have no
 * legacy gateway-resolved fallback).
 */

/**
 * The request body. `name` is the one required field (there is nothing to
 * describe without it); the rest default to empty so the client can omit
 * them. Keys are snake_case, matching every other request body in the API.
 */
const generateDescriptionSchema = z.object({
  name: z.string().min(1),
  tags: z.array(z.string()).default([]),
  idea: z.string().default(""),
  current_description: z.string().default(""),
});

/**
 * The generic field body. `field` picks the field-specific prompt (except
 * `description`, which reuses the user-configured description prompt); the
 * rest default to empty so the client can omit them. `context` is a compact
 * block of the card's other fields, supplied by the studio for coherence.
 */
const generateFieldSchema = z.object({
  field: z.enum([
    "description",
    "personality",
    "scenario",
    "first_mes",
    "mes_example",
    "creator_notes",
  ]),
  name: z.string().min(1),
  tags: z.array(z.string()).default([]),
  idea: z.string().default(""),
  current_text: z.string().default(""),
  context: z.string().default(""),
});

/** The seed pass can write any of these card fields. */
const seedFieldSchema = z.enum([
  "name",
  "tags",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "alternate_greetings",
  "mes_example",
  "creator_notes",
]);

/**
 * The batch seed body. The name is optional because the author can mark it for
 * generation; `generate` must contain at least one field, and `directions` maps
 * a marked field to a short author direction. `alternate_count` tells the model
 * how many swipes to write when alternate greetings are marked.
 */
const generateSeedSchema = z.object({
  notes: z.string().default(""),
  name: z.string().default(""),
  tags: z.array(z.string()).default([]),
  description: z.string().default(""),
  personality: z.string().default(""),
  scenario: z.string().default(""),
  first_mes: z.string().default(""),
  alternate_greetings: z.array(z.string()).default([]),
  mes_example: z.string().default(""),
  creator_notes: z.string().default(""),
  generate: z.array(seedFieldSchema).min(1),
  directions: z.record(z.string(), z.string()).default({}),
  alternate_count: z.number().int().min(1).max(6).default(2),
});

export function characterGenerationRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.post("/api/characters/generate-description", async (c) => {
    const parsed = parseJsonBody(
      generateDescriptionSchema,
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const { name, tags, idea, current_description } = parsed.value;

    // The stored config resolves to a complete object (defaults when unset),
    // so the prompt and token ceiling are always defined.
    const config = characterGeneration.getCharacterGenerationConfig(deps.repos);
    if (!config.enabled) {
      // The feature was turned off in settings: reject before touching the
      // upstream (the client should have hidden the action).
      return c.json(badRequest("Character description generation is disabled"), 400);
    }
    const profile = resolveCharacterGenerationProfile(deps.repos, config.profile_id);
    if (!profile) {
      // No profiles exist yet: the same 400-class failure as the tracker —
      // the client must configure a connection profile first.
      return c.json(badRequest("No connection profile configured"), 400);
    }
    // The profile's upstream (its own base URL + key) — the request below
    // runs against it.
    const endpoint = await resolveEndpoint(deps.repos, profile);

    // Same profile-sampling clone discipline as the tracker/summarizer
    // bridges: the profile's samplers, minus `stream` (the gateway always
    // streams and re-adds the flag itself), with `max_tokens` overridden by
    // the config. Temperature is pinned to 0.9 — writing a character
    // description is creative prose, so a profile tuned for measured chat
    // must not flatten it into a bland list of facts.
    const sampling: Record<string, unknown> = { ...profile.sampling, temperature: 0.9 };
    delete sampling.stream;
    sampling.max_tokens = config.max_response_tokens;

    const messages = characterGeneration.buildCharacterDescriptionMessages({
      systemPrompt: config.system_prompt,
      name,
      tags,
      idea,
      currentDescription: current_description,
    });

    const result = await deps.gateway.chatCompletion(messages, sampling, {
      model: profile.model,
      endpoint,
    });
    return c.json({ text: result.content });
  });

  app.post("/api/characters/generate-field", async (c) => {
    const parsed = parseJsonBody(generateFieldSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const { field, name, tags, idea, current_text, context } = parsed.value;

    // Same config and profile resolution as the description route: one
    // enabled switch and one connection profile govern every generation
    // action in the studio.
    const config = characterGeneration.getCharacterGenerationConfig(deps.repos);
    if (!config.enabled) {
      return c.json(badRequest("Character generation is disabled"), 400);
    }
    const profile = resolveCharacterGenerationProfile(deps.repos, config.profile_id);
    if (!profile) {
      return c.json(badRequest("No connection profile configured"), 400);
    }
    const endpoint = await resolveEndpoint(deps.repos, profile);

    const sampling: Record<string, unknown> = { ...profile.sampling, temperature: 0.9 };
    delete sampling.stream;
    sampling.max_tokens = config.max_response_tokens;

    // Description keeps the user-editable system prompt from Settings. Every
    // other field uses its fixed prompt from core, so the same config steers
    // the whole studio without pretending one prompt fits every field.
    const messages =
      field === "description"
        ? characterGeneration.buildCharacterDescriptionMessages({
            systemPrompt: config.system_prompt,
            name,
            tags,
            idea,
            currentDescription: current_text,
          })
        : characterGeneration.buildCharacterFieldMessages({
            systemPrompt: characterGeneration.CHARACTER_FIELD_PROMPTS[field],
            field,
            name,
            tags,
            idea,
            currentText: current_text,
            context,
          });

    const result = await deps.gateway.chatCompletion(messages, sampling, {
      model: profile.model,
      endpoint,
    });
    return c.json({ text: result.content });
  });

  app.post("/api/characters/generate-seed", async (c) => {
    const parsed = parseJsonBody(generateSeedSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const {
      notes,
      name,
      tags,
      description,
      personality,
      scenario,
      first_mes,
      alternate_greetings,
      mes_example,
      creator_notes,
      generate,
      directions,
      alternate_count,
    } = parsed.value;

    // The same one-switch/one-profile policy as the single-field routes.
    const config = characterGeneration.getCharacterGenerationConfig(deps.repos);
    if (!config.enabled) {
      return c.json(badRequest("Character generation is disabled"), 400);
    }
    const profile = resolveCharacterGenerationProfile(deps.repos, config.profile_id);
    if (!profile) {
      return c.json(badRequest("No connection profile configured"), 400);
    }
    const endpoint = await resolveEndpoint(deps.repos, profile);

    const sampling: Record<string, unknown> = { ...profile.sampling, temperature: 0.9 };
    delete sampling.stream;
    // A batch spans several prose fields; the user's single-field ceiling
    // (default 2048) can truncate a full card's JSON. Raise the floor without
    // ignoring a deliberately larger setting.
    sampling.max_tokens = Math.max(config.max_response_tokens, 4096);

    const messages = characterGeneration.buildCharacterSeedMessages({
      notes,
      name,
      tags,
      description,
      personality,
      scenario,
      firstMes: first_mes,
      alternateGreetings: alternate_greetings,
      mesExample: mes_example,
      creatorNotes: creator_notes,
      generate,
      directions,
      alternateCount: alternate_count,
    });

    const result = await deps.gateway.chatCompletion(messages, sampling, {
      model: profile.model,
      endpoint,
    });

    try {
      const fields = characterGeneration.parseCharacterSeedResponse(result.content, generate);
      // The prompt asks for exactly N alternates, but models overshoot. The
      // author chose N in the Voice step, so enforce it here rather than
      // letting the swipes silently grow.
      if (Array.isArray(fields.alternate_greetings)) {
        fields.alternate_greetings = fields.alternate_greetings.slice(0, alternate_count);
      }
      return c.json({ fields });
    } catch {
      // The upstream answered, but not with the requested JSON shape (or with
      // none of the marked fields). Keep the author's marks intact and let the
      // client offer a retry.
      return c.json({ error: "The model returned an invalid response. Try again." }, 502);
    }
  });

  return app;
}
