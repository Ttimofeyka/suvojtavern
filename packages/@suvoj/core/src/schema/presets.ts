/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * Preset creation data (format v2): a name, a short description, and the
 * ORDERED `prompts` array — array order IS the pipeline layout, there is no
 * separate `order` array. `settings` holds engine settings (scan depth,
 * world info budget, memory wiring); sampling lives in connection profiles
 * only. Records are intentionally loose — the engine's promptSchema /
 * presetSettingsSchema parse them.
 */
export const presetInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  prompts: z.array(z.record(z.string(), z.unknown())).default([]),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export type PresetInput = z.input<typeof presetInputSchema>;

export const presetSchema = presetInputSchema.extend({
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Preset = z.infer<typeof presetSchema>;
