/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { Hono } from "hono";
import type { RouteDeps } from "../routes-deps";

/** The built SPA: packages/web/dist, resolved from this file. */
const DIST_DIR = path.resolve(import.meta.dir, "../../../web/dist");

/**
 * Text-ish extensions worth compressing. Already-compressed formats (images,
 * fonts, wasm) are deliberately excluded: re-encoding them costs CPU and buys
 * almost nothing, and a double-encoded asset would defeat the point.
 */
const COMPRESSIBLE = new Set([
  ".js",
  ".mjs",
  ".css",
  ".html",
  ".svg",
  ".json",
  ".txt",
  ".xml",
  ".map",
  ".webmanifest",
]);

/**
 * Compressed bodies keyed by `path\0encoding`, invalidated by mtime, so a hot
 * asset is compressed once and then served from memory. The set is bounded by
 * the number of distinct built assets.
 */
const compressedCache = new Map<string, { mtimeMs: number; body: Uint8Array<ArrayBuffer> }>();

/**
 * Picks the best offered encoding: brotli over gzip. `q=0` (an explicit
 * refusal) is honored; other q-values are ignored, since either encoding is
 * always a strict improvement over sending the raw bytes.
 */
function pickEncoding(acceptEncoding: string | undefined): "br" | "gzip" | null {
  if (!acceptEncoding) {
    return null;
  }
  const lower = acceptEncoding.toLowerCase();
  if (/\bbr\b/.test(lower) && !/\bbr\s*;\s*q=0(?:\.0+)?\b/.test(lower)) {
    return "br";
  }
  if (/\bgzip\b/.test(lower) && !/\bgzip\s*;\s*q=0(?:\.0+)?\b/.test(lower)) {
    return "gzip";
  }
  return null;
}

/** Reads + compresses a file, reusing the cached body while its mtime holds. */
async function compressedBody(
  resolved: string,
  encoding: "br" | "gzip",
  mtimeMs: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = `${resolved}\0${encoding}`;
  const hit = compressedCache.get(key);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) {
    return hit.body;
  }
  // Re-wrap in fresh ArrayBuffer-backed views: fs/zlib hand back Buffers,
  // whose ArrayBufferLike backing does not satisfy the DOM `BodyInit` types.
  const raw = new Uint8Array(await readFile(resolved));
  const body = new Uint8Array(encoding === "br" ? brotliCompressSync(raw) : gzipSync(raw));
  compressedCache.set(key, { mtimeMs, body });
  return body;
}

/**
 * Vite emits content-hashed filenames under `assets/`, so those are safe to
 * cache forever (immutable); everything else (index.html, favicon, anything
 * unhashed) revalidates so a new build is picked up immediately.
 */
function cacheControl(rel: string): string {
  return rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

/**
 * Serves an existing dist file with cache headers and, for compressible text
 * assets, a brotli/gzip body when the client offers one. Returns null when the
 * path is not a readable file (the caller falls back to index.html).
 */
async function serveFile(
  acceptEncoding: string | undefined,
  resolved: string,
  rel: string,
): Promise<Response | null> {
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) {
    return null;
  }
  const headers: Record<string, string> = { "cache-control": cacheControl(rel) };
  const ext = path.extname(resolved).toLowerCase();
  if (COMPRESSIBLE.has(ext)) {
    const encoding = pickEncoding(acceptEncoding);
    headers.vary = "Accept-Encoding";
    if (encoding !== null) {
      headers["content-encoding"] = encoding;
      headers["content-type"] = Bun.file(resolved).type || "application/octet-stream";
      const body = await compressedBody(resolved, encoding, info.mtimeMs);
      return new Response(body, { headers });
    }
  }
  return new Response(Bun.file(resolved), { headers });
}

/**
 * Serves the built web client; mounted last (after /api and /blobs) by
 * app.ts. A request path mapping to an existing dist file serves that file
 * (compressed when the client accepts it); anything else falls back to
 * index.html (SPA routing). Without a build, the JSON 404 keeps API-only mode
 * clean.
 */
export function staticRoutes(_deps?: RouteDeps): Hono {
  const app = new Hono();

  app.get("*", async (c) => {
    const raw = c.req.path.slice(1); // percent-encoded, without the leading "/"
    let rel: string;
    try {
      rel = decodeURIComponent(raw);
    } catch {
      return c.json({ error: "Invalid path" }, 400);
    }
    // Path-traversal protection, shaped like blobs.ts.
    if (rel.startsWith("/") || rel.includes("..") || rel.includes("\\")) {
      return c.json({ error: "Invalid path" }, 400);
    }
    const acceptEncoding = c.req.header("accept-encoding");
    if (rel !== "") {
      const resolved = path.resolve(DIST_DIR, rel);
      if (resolved.startsWith(`${DIST_DIR}${path.sep}`)) {
        const served = await serveFile(acceptEncoding, resolved, rel);
        if (served !== null) {
          return served;
        }
      }
    }
    const indexPath = path.join(DIST_DIR, "index.html");
    const index = await serveFile(acceptEncoding, indexPath, "index.html");
    if (index !== null) {
      return index;
    }
    return c.json({ error: "web client not built" }, 404);
  });

  return app;
}
