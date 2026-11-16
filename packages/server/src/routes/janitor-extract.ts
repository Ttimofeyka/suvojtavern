/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Hono } from "hono";
import { z } from "zod";
import { janitorErrorResponse } from "../janitor/errors";
import { captureAndReconstruct } from "../janitor/extract";
import { parseJsonBody, type RouteDeps } from "../routes-deps";
import { markJanitorLoggedIn } from "./janitor-state";

/**
 * Phase B janitor route: full extraction for a private-definition character.
 * The client reaches it through the "Extract anyway" button attached to the
 * `definition-private` error from /api/janitor/import.
 */

/** Body of POST /api/janitor/capture (same shape as /import). */
const captureSchema = z.object({
  url: z.string().min(1),
  onConflict: z.enum(["error", "rename", "replace"]).optional(),
  includeLorebooks: z.boolean().optional(),
});

export function janitorExtractRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.post("/api/janitor/capture", async (c) => {
    const parsed = parseJsonBody(captureSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    try {
      const result = await captureAndReconstruct(parsed.value, deps);
      markJanitorLoggedIn(deps);
      return c.json(result, 201);
    } catch (err) {
      const mapped = janitorErrorResponse(err);
      return c.json(mapped.body, mapped.status);
    }
  });

  return app;
}
