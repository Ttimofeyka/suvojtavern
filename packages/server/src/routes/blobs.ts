/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { stat } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import type { RouteDeps } from "../routes-deps";

const BLOBS_PREFIX = "/blobs/";

/**
 * Serves the blob store (`data/blobs/<uuid>.webp` — where core's `saveBlob`
 * writes every persisted image) with path-traversal protection.
 */
export function blobsRoutes(deps: RouteDeps): Hono {
  const app = new Hono();
  const blobsDir = path.resolve(deps.dataDir ?? "data", "blobs");

  app.get("/blobs/*", async (c) => {
    const raw = c.req.path.slice(BLOBS_PREFIX.length);
    let rel: string;
    try {
      rel = decodeURIComponent(raw);
    } catch {
      return c.json({ error: "Invalid blob path" }, 400);
    }
    if (rel === "" || rel.startsWith("/") || rel.includes("..") || rel.includes("\\")) {
      return c.json({ error: "Invalid blob path" }, 400);
    }
    const resolved = path.resolve(blobsDir, rel);
    if (resolved !== blobsDir && !resolved.startsWith(`${blobsDir}${path.sep}`)) {
      return c.json({ error: "Invalid blob path" }, 400);
    }
    const info = await stat(resolved).catch(() => null);
    if (info === null || !info.isFile()) {
      return c.json({ error: "Blob not found" }, 404);
    }
    return new Response(Bun.file(resolved), {
      headers: { "Content-Type": "image/webp", "Cache-Control": "no-store" },
    });
  });

  return app;
}
