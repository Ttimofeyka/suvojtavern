/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { images, personaInputSchema } from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import type { RouteDeps } from "../routes-deps";
import { badRequest, parseJsonBody } from "../routes-deps";

/**
 * PATCH /api/personas/:id accepts any subset of the create fields.
 * Absent fields are left untouched — no defaults are applied here,
 * unlike the create schema.
 */
const personaPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  avatar_path: z.string().nullable().optional(),
});

/** Persona CRUD — /api/personas. */
export function personasRoutes(deps: RouteDeps): Hono {
  const blobDir = `${deps.dataDir ?? "data"}/blobs`;
  const app = new Hono();

  app.post("/api/personas", async (c) => {
    const parsed = parseJsonBody(personaInputSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    return c.json(deps.repos.personas.create(parsed.value), 201);
  });

  /**
   * Stores an avatar for the editor: multipart `file`, normalized to a WebP
   * blob under `<dataDir>/blobs`. Not tied to a persona id — the editor
   * uploads before the persona exists and sends the returned path in the
   * normal create/PATCH JSON. Replaced avatars keep their blobs on disk,
   * same as the gallery routes (the images module has no blob-deletion API).
   */
  app.post("/api/personas/avatar", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) {
      return c.json(badRequest("multipart body must contain a 'file' field"), 400);
    }
    if (file.size === 0) {
      return c.json(badRequest("uploaded 'file' is empty"), 400);
    }
    let webp: Uint8Array;
    try {
      webp = await images.toWebp(new Uint8Array(await file.arrayBuffer()));
    } catch {
      return c.json(badRequest("uploaded 'file' is not a decodable image"), 400);
    }
    const blobPath = images.saveBlob(webp, "webp", { dir: blobDir });
    return c.json({ avatar_path: blobPath }, 201);
  });

  app.get("/api/personas", (c) => c.json(deps.repos.personas.list()));

  app.get("/api/personas/:id", (c) => {
    const persona = deps.repos.personas.get(c.req.param("id"));
    if (!persona) {
      return c.json({ error: "persona not found" }, 404);
    }
    return c.json(persona);
  });

  app.patch("/api/personas/:id", async (c) => {
    const parsed = parseJsonBody(personaPatchSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const updated = deps.repos.personas.update(c.req.param("id"), parsed.value);
    if (!updated) {
      return c.json({ error: "persona not found" }, 404);
    }
    return c.json(updated);
  });

  app.delete("/api/personas/:id", (c) => {
    if (!deps.repos.personas.delete(c.req.param("id"))) {
      return c.json({ error: "persona not found" }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}
