/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Profile, ProfileInput, ProfilePatch } from "./api-profiles";

/** Sampler keys the editor exposes (a subset of the profile's free-form map). */
export const SAMPLER_KEYS = [
  "temperature",
  "top_p",
  "repetition_penalty",
  "max_tokens",
  "context_size",
] as const;

export type SamplerKey = (typeof SAMPLER_KEYS)[number];

/** Reasoning-effort values the editor offers; mirrors the server schema. */
export const REASONING_EFFORTS = ["off", "low", "medium", "high"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Effort the service uses when a profile has no explicit choice. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "low";

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);

/** A profile's sampling map as it crosses the API: known keys plus free-form extras. */
export type SamplingValues = Record<string, number | boolean | string | undefined>;

/**
 * Editor form state: every sampler as raw text ("" = unset) plus the endpoint
 * fields. The secret `api_key` is never returned by the server (reads expose
 * only `has_api_key`), so `draftFrom` always starts it blank — `clearApiKey`
 * is the explicit "PATCH `api_key: null`" signal and stays false until the
 * user ticks it.
 */
export interface Draft {
  name: string;
  model: string;
  base_url: string;
  api_key: string;
  clearApiKey: boolean;
  samplers: Record<SamplerKey, string>;
  /** Thinking level; the service default ("low") applies when none is stored. */
  reasoningEffort: ReasoningEffort;
}

/** Blank draft, or one mirroring `profile`. */
export function draftFrom(profile: Profile | null): Draft {
  const samplers = {} as Record<SamplerKey, string>;
  for (const key of SAMPLER_KEYS) {
    const value = profile?.sampling[key];
    samplers[key] = typeof value === "number" ? String(value) : "";
  }
  const storedEffort = profile?.sampling.reasoning_effort;
  return {
    name: profile?.name ?? "New profile",
    model: profile?.model ?? "",
    // `base_url` is a readable column, so it carries over; `api_key` does not.
    base_url: profile?.base_url ?? "",
    api_key: "",
    clearApiKey: false,
    samplers,
    reasoningEffort: isReasoningEffort(storedEffort) ? storedEffort : DEFAULT_REASONING_EFFORT,
  };
}

/**
 * Client-side mirror of the server's `base_url` rule: the value may be empty
 * (meaning "no endpoint" — the profile then fails generation with a 400), and
 * anything else must be an absolute http(s) URL. Empty is allowed on purpose
 * so the save is never blocked here.
 * Returns an error message to show, or null when the value is acceptable.
 */
export function endpointError(baseUrl: string): string | null {
  const value = baseUrl.trim();
  if (value === "") {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return null;
    }
  } catch {
    // Unparseable — fall through to the shared message.
  }
  return "Endpoint URL must be empty or a valid http(s) URL.";
}

/**
 * Short display form of a custom endpoint: its host. Saved rows only ever hold
 * validated http(s) URLs, but stay defensive (fall back to the raw value) so a
 * legacy row can never throw while rendering the list.
 */
export function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * POST /api/profiles body built from the editor draft. `sampling` is already
 * validated+merged by the caller. `api_key` is always sent (possibly ""): on
 * create "" means "no key" — a PATCH with "" would instead replace the stored
 * secret, which is why updates go through `updatePatch`.
 */
export function createInput(draft: Draft, sampling: SamplingValues): ProfileInput {
  return {
    name: draft.name.trim(),
    model: draft.model.trim(),
    base_url: draft.base_url.trim(),
    api_key: draft.api_key.trim(),
    sampling: { ...sampling, reasoning_effort: draft.reasoningEffort },
  };
}

/**
 * PATCH /api/profiles/:id body built from the editor draft. `name`, `model`,
 * `base_url` and `sampling` are always sent. `api_key` is sent ONLY when the
 * user typed a replacement (a trimmed non-empty string) or ticked "clear
 * stored key" (`null`); otherwise the field is absent so the server keeps the
 * stored secret. A typed value supersedes a pending clear — never send the
 * literal "" as a replacement key.
 */
export function updatePatch(draft: Draft, sampling: SamplingValues): ProfilePatch {
  const patch: ProfilePatch = {
    name: draft.name.trim(),
    model: draft.model.trim(),
    base_url: draft.base_url.trim(),
    sampling: { ...sampling, reasoning_effort: draft.reasoningEffort },
  };
  const typed = draft.api_key.trim();
  if (typed !== "") {
    patch.api_key = typed;
  } else if (draft.clearApiKey) {
    patch.api_key = null;
  }
  return patch;
}
