/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ModelInfo } from "./api";
import { api } from "./api";

/**
 * A stored connection profile row (GET /api/profiles, POST /api/profiles, …):
 * the endpoint, model and sampler settings that replace the preset's at
 * generation time. Exactly one profile is `is_default` — created by seeding,
 * undeletable. An empty `base_url` means the profile has no endpoint, so a
 * call for it fails with a clean 400; the plaintext `api_key` is write-only,
 * so the read shape exposes only the derived `has_api_key` flag.
 */
export interface Profile {
  id: string;
  name: string;
  model: string;
  base_url: string;
  /** Known sampler keys (temperature, top_p, reasoning_effort, …) plus free-form extras. */
  sampling: Record<string, number | boolean | string | undefined>;
  is_default: boolean;
  has_api_key: boolean;
  created_at: string;
  updated_at: string;
}

/** POST /api/profiles body — optional fields fall back to server defaults. */
export interface ProfileInput {
  name: string;
  model?: string;
  base_url?: string;
  api_key?: string;
  sampling?: Record<string, number | boolean | string | undefined>;
}

/**
 * PATCH /api/profiles/:id body. Absent fields are left untouched; `api_key`
 * is the exception — `null` clears the stored key, a string replaces it, and
 * an absent field keeps it. A patched `sampling` replaces the whole object.
 */
export interface ProfilePatch {
  name?: string;
  model?: string;
  base_url?: string;
  sampling?: Record<string, number | boolean | string | undefined>;
  api_key?: string | null;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** Every profile plus the id of the one chat generation runs with. */
export function listProfiles(): Promise<{ profiles: Profile[]; active_profile_id: string | null }> {
  return api("/api/profiles");
}

export function createProfile(input: ProfileInput): Promise<Profile> {
  return api("/api/profiles", jsonInit("POST", input));
}

/** PATCH a profile; see `ProfilePatch` for field semantics. */
export function updateProfile(id: string, patch: ProfilePatch): Promise<Profile> {
  return api(`/api/profiles/${encodeURIComponent(id)}`, jsonInit("PATCH", patch));
}

/** Models offered by this profile's own endpoint + key (GET /api/profiles/:id/models). */
export function getProfileModels(id: string): Promise<{ models: ModelInfo[] }> {
  return api(`/api/profiles/${encodeURIComponent(id)}/models`);
}

export function deleteProfile(id: string): Promise<{ ok: boolean }> {
  return api(`/api/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Marks `id` as the profile chat generation runs with. */
export function setActiveProfile(id: string): Promise<{ ok: boolean; active_profile_id: string }> {
  return api("/api/profiles/active", jsonInit("PUT", { id }));
}
