/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Profile } from "@suvoj/core";
import type { Repos } from "./routes-deps";

/** Settings key holding the id of the active connection profile. */
export const ACTIVE_PROFILE_KEY = "active_connection_profile_id";

/**
 * The connection profile chat generation runs with: the stored
 * `active_connection_profile_id` when it still matches a live profile,
 * else the default profile, else the first listed, else `null` (no
 * profiles exist yet — callers keep the preset's sampling).
 */
export function resolveActiveProfile(repos: Repos): Profile | null {
  const stored = repos.settings.get(ACTIVE_PROFILE_KEY);
  const id = typeof stored === "string" ? stored : null;
  if (id !== null) {
    const profile = repos.profiles.get(id);
    if (profile) {
      return profile;
    }
  }
  const profiles = repos.profiles.list();
  return profiles.find((profile) => profile.is_default) ?? profiles[0] ?? null;
}

/**
 * The connection profile the summarizer model runs through: the summaries
 * config's `profile_id` when it still matches a live profile, else the
 * default profile, else the first listed, else `null` (no profiles exist
 * yet — callers keep the legacy gateway-resolved model). The active chat
 * profile is deliberately ignored: summarization is a background
 * maintenance call, not part of the conversation.
 */
export function resolveSummarizerProfile(repos: Repos, profileId?: string): Profile | null {
  if (profileId !== undefined) {
    const profile = repos.profiles.get(profileId);
    if (profile) {
      return profile;
    }
  }
  const profiles = repos.profiles.list();
  return profiles.find((profile) => profile.is_default) ?? profiles[0] ?? null;
}

/**
 * The connection profile the tracker generator runs through: the tracker
 * config's `profile_id` when it still matches a live profile, else the
 * default profile, else the first listed, else `null` (no profiles exist
 * yet — callers treat that as a 400-class error: unlike summarization,
 * the tracker has no legacy gateway-resolved fallback).
 */
export function resolveTrackerProfile(repos: Repos, profileId?: string): Profile | null {
  if (profileId !== undefined && profileId !== "") {
    const profile = repos.profiles.get(profileId);
    if (profile) {
      return profile;
    }
  }
  const profiles = repos.profiles.list();
  return profiles.find((profile) => profile.is_default) ?? profiles[0] ?? null;
}

/**
 * The connection profile the character-description generator runs through:
 * the character-generation config's `profile_id` when it still matches a
 * live profile, else the default profile, else the first listed, else `null`
 * (no profiles exist yet — the route turns that into a 400: like the
 * tracker, this generator has no legacy gateway-resolved fallback). The
 * active chat profile is deliberately ignored: generating a card field is an
 * authoring-side call, not part of the conversation.
 */
export function resolveCharacterGenerationProfile(
  repos: Repos,
  profileId?: string,
): Profile | null {
  if (profileId !== undefined && profileId !== "") {
    const profile = repos.profiles.get(profileId);
    if (profile) {
      return profile;
    }
  }
  const profiles = repos.profiles.list();
  return profiles.find((profile) => profile.is_default) ?? profiles[0] ?? null;
}

/**
 * The connection profile the lorebook-entry generator runs through: the
 * lorebook-generation config's `profile_id` when it still matches a live
 * profile, else the default profile, else the first listed, else `null` (no
 * profiles exist yet — the route turns that into a 400: like the tracker,
 * this generator has no legacy gateway-resolved fallback). The active chat
 * profile is deliberately ignored: writing an entry is an authoring-side
 * call, not part of the conversation.
 */
export function resolveLorebookGenerationProfile(repos: Repos, profileId?: string): Profile | null {
  if (profileId !== undefined && profileId !== "") {
    const profile = repos.profiles.get(profileId);
    if (profile) {
      return profile;
    }
  }
  const profiles = repos.profiles.list();
  return profiles.find((profile) => profile.is_default) ?? profiles[0] ?? null;
}
