/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * Character creation data (columns minus id/timestamps). `card_raw` keeps the
 * imported card JSON verbatim so no information is lost on import.
 */
export const characterInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  personality: z.string().default(""),
  scenario: z.string().default(""),
  first_mes: z.string().default(""),
  mes_example: z.string().default(""),
  creator_notes: z.string().default(""),
  system_prompt: z.string().default(""),
  post_history_instructions: z.string().default(""),
  alternate_greetings: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  avatar_path: z.string().nullable().default(null),
  card_raw: z.unknown().nullable().default(null),
});

export type CharacterInput = z.input<typeof characterInputSchema>;

export const characterSchema = characterInputSchema.extend({
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Character = z.infer<typeof characterSchema>;

/**
 * Slim projection used by character *listing* only.
 *
 * A full card can carry hundreds of KB of prose and a `card_raw` blob, so
 * shipping thousands of them just to render a grid is the dominant cost of
 * the list endpoint. The list therefore selects only the fields the grid
 * needs (identity, avatar, tags, timestamps); `chat_count` is added by the
 * route from a single grouped query. `GET /api/characters/:id` still returns
 * the full {@link Character}.
 */
export const characterListRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar_path: z.string().nullable(),
  tags: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
});

export type CharacterListRow = z.infer<typeof characterListRowSchema>;

/** Gallery image attached to a character (parent id passed to the repo). */
export const characterImageInputSchema = z.object({
  blob_path: z.string().nullable().default(null),
  sort: z.number().int().default(0),
});

export type CharacterImageInput = z.input<typeof characterImageInputSchema>;

export const characterImageSchema = characterImageInputSchema.extend({
  id: z.string(),
  character_id: z.string(),
  created_at: z.string(),
});

export type CharacterImage = z.infer<typeof characterImageSchema>;
