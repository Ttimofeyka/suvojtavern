/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import PNGtext from "png-chunk-text";
import encodePngChunks from "png-chunks-encode";
import extractPngChunks from "png-chunks-extract";
import sharp from "sharp";
import { readBlob } from "../images";
import type { Character } from "../schema/characters";

/**
 * Character card export: SillyTavern-compatible V2 card JSON embedded in a
 * `chara` tEXt chunk (PNG), or the native JSON shape.
 */

// --- V2 JSON -------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Builds the V2 card JSON: native columns win, everything the original card
 * carried that has no native column (creator, character_version,
 * extensions, V3 extras like `nickname`/`assets`/`group_only_greetings`, …)
 * is merged back from `card_raw`.
 */
export function buildCardV2Json(character: Character): Record<string, unknown> {
  const raw = asRecord(character.card_raw);
  const rawData = asRecord(raw.data);

  const data: Record<string, unknown> = {
    ...rawData,
    name: character.name,
    description: character.description,
    personality: character.personality,
    scenario: character.scenario,
    first_mes: character.first_mes,
    mes_example: character.mes_example,
    creator_notes: character.creator_notes,
    system_prompt: character.system_prompt,
    post_history_instructions: character.post_history_instructions,
    alternate_greetings: character.alternate_greetings,
    tags: character.tags,
  };
  if (typeof data.creator !== "string") {
    data.creator = asString(rawData.creator);
  }
  if (typeof data.character_version !== "string") {
    data.character_version = asString(rawData.character_version);
  }
  if (!data.extensions || typeof data.extensions !== "object") {
    data.extensions = asRecord(rawData.extensions);
  }

  return {
    ...raw,
    spec: "chara_card_v2",
    spec_version: "2.0",
    name: character.name,
    description: character.description,
    personality: character.personality,
    scenario: character.scenario,
    first_mes: character.first_mes,
    mes_example: character.mes_example,
    data,
  };
}

/** The native JSON shape: every character column, `card_raw` parsed inline. */
export function exportCardJson(character: Character): Record<string, unknown> {
  return { ...character };
}

// --- PNG -------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function isPng(buffer: Uint8Array): boolean {
  return (
    buffer.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)
  );
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Placeholder avatar: a dark card-sized PNG with the character's name. */
async function placeholderPng(name: string): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="768">
    <rect width="100%" height="100%" fill="#1b1c22"/>
    <text x="50%" y="50%" fill="#d5d7e0" font-family="sans-serif" font-size="42"
          text-anchor="middle" dominant-baseline="middle">${escapeXml(name)}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Any raster input re-encoded as PNG (avatars are stored as WebP). */
async function toPng(buffer: Uint8Array): Promise<Uint8Array> {
  return isPng(buffer) ? buffer : sharp(buffer).png().toBuffer();
}

export interface CardPngExportOptions {
  /** Original card image bytes, when the caller still has them. */
  image?: Uint8Array;
  /** Base directory for resolving a relative `avatar_path` (default "."). */
  dataDir?: string;
}

/**
 * Exports the character as a PNG card: a `chara` tEXt chunk (base64 V2
 * JSON, like SillyTavern writes) is injected before IEND.
 *
 * The image is `options.image` when given, else the character's current
 * avatar file (re-encoded from WebP to PNG), else a generated placeholder.
 */
export async function exportCardPng(
  character: Character,
  opts: CardPngExportOptions = {},
): Promise<Uint8Array> {
  let image: Uint8Array | null = null;
  if (opts.image) {
    image = await toPng(opts.image);
  } else if (character.avatar_path) {
    const path = isAbsolute(character.avatar_path)
      ? character.avatar_path
      : resolve(opts.dataDir ?? ".", character.avatar_path);
    if (existsSync(path)) {
      image = await toPng(readBlob(path));
    }
  }
  const png = image ?? (await placeholderPng(character.name));

  const cardJson = JSON.stringify(buildCardV2Json(character));
  const charaChunk = PNGtext.encode("chara", Buffer.from(cardJson, "utf8").toString("base64"));

  // Strip any previous card chunks, then inject ours before IEND.
  const chunks = extractPngChunks(png).filter((chunk) => {
    if (chunk.name !== "tEXt") {
      return true;
    }
    const keyword = PNGtext.decode(chunk.data).keyword.toLowerCase();
    return keyword !== "chara" && keyword !== "ccv3";
  });
  chunks.splice(-1, 0, charaChunk);
  return encodePngChunks(chunks);
}
