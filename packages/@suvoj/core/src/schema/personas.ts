/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/** Persona (the user's own character) creation data. */
export const personaInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  avatar_path: z.string().nullable().default(null),
});

export type PersonaInput = z.input<typeof personaInputSchema>;

export const personaSchema = personaInputSchema.extend({
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Persona = z.infer<typeof personaSchema>;
