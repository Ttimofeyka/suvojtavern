/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { createRepositories } from "@suvoj/core";
import type { z } from "zod";
import type { createGateway } from "./gateway";
import type { JanitorBrowser } from "./janitor/browser";
import type { PluginHost } from "./plugins/host";

export type Repos = ReturnType<typeof createRepositories>;
export type Gateway = ReturnType<typeof createGateway>;

/**
 * The JanitorAI browser surface the janitor routes actually use. Narrowed to
 * a `Pick` so tests can inject a fake (a class with private fields is not
 * structurally assignable, but this selection of its public methods is).
 */
export type JanitorBrowserHandle = Pick<
  JanitorBrowser,
  "status" | "withView" | "dispose" | "clearProfile"
>;

export interface RouteDeps {
  repos: Repos;
  gateway: Gateway;
  dataDir?: string; // defaults to "data"
  /** Fetch implementation for routes that download directly (tests stub this). */
  fetchImpl?: typeof fetch;
  /**
   * Plugin host (present whenever the app is built through createApp;
   * tests composing route modules directly may omit it — generate.ts
   * treats absence as "no plugins").
   */
  plugins?: PluginHost;
  /**
   * JanitorAI browser engine. Tests inject a fake; otherwise
   * {@link getJanitorBrowser} constructs one lazily on first use (never at
   * app boot, so no Chrome process exists until an import/login asks for it).
   */
  janitorBrowser?: JanitorBrowserHandle;
}

export function badRequest(
  message: string,
  details?: unknown,
): { error: string; details?: unknown } {
  return details === undefined ? { error: message } : { error: message, details };
}

export function parseJsonBody<T>(
  schema: z.ZodType<T>,
  raw: unknown,
): { ok: true; value: T } | { ok: false; error: { error: string; details?: unknown } } {
  const result = schema.safeParse(raw);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    error: badRequest(
      "Invalid request body",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    ),
  };
}
