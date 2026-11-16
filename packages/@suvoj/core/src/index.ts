/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/// <reference path="./types/png-chunks.d.ts" />

/**
 * @suvoj/core — the pure TypeScript engine of Suvoj.
 *
 * Schemas, the data layer (SQLite repositories, migrations, lifecycle
 * hooks), the lorebook engine, tokenizers, and the prompt assembler live in
 * this package. It must stay free of server and DOM dependencies so it can
 * be consumed by both the server and tooling directly.
 */
export const CORE_NAME = "@suvoj/core";

/**
 * AI-assisted character card generation (config accessor + prompt builder)
 * is namespaced so its schema-level names (e.g. the config type) don't
 * collide with the flat schema exports; `import { characterGeneration } from
 * "@suvoj/core"`.
 */
export * as characterGeneration from "./character-generation";
export * from "./db/database";
export { type Migration, runMigrations } from "./db/migrate";
export { migrations } from "./db/migrations";
/**
 * The engine surface is exported under the `engine` namespace: its
 * `Preset`/`presetSchema` (the native prompt-layout format) deliberately
 * shadow-free coexist with the schema layer's repository-row types of the
 * same name. `import { engine } from "@suvoj/core"`.
 */
export * as engine from "./engine";
export * as images from "./images";
/**
 * AI-assisted lorebook entry generation (config accessor + prompt builder) is
 * namespaced so its schema-level names (e.g. the config type) don't collide
 * with the flat schema exports; `import { lorebookGeneration } from
 * "@suvoj/core"`.
 */
export * as lorebookGeneration from "./lorebook-generation";
export * from "./repositories";
export * from "./schema";
export * as st from "./st";
export * as tracker from "./tracker";
