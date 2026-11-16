/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Hono } from "hono";
import type { RouteDeps } from "../routes-deps";
import { transferExportRoutes } from "./transfer-export";
import { transferImportRoutes } from "./transfer-import";

/**
 * SillyTavern import/export (transfer) routes. Thin composer mounting the
 * import and export halves (kept apart to stay small); the future app.ts
 * mounts this module.
 */
export function transferRoutes(deps: RouteDeps): Hono {
  const app = new Hono();
  app.route("/", transferImportRoutes(deps));
  app.route("/", transferExportRoutes(deps));
  return app;
}
