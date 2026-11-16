/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Character, CharacterImage } from "@suvoj/core";
import { images } from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import type { RouteDeps } from "../routes-deps";
import { badRequest, parseJsonBody } from "../routes-deps";

const imagePatchSchema = z.object({
  avatar: z.boolean().optional(),
  sort: z.number().int().optional(),
});

/**
 * Character image galleries: multipart uploads normalized to WebP blobs,
 * listing, per-image patching, and deletion.
 *
 * Blobs land in `<dataDir>/blobs` (the core default is `data/blobs`).
 * Deleting an image removes only its database row — the images module
 * exposes no blob-deletion API, so files stay on disk.
 */
export function galleryRoutes(deps: RouteDeps): Hono {
  const { repos } = deps;
  const blobDir = `${deps.dataDir ?? "data"}/blobs`;
  const app = new Hono();

  app.post("/api/characters/:id/images", async (c) => {
    const characterId = c.req.param("id");
    const character = repos.characters.get(characterId);
    if (!character) {
      return c.json({ error: `character ${characterId} not found` }, 404);
    }
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
    const record = repos.characters.addImage(characterId, {
      blob_path: blobPath,
      sort: repos.characters.listImages(characterId).length,
    });
    if (character.avatar_path === null) {
      repos.characters.update(characterId, { avatar_path: blobPath });
    }
    return c.json(record, 201);
  });

  app.get("/api/characters/:id/images", (c) => {
    const characterId = c.req.param("id");
    if (!repos.characters.get(characterId)) {
      return c.json({ error: `character ${characterId} not found` }, 404);
    }
    return c.json(repos.characters.listImages(characterId));
  });

  app.get("/api/characters/:id/images/:imageId", (c) => {
    const found = lookupImage(c.req.param("id"), c.req.param("imageId"));
    if (!found.ok) {
      return c.json({ error: found.message }, 404);
    }
    return c.json(found.image);
  });

  app.patch("/api/characters/:id/images/:imageId", async (c) => {
    const found = lookupImage(c.req.param("id"), c.req.param("imageId"));
    if (!found.ok) {
      return c.json({ error: found.message }, 404);
    }
    const parsed = parseJsonBody(imagePatchSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    if (parsed.value.sort !== undefined) {
      repos.characters.updateImage(found.image.id, { sort: parsed.value.sort });
    }
    if (parsed.value.avatar !== undefined) {
      setAvatar(found.character, found.image, parsed.value.avatar);
    }
    return c.json(repos.characters.getImage(found.image.id));
  });

  app.delete("/api/characters/:id/images/:imageId", (c) => {
    const found = lookupImage(c.req.param("id"), c.req.param("imageId"));
    if (!found.ok) {
      return c.json({ error: found.message }, 404);
    }
    repos.characters.deleteImage(found.image.id);
    // If this image was the avatar, fall back to the first remaining one.
    if (
      found.character.avatar_path !== null &&
      found.character.avatar_path === found.image.blob_path
    ) {
      const remaining = repos.characters.listImages(found.character.id);
      repos.characters.update(found.character.id, {
        avatar_path: remaining[0]?.blob_path ?? null,
      });
    }
    return c.json({ ok: true });
  });

  /** The image record, but only when it belongs to the given character. */
  function lookupImage(
    characterId: string,
    imageId: string,
  ): { ok: false; message: string } | { ok: true; character: Character; image: CharacterImage } {
    const character = repos.characters.get(characterId);
    if (!character) {
      return { ok: false, message: `character ${characterId} not found` };
    }
    const image = repos.characters.getImage(imageId);
    if (!image || image.character_id !== characterId) {
      return {
        ok: false,
        message: `image ${imageId} not found for character ${characterId}`,
      };
    }
    return { ok: true, character, image };
  }

  /** Points the character's avatar at the image's blob; clears it when already set. */
  function setAvatar(character: Character, image: CharacterImage, on: boolean): void {
    if (on) {
      repos.characters.update(character.id, { avatar_path: image.blob_path });
    } else if (character.avatar_path !== null && character.avatar_path === image.blob_path) {
      repos.characters.update(character.id, { avatar_path: null });
    }
  }

  return app;
}
