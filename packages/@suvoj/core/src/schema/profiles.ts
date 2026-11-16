/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * Effort levels of the OpenAI-compatible `reasoning_effort` parameter.
 * `off` is suvoj's own sentinel: the gateway sends no reasoning parameter at
 * all, so non-reasoning models and strict upstreams keep working. An absent
 * value means the service default (`low`) — see `gateway-stream.ts`.
 */
export const reasoningEffortSchema = z.enum(["off", "low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/**
 * Core sampling + model parameters, shared by presets and connection
 * profiles. Free-form extras pass through untouched.
 */
export const samplingSchema = z.looseObject({
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  repetition_penalty: z.number().min(0).optional(),
  max_tokens: z.number().int().min(1).optional(),
  context_size: z.number().int().min(1).optional(),
  stream: z.boolean().optional(),
  reasoning_effort: reasoningEffortSchema.optional(),
});
export type Sampling = z.infer<typeof samplingSchema>;

/**
 * True for an absolute `http:`/`https:` URL (the shape a custom endpoint must
 * have). The `try` matters: `new URL` throws on anything unparseable, so this
 * doubles as the guard for arbitrary user input.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A profile's custom API base. Empty means the profile has no endpoint
 * configured (resolution fails with a clean 400); any non-empty value must be
 * an absolute http(s) URL. Deliberately carries no default here: the create
 * schema applies `""`, while the PATCH schema must use bare `.optional()` so
 * an absent field stays absent (a `.default()` wrapped in `.optional()` still
 * resurrects the default — see the PATCH note). Normalization (trailing
 * slashes, the trailing path) is the gateway's job.
 */
export const baseUrlSchema = z.string().refine((value) => value === "" || isHttpUrl(value), {
  message: "base_url must be an empty string or a valid http(s) URL",
});

/**
 * Connection profile creation data: a model, the sampler settings that
 * replace the preset's at generation time (presets keep the prompt layout
 * only), and the optional endpoint. `base_url` must be a real http(s) URL for
 * the profile to be usable; `api_key` is persisted plaintext but the read
 * shape only ever exposes `has_api_key`. The active profile is tracked
 * separately in the settings store.
 */
export const profileInputSchema = z.object({
  name: z.string().min(1),
  model: z.string().default(""),
  base_url: baseUrlSchema.default(""),
  api_key: z.string().default(""),
  sampling: samplingSchema.prefault({}),
});

export type ProfileInput = z.input<typeof profileInputSchema>;

/**
 * PATCH write shape for a profile. Written explicitly rather than as
 * `.partial()` of the input schema: `.partial()` keeps the `.default()`s, so
 * an absent `model`/`sampling` would serialize as `""`/`{}` and wipe the
 * stored column on every patch. Semantics:
 *
 * - absent field  → keep the stored value;
 * - `api_key: null` → clear the stored key to `""`;
 * - `api_key: ""` → also clears the key (an empty string is indistinguishable
 *   from a cleared key in storage, so it is accepted as equivalent to `null`);
 * - `api_key: "…"` → replace the stored key;
 * - `base_url: ""` → clear the endpoint (the profile becomes unusable until
 *   a real URL is set).
 */
export const profilePatchSchema = z.object({
  name: z.string().min(1).optional(),
  model: z.string().optional(),
  base_url: baseUrlSchema.optional(),
  api_key: z.string().nullable().optional(),
  sampling: samplingSchema.optional(),
});

export type ProfilePatch = z.infer<typeof profilePatchSchema>;

/**
 * The read shape. Declared explicitly instead of extending the input schema so
 * `api_key` can never leak through `.extend()`/spread: it is replaced by the
 * derived `has_api_key` flag. Keep in sync with the repository's `toProfile`.
 */
export const profileSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string(),
  base_url: z.string(),
  sampling: samplingSchema,
  is_default: z.boolean().default(false),
  has_api_key: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Profile = z.infer<typeof profileSchema>;
