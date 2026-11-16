/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lorebook-generation module (AI-assisted lorebook entry content): the
 * settings-backed config accessor and the prompt builder. Consumed by the
 * server through the `lorebookGeneration` namespace
 * (`import { lorebookGeneration } from "@suvoj/core"`).
 */

export * from "./config";
export * from "./prompt";
