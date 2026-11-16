/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PresetInput } from "../schema/presets";

/**
 * Native → Suvoj preset document export.
 *
 * Unlike the SillyTavern interchange modules (lorebook / cards / chats), a
 * preset is exported in our OWN native format and re-imported by the same
 * package (see ../import/preset). The document carries only the round-trippable
 * payload — no `id`/timestamps — so a downloaded file can be imported cleanly
 * and re-exported without accumulating identity fields. ST chat-completion
 * presets are still ACCEPTED on import (via convertStPreset), but we never
 * emit ST's shape: the native prompt pipeline is our source of truth.
 */

/** Marker identifying a native Suvoj preset export document. */
export const PRESET_FILE_FORMAT = "suvoj.preset";
export const PRESET_FILE_VERSION = 1;

/** The downloadable preset document: the stored document minus id/timestamps. */
export interface PresetFile {
  format: typeof PRESET_FILE_FORMAT; // "suvoj.preset"
  version: number; // PRESET_FILE_VERSION
  name: string;
  description: string;
  prompts: PresetInput["prompts"];
  settings: PresetInput["settings"];
}

/** Builds the native preset document for a download. */
export function exportPreset(
  preset: Pick<PresetInput, "name" | "description" | "prompts" | "settings">,
): PresetFile {
  // Denormalize the input's optional fields so the emitted document always
  // materializes the full surface a fresh import expects.
  return {
    format: PRESET_FILE_FORMAT,
    version: PRESET_FILE_VERSION,
    name: preset.name,
    description: preset.description ?? "",
    prompts: preset.prompts ?? [],
    settings: preset.settings ?? {},
  };
}
