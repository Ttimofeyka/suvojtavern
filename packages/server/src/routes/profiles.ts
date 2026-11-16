/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { profileInputSchema, profilePatchSchema } from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import { resolveEndpoint } from "../gateway";
import { ACTIVE_PROFILE_KEY, resolveActiveProfile } from "../profiles";
import type { RouteDeps } from "../routes-deps";
import { parseJsonBody } from "../routes-deps";

/** Body of PUT /api/profiles/active. */
const activeProfileSchema = z.object({
  id: z.string().min(1),
});

/** Connection profile CRUD + the active-profile switch — /api/profiles. */
export function profilesRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/api/profiles", (c) =>
    c.json({
      profiles: deps.repos.profiles.list(),
      active_profile_id: resolveActiveProfile(deps.repos)?.id ?? null,
    }),
  );

  // Per-profile model list: resolves the profile's own endpoint (its custom
  // base URL + key) so the settings UI shows models from the endpoint that
  // profile actually talks to.
  app.get("/api/profiles/:id/models", async (c) => {
    const profile = deps.repos.profiles.get(c.req.param("id"));
    if (!profile) {
      return c.json({ error: "profile not found" }, 404);
    }
    const models = await deps.gateway.getModels(await resolveEndpoint(deps.repos, profile));
    return c.json({ models });
  });

  app.post("/api/profiles", async (c) => {
    const parsed = parseJsonBody(profileInputSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    return c.json(deps.repos.profiles.create(parsed.value), 201);
  });

  app.patch("/api/profiles/:id", async (c) => {
    const parsed = parseJsonBody(profilePatchSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const updated = deps.repos.profiles.update(c.req.param("id"), parsed.value);
    if (!updated) {
      return c.json({ error: "profile not found" }, 404);
    }
    return c.json(updated);
  });

  app.delete("/api/profiles/:id", (c) => {
    const profile = deps.repos.profiles.get(c.req.param("id"));
    if (!profile) {
      return c.json({ error: "profile not found" }, 404);
    }
    if (profile.is_default) {
      return c.json({ error: "the default profile cannot be deleted" }, 403);
    }
    if (deps.repos.profiles.list().length <= 1) {
      return c.json({ error: "cannot delete the last remaining profile" }, 400);
    }
    deps.repos.profiles.delete(profile.id);
    // Hygiene: read-time resolution already self-heals a stale active id,
    // but clear it here so the setting doesn't keep pointing at a
    // deleted profile.
    const storedActive = deps.repos.settings.get(ACTIVE_PROFILE_KEY);
    if (typeof storedActive === "string" && storedActive === profile.id) {
      deps.repos.settings.delete(ACTIVE_PROFILE_KEY);
    }
    return c.json({ ok: true });
  });

  app.put("/api/profiles/active", async (c) => {
    const parsed = parseJsonBody(activeProfileSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    if (!deps.repos.profiles.get(parsed.value.id)) {
      return c.json({ error: "profile not found" }, 404);
    }
    deps.repos.settings.set(ACTIVE_PROFILE_KEY, parsed.value.id);
    return c.json({ ok: true, active_profile_id: parsed.value.id });
  });

  return app;
}
