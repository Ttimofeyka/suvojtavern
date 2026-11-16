/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { getSettings } from "../lib/api";
import {
  type CharacterGenerationConfig,
  normalizeCharacterGenerationConfig,
} from "../lib/api-character-generation";
import {
  type LorebookGenerationConfig,
  normalizeLorebookGenerationConfig,
} from "../lib/api-lorebook-generation";
import { appStore } from "./store";

/**
 * Shared AI-generation settings for the character and lorebook editors.
 *
 * The editors only need the config to decide whether to show their "Generate"
 * action, while Settings → AI Generation owns the full edit form. Routing both
 * through one atom means enabling a feature in the panel lights up the editor
 * button without a reload, and the panel can seed its form from the same
 * server-truth values.
 */
export interface AiGenerationState {
  character: CharacterGenerationConfig;
  lorebook: LorebookGenerationConfig;
}

/**
 * Starts on all-defaults (nothing hidden yet) and is replaced wholesale once
 * GET /api/settings answers. Partial replacement would let a stale field
 * survive a server update, so each load sets the complete pair.
 */
export const aiGenerationAtom = atom<AiGenerationState>({
  character: normalizeCharacterGenerationConfig({}),
  lorebook: normalizeLorebookGenerationConfig({}),
});

/**
 * The in-flight (or settled) hydration. Non-null means a load was started;
 * a failure resets it to null so the next mount retries instead of pinning the
 * UI to the defaults forever.
 */
let loaded: Promise<void> | null = null;

/**
 * Hydrates both configs from GET /api/settings exactly once. Fire-and-forget:
 * the editors render with the defaults immediately and re-render when the
 * stored values arrive. A GET failure is swallowed (the defaults stay) but
 * unlocks a later retry.
 */
export function ensureLoaded(): Promise<void> {
  if (loaded === null) {
    loaded = getSettings()
      .then((settings) => {
        appStore.set(aiGenerationAtom, {
          character: normalizeCharacterGenerationConfig(settings.character_generation),
          lorebook: normalizeLorebookGenerationConfig(settings.lorebook_generation),
        });
      })
      .catch(() => {
        loaded = null;
      });
  }
  return loaded;
}

/** Replaces the character config in the atom with a fresh state object. */
export function setCharacterGenerationConfig(config: CharacterGenerationConfig): void {
  appStore.set(aiGenerationAtom, { ...appStore.get(aiGenerationAtom), character: config });
}

/** Replaces the lorebook config in the atom with a fresh state object. */
export function setLorebookGenerationConfig(config: LorebookGenerationConfig): void {
  appStore.set(aiGenerationAtom, { ...appStore.get(aiGenerationAtom), lorebook: config });
}

/** Character-generation config, hydrated from settings on first use. */
export function useCharacterGenerationConfig(): CharacterGenerationConfig {
  ensureLoaded();
  return useAtomValue(aiGenerationAtom).character;
}

/** Lorebook-generation config, hydrated from settings on first use. */
export function useLorebookGenerationConfig(): LorebookGenerationConfig {
  ensureLoaded();
  return useAtomValue(aiGenerationAtom).lorebook;
}
