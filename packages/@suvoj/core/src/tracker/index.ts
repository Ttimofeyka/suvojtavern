/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tracker module (the Suvoj Tracker surface): generation defaults, the JSON
 * schema→example walker, the response parser, the mechanism registry with
 * the built-in `suvoj-tracker` mechanism, and the prompt-injection stage +
 * config accessor. Consumed by the server through the `tracker` namespace
 * (`import { tracker } from "@suvoj/core"`) and re-exported as types by
 * @suvoj/plugin-sdk.
 */

export * from "./defaults";
export * from "./injection";
export * from "./mechanism-suvoj-tracker";
export * from "./parser";
export * from "./parts";
export * from "./registry";
export * from "./schema-to-example";
