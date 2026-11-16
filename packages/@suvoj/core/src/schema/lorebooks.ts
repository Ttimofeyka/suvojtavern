/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";

export const lorebookInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
});

export type LorebookInput = z.input<typeof lorebookInputSchema>;

export const lorebookSchema = lorebookInputSchema.extend({
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Lorebook = z.infer<typeof lorebookSchema>;

/**
 * A native-only organizational block of entries ("section"). Purely a UI
 * grouping: sections never affect generation. `display_index` orders the
 * blocks among the book's other sections; the implicit ungrouped bucket
 * always renders last (a client-side rule).
 */
export const lorebookSectionInputSchema = z.object({
  name: z.string().min(1),
  display_index: z.number().int().default(0),
});

export type LorebookSectionInput = z.input<typeof lorebookSectionInputSchema>;

export const lorebookSectionSchema = lorebookSectionInputSchema.extend({
  id: z.string(),
  lorebook_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type LorebookSection = z.infer<typeof lorebookSectionSchema>;

/** ST recursion flags, grouped for the `recursion` JSON column. */
export const lorebookRecursionSchema = z.object({
  excludeRecursion: z.boolean(),
  preventRecursion: z.boolean(),
  delayUntilRecursion: z.boolean(),
});

export type LorebookRecursion = z.infer<typeof lorebookRecursionSchema>;

/** ST `characterFilter` — include/exclude characters by name or tags. */
export const lorebookCharacterFilterSchema = z.object({
  isExclude: z.boolean(),
  names: z.array(z.string()),
  tags: z.array(z.string()),
});

export type LorebookCharacterFilter = z.infer<typeof lorebookCharacterFilterSchema>;

/**
 * Lorebook entry creation data (parent lorebook id passed to the repo).
 * Columns cover the canonical SillyTavern entry surface; `extra` preserves
 * any remaining ST fields (outletName, automationId, triggers, ...) so
 * imports round-trip losslessly.
 */
export const lorebookEntryInputSchema = z.object({
  keys: z.array(z.string()).default([]),
  secondary: z.array(z.string()).default([]),
  content: z.string().default(""),
  comment: z.string().nullable().default(null),
  constant: z.boolean().default(false),
  selective: z.boolean().default(false),
  logic: z.number().int().default(0),
  order: z.number().int().default(100),
  position: z.number().int().default(0),
  depth: z.number().int().default(4),
  role: z.string().nullable().default(null),
  probability: z.number().int().default(100),
  enabled: z.boolean().default(true),
  sticky: z.number().int().default(0),
  cooldown: z.number().int().default(0),
  delay: z.number().int().default(0),
  vectorized: z.boolean().default(false),
  case_sensitive: z.boolean().default(false),
  match_whole_words: z.boolean().default(true),
  scan_depth: z.number().int().nullable().default(null),
  group: z.string().nullable().default(null),
  group_weight: z.number().int().nullable().default(null),
  recursion: lorebookRecursionSchema.nullable().default(null),
  /** e.g. { matchPersonaDescription, matchCharacterDescription, ... }. */
  match_fields: z.record(z.string(), z.boolean()).nullable().default(null),
  character_filter: lorebookCharacterFilterSchema.nullable().default(null),
  /**
   * Native organizational section (see lorebookSectionSchema). NULL is the
   * ungrouped bucket. Native-only: deliberately absent from `extra` and from
   * the SillyTavern import/export, which has no section concept.
   */
  section_id: z.string().nullable().default(null),
  display_index: z.number().int().default(0),
  extra: z.record(z.string(), z.unknown()).nullable().default(null),
});

export type LorebookEntryInput = z.input<typeof lorebookEntryInputSchema>;

export const lorebookEntrySchema = lorebookEntryInputSchema.extend({
  id: z.string(),
  lorebook_id: z.string(),
});

export type LorebookEntry = z.infer<typeof lorebookEntrySchema>;
