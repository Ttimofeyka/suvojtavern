/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { newId } from "../util";

/**
 * The blob store: every image Suvoj persists (avatars, gallery, embedded
 * card assets) is normalized to lossless WebP under `data/blobs/` and
 * referenced by its relative path from the database.
 */

/** Root directory for stored blobs (relative to the process working dir). */
export const BLOB_DIR = "data/blobs";

export interface ToWebpOptions {
  /** Max pixel width; taller images shrink proportionally (default 1024). */
  maxWidth?: number;
}

/**
 * Normalizes any raster input (PNG/JPEG/WebP/…) to lossless WebP.
 *
 * `sharp` runs its work on its own native threadpool (libuv plus a
 * per-CPU worker pool for pixel operations), so image transcoding — unlike
 * everything else in core — already parallelizes across cores without us
 * spawning workers ourselves.
 */
export async function toWebp(
  input: Uint8Array | Buffer | string,
  opts: ToWebpOptions = {},
): Promise<Uint8Array> {
  return sharp(input)
    .rotate() // honor EXIF orientation before resizing
    .resize({ width: opts.maxWidth ?? 1024, withoutEnlargement: true, fit: "inside" })
    .webp({ lossless: true, effort: 4 })
    .toBuffer();
}

export interface SaveBlobOptions {
  /** Directory to write into (default `data/blobs`). */
  dir?: string;
}

/**
 * Writes `buffer` to the blob store as `<uuid>.<ext>` and returns the
 * relative path (`<dir>/<uuid>.<ext>`), the shape stored in DB columns.
 */
export function saveBlob(buffer: Uint8Array, ext = "webp", opts: SaveBlobOptions = {}): string {
  const dir = opts.dir ?? BLOB_DIR;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${newId()}.${ext}`;
  writeFileSync(path, new Uint8Array(buffer));
  return path;
}

/** Reads a blob back (paths are relative to the process working dir). */
export function readBlob(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}
