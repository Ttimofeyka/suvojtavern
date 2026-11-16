/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/** Chat creation data. */
export const chatInputSchema = z.object({
  character_id: z.string().min(1),
  persona_id: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
});

export type ChatInput = z.input<typeof chatInputSchema>;

export const chatSchema = chatInputSchema.extend({
  id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  /** Message id (in the parent chat) this chat was forked from, if any. */
  branch_root_id: z.string().nullable(),
  /** Child chat id currently followed from this chat, if any. */
  active_branch: z.string().nullable(),
  /** Per-chat tracker switch. The effective state is
   *  `tracker_config.enabled && tracker_enabled` — the global setting stays
   *  the master switch, and this lets one chat opt out. Defaults on so every
   *  existing chat keeps tracking exactly as before. */
  tracker_enabled: z.boolean(),
});

export type Chat = z.infer<typeof chatSchema>;

/** Options accepted by {@link ChatsRepository.forkChat}. */
export interface ForkChatOptions {
  /** Fork title; defaults to `<parent title> (branch)`. */
  title?: string;
  /** Persona override; defaults to the parent chat's persona. */
  persona_id?: string | null;
}
