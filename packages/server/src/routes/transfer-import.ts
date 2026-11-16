/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { st } from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import { janitorErrorResponse } from "../janitor/errors";
import { importPublicCard } from "../janitor/import";
import type { RouteDeps } from "../routes-deps";
import { badRequest, parseJsonBody } from "../routes-deps";

/** PNG magic bytes — a card file starting with these is a PNG, else JSON text. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const;

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= PNG_MAGIC.length && PNG_MAGIC.every((byte, index) => bytes[index] === byte)
  );
}

/** A non-empty string form field; anything else (missing, empty, a File) is absent. */
function stringField(value: string | File | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Core importers throw plain Errors on bad input; surface their message. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- URL import -------------------------------------------------------------------

const importUrlSchema = z.object({
  url: z.string().min(1),
  onConflict: z.enum(["error", "rename", "replace"]).optional(),
});

/** Body of POST /api/import/preset: preset JSON text + conflict policy + name override. */
const importPresetSchema = z.object({
  raw: z.string().min(1),
  onConflict: z.enum(["error", "rename", "replace"]).optional(),
  name: z.string().min(1).optional(),
});

/** Timeout for every remote fetch (chub metadata, chub avatar, direct links). */
const FETCH_TIMEOUT_MS = 30_000;
/** Metadata JSON is tiny; 10 MB is a generous ceiling. */
const METADATA_MAX_BYTES = 10 * 1024 * 1024;
/** Card / avatar download ceiling. */
const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * A remote-source failure. `status` picks the response: upstream/network
 * problems are 502; unusable input (bad scheme, unsupported content) is 400.
 * Plain errors from the core importers stay 400 (bad card).
 */
class RemoteError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 502 = 502,
  ) {
    super(message);
  }
}

/** What a remote source yielded, ready for the core importer. */
type RemoteCard =
  | { kind: "chub"; card: unknown; avatar?: Uint8Array }
  | { kind: "json"; card: unknown }
  | { kind: "png"; bytes: Uint8Array };

interface Download {
  bytes: Uint8Array;
  contentType: string;
  /** File name from Content-Disposition or the URL path, when either exists. */
  filename: string | null;
}

interface DownloadOptions {
  maxBytes: number;
  /** Error-message label: "chub.ai request failed (404)". */
  label: string;
  accept?: string;
}

/** `filename="card.png"` (or unquoted) out of a Content-Disposition header. */
function filenameFromDisposition(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  const match = /filename="?([^";]+)"?/i.exec(header);
  return match?.[1] ?? null;
}

