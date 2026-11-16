/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { lorebookGeneration } from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import { resolveEndpoint } from "../gateway";
import { resolveLorebookGenerationProfile } from "../profiles";
import { badRequest, parseJsonBody, type RouteDeps } from "../routes-deps";

/**
 * AI-assisted lorebook (world-info) entry generation.
 *
 * One route: `POST /api/lorebooks/generate-entry` turns a description, optional
 * shaping instructions and the entry's current content into fresh entry content
 * (the model streams internally; the client gets the assembled `{ text }`).
 * Unlike character generation there is no per-entry name to anchor on, so
 * `description` is the one required field.
 *
 * The stored config's `enabled` master switch is honored first (a disabled
 * feature is a 400, matching the character route). The upstream then runs
 * through the config's connection profile, resolved by
 * {@link resolveLorebookGenerationProfile} — no profile at all is a 400,
 * mirroring the tracker (this authoring call has no legacy gateway-resolved
 * fallback either).
 */

/**
 * The request body. `description` is the one required field (there is nothing
 * to write without it); the rest default to empty so the client can omit them.
 * Keys are snake_case, matching every other request body in the API.
 */
const generateEntrySchema = z.object({
  description: z.string().min(1),
  instructions: z.string().default(""),
  current_content: z.string().default(""),
});

export function lorebookGenerationRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.post("/api/lorebooks/generate-entry", async (c) => {
    const parsed = parseJsonBody(generateEntrySchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const { description, instructions, current_content } = parsed.value;

    // The stored config resolves to a complete object (defaults when unset),
    // so the enabled switch, prompt and token ceiling are always defined.
    const config = lorebookGeneration.getLorebookGenerationConfig(deps.repos);
    if (!config.enabled) {
      // The feature was turned off in settings: reject before touching the
      // upstream (the client should have hidden the action).
      return c.json(badRequest("Lorebook entry generation is disabled"), 400);
    }
    const profile = resolveLorebookGenerationProfile(deps.repos, config.profile_id);
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
    // the config. Temperature is pinned to 0.9 — writing lore is creative
    // prose, so a profile tuned for measured chat must not flatten it into a
    // bland list of facts.
    const sampling: Record<string, unknown> = { ...profile.sampling, temperature: 0.9 };
    delete sampling.stream;
    sampling.max_tokens = config.max_response_tokens;

    const messages = lorebookGeneration.buildLorebookEntryMessages({
      systemPrompt: config.system_prompt,
      description,
      instructions,
      currentContent: current_content,
    });

    const result = await deps.gateway.chatCompletion(messages, sampling, {
      model: profile.model,
      endpoint,
    });
    return c.json({ text: result.content });
  });

  return app;
}
