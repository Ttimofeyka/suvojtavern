/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * Regex rule schema — user-defined find/replace rules applied server-side
 * during prompt assembly and to generated replies (the "Regex Rules"
 * settings surface).
 *
 * A rule stores its raw `find` source (a `/pattern/flags` literal or a bare
 * pattern — see engine/regex's `parseRegexSource`) plus the `placement`
 * classes it touches. Rules are global (not per-character/per-preset) and are
 * persisted as one JSON array under the `regex_rules` settings key.
 */

/** Which message classes a rule can target. */
export const regexPlacementSchema = z.enum(["ai", "user", "prompt"]);
export type RegexPlacement = z.infer<typeof regexPlacementSchema>;

export const regexRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Raw source: `/pattern/flags`, or a bare pattern (flags default to "g"). */
  find: z.string().min(1),
  replace: z.string().default(""),
  /**
   * Which message classes the rule touches. The values are precise:
   * - `ai` — assistant replies (applied when a reply is persisted, and at
   *   prompt assembly for assistant history that predates the rule);
   * - `user` — user messages (prompt assembly only);
   * - `prompt` — system/prompt blocks (preset prompts, character fields,
   *   persona, lorebook activations, summaries, depth injections).
   *
   * Unknown values are rejected and an empty list is rejected (`.min(1)`): a
   * rule that touches nothing is always a bug, never a no-op.
   */
  placement: z.array(regexPlacementSchema).min(1).default(["ai", "user"]),
  enabled: z.boolean().default(true),
});
export type RegexRule = z.infer<typeof regexRuleSchema>;