/** The URL's last path segment (a download name), or null for a bad URL. */
function filenameFromUrl(url: string): string | null {
  try {
    return (
      new URL(url).pathname
        .split("/")
        .filter((segment) => segment !== "")
        .pop() ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Fetches an http(s) `url` with a 30s abort timeout (redirects are followed
 * by fetch itself) and the response size capped twice: the declared
 * content-length up front, then the streamed body as it is read. Every
 * remote fetch goes through here — chub metadata, chub avatars
 * (`max_res_url` is remote data) and direct links alike — so the scheme
 * check is the single choke point.
 */
async function download(
  fetchImpl: typeof fetch,
  url: string,
  opts: DownloadOptions,
): Promise<Download> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new RemoteError("invalid url", 400);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new RemoteError("url must be an http(s) URL", 400);
  }
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        ...(opts.accept === undefined ? {} : { Accept: opts.accept }),
        "User-Agent": "SuvojTavern",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RemoteError(`${opts.label} request failed: ${messageOf(err)}`);
  }
  if (!res.ok) {
    throw new RemoteError(`${opts.label} request failed (${res.status})`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > opts.maxBytes) {
    throw new RemoteError(`${opts.label} response exceeds ${opts.maxBytes} bytes`);
  }
  const chunks: Uint8Array[] = [];
  const reader = res.body?.getReader();
  if (reader !== undefined) {
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RemoteError(`${opts.label} response exceeds ${opts.maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } else {
    // Invariant: null bodies are empty in practice (e.g. 204s) — nothing to cap.
    chunks.push(new Uint8Array(await res.arrayBuffer()));
  }
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes,
    contentType: res.headers.get("content-type") ?? "",
    filename:
      filenameFromDisposition(res.headers.get("content-disposition")) ?? filenameFromUrl(url),
  };
}

/** Avatar sniff — a 200 HTML error page must not sink the chub import. */
function isRaster(bytes: Uint8Array): boolean {
  return (
    isPng(bytes) ||
    (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) || // JPEG
    (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) || // GIF
    (bytes[0] === 0x52 && // RIFF…WEBP
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50)
  );
}

/**
 * Fetches a chub character's metadata and avatar: the API `node` maps onto
 * a V2 card (core's chub.ts owns the field parity) and the `max_res_url`
 * image becomes the avatar through the importer's `sourcePng` pipeline. An
 * avatar that fails to download (or is not a raster) is ignored — the
 * character still imports.
 */
async function fetchChubCharacter(fetchImpl: typeof fetch, ref: st.ChubRef): Promise<RemoteCard> {
  const { bytes } = await download(fetchImpl, st.chubApiUrl(ref), {
    maxBytes: METADATA_MAX_BYTES,
    label: "chub.ai",
    accept: "application/json",
  });
  let metadata: unknown;
  try {
    metadata = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RemoteError("chub.ai response is not valid JSON");
  }
  const mapped = st.chubCardFromResponse(metadata, ref.creator);
  if (mapped === null) {
    throw new RemoteError("chub.ai response has no node object");
  }
  let avatar: Uint8Array | undefined;
  if (mapped.avatarUrl !== null) {
    try {
      const { bytes: avatarBytes } = await download(fetchImpl, mapped.avatarUrl, {
        maxBytes: DOWNLOAD_MAX_BYTES,
        label: "chub.ai avatar",
      });
      if (isRaster(avatarBytes)) {
        avatar = avatarBytes;
      }
    } catch {
      // Best-effort avatar: a failed download must not sink the import.
    }
  }
  return { kind: "chub", card: mapped.card, avatar };
}

/**
 * Fetches a generic http(s) URL and classifies it as a PNG or JSON card.
 * Self-hosted local app: no domain allowlist — every http(s) URL is fair
 * game. Content-type and file name (URL path / Content-Disposition) decide;
 * when both are missing or ambiguous the bytes are sniffed (PNG magic, then
 * a leading `{`).
 */
async function fetchDirectCard(fetchImpl: typeof fetch, url: string): Promise<RemoteCard> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new RemoteError("invalid url", 400);
  }
  // The http(s) scheme check lives in download() — the shared choke point.
  const { bytes, contentType, filename } = await download(fetchImpl, url, {
    maxBytes: DOWNLOAD_MAX_BYTES,
    label: target.host,
  });
  let png = contentType.startsWith("image/png") || /\.png$/i.test(filename ?? "");
  let json = !png && (contentType.includes("json") || /\.json$/i.test(filename ?? ""));
  if (!png && !json) {
    // Nothing declared: sniff the payload itself.
    png = isPng(bytes);
    json = !png && new TextDecoder().decode(bytes.slice(0, 256)).trimStart().startsWith("{");
  }
  if (png) {
    return { kind: "png", bytes };
  }
  if (json) {
    try {
      return { kind: "json", card: JSON.parse(new TextDecoder().decode(bytes)) };
    } catch {
      throw new RemoteError("url did not return valid JSON", 400);
    }
  }
  throw new RemoteError("unsupported content", 400);
}

/**
 * SillyTavern import routes: character cards (PNG with an embedded
 * `chara`/`ccv3` tEXt chunk, or raw JSON — `onConflict` decides duplicate
 * handling), chat JSONL files, and URL imports (chub.ai characters or
 * direct PNG/JSON card links).
 */
export function transferImportRoutes(deps: RouteDeps): Hono {
  const { repos } = deps;
  // Must match gallery.ts: core's saveBlob stores `<dataDir>/blobs/<uuid>.webp`.
  const blobDir = `${deps.dataDir ?? "data"}/blobs`;
  // Tests stub this; createApp wires its own fetchImpl option through.
  const fetchImpl = deps.fetchImpl ?? fetch;
  const app = new Hono();

  app.post("/api/import/card", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) {
      return c.json(badRequest("multipart body must contain a 'file' field"), 400);
    }
    if (file.size === 0) {
      return c.json(badRequest("uploaded 'file' is empty"), 400);
    }
    const onConflict = stringField(body.onConflict) ?? "error";
    if (onConflict !== "error" && onConflict !== "rename" && onConflict !== "replace") {
      return c.json(badRequest("onConflict must be one of: error, rename, replace"), 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      if (isPng(bytes)) {
        return c.json(await st.importCardFromPng(bytes, repos, { onConflict, blobDir }), 201);
      }
      let card: unknown;
      try {
        card = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return c.json(badRequest("uploaded 'file' is neither a PNG card nor valid JSON"), 400);
      }
      return c.json(await st.importCardFromJson(card, repos, { onConflict, blobDir }), 201);
    } catch (err) {
      return c.json(badRequest(messageOf(err)), 400);
    }
  });

  app.post("/api/import/url", async (c) => {
    const parsed = parseJsonBody(importUrlSchema, await c.req.json().catch(() => null));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const { url, onConflict = "error" } = parsed.value;

    const source = st.parseChubSource(url);
    if (source.kind === "error") {
      return c.json(badRequest(source.message), 400);
    }
    // janitorai.com is not a chub source, so the delegation lives here rather
    // than in the chub branch: a real character ref runs the native JanitorAI
    // import (which has its own browser + conflict policy), while a
    // janitor-shaped-but-unusable URL reports the specific reason. Every other
    // URL keeps the generic direct-link path untouched.
    if (source.kind === "other") {
      const janitor = st.parseJanitorSource(url);
      if (janitor.kind === "ref") {
        try {
          const result = await importPublicCard({ url, onConflict }, deps);
          return c.json({ ...result, source: "janitor" }, 201);
        } catch (err) {
          const mapped = janitorErrorResponse(err);
          return c.json(mapped.body, mapped.status);
        }
      }
      if (janitor.kind === "error") {
        return c.json(badRequest(janitor.message), 400);
      }
    }
    try {
      const remote =
        source.kind === "ref"
          ? await fetchChubCharacter(fetchImpl, source.ref)
          : await fetchDirectCard(fetchImpl, url);
      const result =
        remote.kind === "png"
          ? await st.importCardFromPng(remote.bytes, repos, { onConflict, blobDir })
          : await st.importCardFromJson(remote.card, repos, {
              onConflict,
              blobDir,
              sourcePng: remote.kind === "chub" ? remote.avatar : undefined,
            });
      return c.json({ ...result, source: remote.kind }, 201);
    } catch (err) {
      // RemoteError carries its status; core importer errors are bad cards.
      const status = err instanceof RemoteError ? err.status : 400;
      return c.json({ error: messageOf(err) }, status);
    }
  });

  app.post("/api/import/chat", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) {
      return c.json(badRequest("multipart body must contain a 'file' field"), 400);
    }
    const characterId = stringField(body.character_id);
    const characterName = stringField(body.character_name);
    if (characterId === undefined && characterName === undefined) {
      return c.json(badRequest("either character_id or character_name is required"), 400);
    }
    const target = resolveTarget(characterId, characterName);
    if ("error" in target) {
      return c.json({ error: target.error }, 404);
    }
    const title = file.name === "" ? null : file.name.replace(/\.jsonl$/i, "");
    try {
      return c.json(
        st.importChat(await file.text(), repos, { characterId: target.id, title }),
        201,
      );
    } catch (err) {
      return c.json(badRequest(messageOf(err)), 400);
    }
  });

  /**
   * Preset import: a native Suvoj document or a SillyTavern chat-completion
   * preset, carried as JSON TEXT like the lorebook import (the file is
   * parsed client-side and never uploaded). Conflict handling lives in core
   * (`st.importPreset`), which throws `PresetConflictError` → 409.
   */
  app.post("/api/import/preset", async (c) => {
    const parsed = parseJsonBody(importPresetSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    let source: unknown;
    try {
      source = JSON.parse(parsed.value.raw);
    } catch {
      return c.json(badRequest("raw is not valid JSON"), 400);
    }
    try {
      return c.json(
        st.importPreset(source, repos.presets, {
          onConflict: parsed.value.onConflict,
          name: parsed.value.name,
        }),
        201,
      );
    } catch (err) {
      if (err instanceof st.PresetConflictError) {
        return c.json({ error: err.message }, 409);
      }
      return c.json(badRequest(messageOf(err)), 400);
    }
  });

  /**
   * importChat resolves `character_name` itself but trusts `character_id`
   * (an unknown id would only fail at the SQL FK) — so pre-check both.
   */
  function resolveTarget(
    characterId: string | undefined,
    characterName: string | undefined,
  ): { id: string } | { error: string } {
    if (characterId !== undefined) {
      return repos.characters.get(characterId) === null
        ? { error: `character ${characterId} not found` }
        : { id: characterId };
    }
    const name = characterName ?? "";
    const found = repos.characters
      .list()
      .find((character) => character.name.toLowerCase() === name.toLowerCase());
    return found ? { id: found.id } : { error: `no character named "${name}"` };
  }

  return app;
}
