/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Hono } from "hono";
import type { RouteDeps } from "../routes-deps";
import { janitorExtractRoutes } from "./janitor-extract";
import { janitorImportRoutes } from "./janitor-import";

/**
 * Native JanitorAI import routes. Thin composer mounting the two halves (kept
 * apart to stay small): Phase A (status/login/logout/import) and Phase B
 * (capture). The app's composition root mounts this module.
 */
export function janitorRoutes(deps: RouteDeps): Hono {
  const app = new Hono();
  app.route("/", janitorImportRoutes(deps));
  app.route("/", janitorExtractRoutes(deps));
  return app;
}
