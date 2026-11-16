/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";

export const messageRoleSchema = z.enum(["system", "user", "assistant"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

/**
 * Message creation data (parent chat id passed to the repo). Free-form
 * `metadata` is the extension point future modules (the tracker) use to attach
 * DB space to exact messages.
 */
export const messageInputSchema = z.object({
  role: messageRoleSchema,
  content: z.string(),
  name: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).nullable().default(null),
});

export type MessageInput = z.input<typeof messageInputSchema>;

export const messageSchema = messageInputSchema.extend({
  id: z.string(),
  chat_id: z.string(),
  /** 1-based position in the chat; swipe siblings share one seq. */
  seq: z.number().int(),
  /** Id of the group's first variant — swipes share it, null otherwise. */
  variant_of: z.string().nullable(),
  /** Whether this row is the chosen swipe of its group. */
  active: z.boolean(),
  created_at: z.string(),
});

export type Message = z.infer<typeof messageSchema>;
