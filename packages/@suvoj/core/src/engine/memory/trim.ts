/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import type { Message } from "../../schema/messages";
import { countTokens } from "../tokens";
import type { MemoryStrategy } from "./index";

/**
 * Built-in strategy #1 — `trim`: drop the oldest messages until the history
 * fits the token budget. The newest `keep_last`/`min_keep` messages are
 * always preserved (even over budget) so generation keeps some context.
 */

export const trimConfigSchema = z.object({
  /** Number of newest messages that are never dropped. */
  keep_last: z.number().int().min(0).default(2),
  /** Hard floor of remaining messages before trimming gives up. */
  min_keep: z.number().int().min(1).default(1),
});
export type TrimConfig = z.infer<typeof trimConfigSchema>;

export const trimStrategy: MemoryStrategy = {
  id: "trim",
  name: "Trim oldest messages",
  configSchema: trimConfigSchema,
  apply: (history, budget, ctx) => {
    const config = trimConfigSchema.parse(ctx.config);
    const floor = Math.max(config.min_keep, config.keep_last, 1);
    const tokens = history.map((message) => countTokens(message.content) + 4);
    let total = tokens.reduce((sum, value) => sum + value, 0);
    let start = 0;
    const maxStart = Math.max(0, history.length - floor);
    while (total > budget && start < maxStart) {
      const messageTokens = tokens[start] ?? 0;
      total -= messageTokens;
      start += 1;
    }
    const kept: Message[] = history.slice(start);
    return Promise.resolve({ history: kept });
  },
};
