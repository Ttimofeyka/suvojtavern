/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";

/**
 * Scoped variable store (the tracker surface). `global` is one
 * namespace (`scope_id` NULL); `chat` is keyed by chat id. Macros like
 * `{{setvar}}`/`{{getvar}}` read and write the same rows.
 */
export const variableScopeSchema = z.enum(["global", "chat"]);

export type VariableScope = z.infer<typeof variableScopeSchema>;
