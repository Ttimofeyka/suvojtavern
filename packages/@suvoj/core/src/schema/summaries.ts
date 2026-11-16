/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * Summary creation data (parent chat id passed to the repo). Hierarchical
 * memory: level 0 summarizes a raw message range, level 1 summarizes level 0
 * summaries, and so on.
 */
export const summaryInputSchema = z.object({
  level: z.number().int().min(0),
  seq_from: z.number().int().min(1),
  seq_to: z.number().int().min(1),
  summary: z.string(),
  tokens: z.number().int().nullable().default(null),
});

export type SummaryInput = z.input<typeof summaryInputSchema>;

export const summarySchema = summaryInputSchema.extend({
  id: z.string(),
  chat_id: z.string(),
  created_at: z.string(),
});

export type Summary = z.infer<typeof summarySchema>;
