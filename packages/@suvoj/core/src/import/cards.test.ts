/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import PNGtext from "png-chunk-text";
import encodePngChunks from "png-chunks-encode";
import extractPngChunks from "png-chunks-extract";
import sharp from "sharp";
import { exportCardJson, exportCardPng } from "../export/cards";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import { createTestDb } from "../test-utils";
import { importCardFromJson, importCardFromPng } from "./cards";

/** Isolated blob directory for tests (cleaned up afterwards). */
const BLOB_DIR = "data/blobs/test";

let repos: Repositories;

beforeEach(() => {
  repos = createRepositories(createTestDb());
});

afterEach(() => {
  rmSync(BLOB_DIR, { recursive: true, force: true });
});

const V1_CARD = {
  name: "Alice",
  description: "A test character.",
  personality: "kind",
  scenario: "A quiet room.",
  first_mes: "Hello there!",
  mes_example: "<START>\n{{user}}: Hi\n{{char}}: Hello",
};

const V2_CARD = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  name: "Bob",
  data: {
    name: "Bob",
    description: "A v2 character.",
    personality: "gruff",
    scenario: "A tavern.",
    first_mes: "What do you want?",
    mes_example: "",
    creator_notes: "Made for testing.",
    system_prompt: "You are Bob.",
    post_history_instructions: "Stay in character.",
    alternate_greetings: ["Hmph.", "Go away."],
    tags: ["fantasy", "male"],
    creator: "someone",
    character_version: "1.0",
    extensions: { depth_prompt: { prompt: "", depth: 4, role: "system" } },
    character_book: {
      name: "Bob's World",
      entries: [
        {
          id: 0,
          keys: ["castle"],
          secondary_keys: [],
          comment: "castle",
          content: "The castle on the hill.",
          constant: true,
          selective: false,
          insertion_order: 10,
          enabled: true,
          position: "before_char",
          use_regex: true,
          extensions: { position: 0, depth: 4, probability: 100, useProbability: true },
        },
      ],
    },
  },
};

/** 1×1 red PNG, embedded as a V3 asset data URI. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** The {@link TINY_PNG_BASE64} bytes, used as a `sourcePng` import image. */
const TINY_PNG = new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64"));

const V3_CARD = {
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "Vera",
    description: "A v3 character.",
    personality: "cold",
    scenario: "A station.",
    first_mes: "State your business.",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: ["Well?"],
    tags: ["scifi"],
    creator: "vera-dev",
    character_version: "3.0",
    nickname: "V",
    group_only_greetings: ["(group only)"],
    assets: [
      {
        type: "image/png",
        uri: `data:image/png;base64,${TINY_PNG_BASE64}`,
        name: "portrait",
        ext: "png",
      },
    ],
  },
};

describe("importCardFromJson", () => {
  it("imports a V1 flat card", async () => {
    const { character, lorebook } = await importCardFromJson(V1_CARD, repos);
    expect(character.name).toBe("Alice");
    expect(character.description).toBe("A test character.");
    expect(character.personality).toBe("kind");
    expect(character.scenario).toBe("A quiet room.");
    expect(character.first_mes).toBe("Hello there!");
    expect(character.avatar_path).toBeNull();
    expect(lorebook).toBeNull();
    expect(character.card_raw).toEqual(V1_CARD);
  });

  it("imports a V2 card with an embedded character_book", async () => {
    const { character, lorebook } = await importCardFromJson(V2_CARD, repos);
    expect(character.name).toBe("Bob");
    expect(character.creator_notes).toBe("Made for testing.");
    expect(character.system_prompt).toBe("You are Bob.");
    expect(character.post_history_instructions).toBe("Stay in character.");
    expect(character.alternate_greetings).toEqual(["Hmph.", "Go away."]);
    expect(character.tags).toEqual(["fantasy", "male"]);
    expect(character.card_raw).toEqual(V2_CARD);

    expect(lorebook).not.toBeNull();
    const entries = repos.lorebooks.listEntries((lorebook as { id: string }).id);
    expect((lorebook as { name: string }).name).toBe("Bob's World");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.keys).toEqual(["castle"]);
    expect(entries[0]?.content).toBe("The castle on the hill.");
    expect(entries[0]?.constant).toBe(true);
    expect(entries[0]?.enabled).toBe(true);
    expect(repos.lorebooks.listForCharacter(character.id).map((b) => b.id)).toEqual([
      (lorebook as { id: string }).id,
    ]);
  });

  it("imports a V3 card: image assets become gallery entries, extras stay in card_raw", async () => {
    const { character } = await importCardFromJson(V3_CARD, repos, { blobDir: BLOB_DIR });
    expect(character.name).toBe("Vera");
    const gallery = repos.characters.listImages(character.id);
    expect(gallery).toHaveLength(1);
    expect(gallery[0]?.blob_path).toContain(BLOB_DIR);
    // Stored lossless WebP.
    const metadata = await sharp(
      repos.characters.getImage(gallery[0]?.id ?? "")?.blob_path ?? "",
    ).metadata();
    expect(metadata.format).toBe("webp");
    // V3-only fields survive through card_raw.
    const raw = character.card_raw as { data: Record<string, unknown> };
    expect(raw.data.nickname).toBe("V");
    expect(raw.data.group_only_greetings).toEqual(["(group only)"]);
  });

  it("requires a name", async () => {
    await expect(importCardFromJson({ description: "no name" }, repos)).rejects.toThrow("no name");
  });

  describe("onConflict", () => {
    it("errors by default on a name collision", async () => {
      await importCardFromJson(V1_CARD, repos);
      await expect(importCardFromJson({ ...V1_CARD }, repos)).rejects.toThrow("already exists");
    });

    it("renames into a free slot", async () => {
      await importCardFromJson(V1_CARD, repos);
      const { character, renamed } = await importCardFromJson({ ...V1_CARD }, repos, {
        onConflict: "rename",
      });
      expect(renamed).toBe(true);
      expect(character.name).toBe("Alice (2)");
      expect(repos.characters.list()).toHaveLength(2);
    });

    it("replaces the existing character in place", async () => {
      const first = await importCardFromJson(V1_CARD, repos);
      const second = await importCardFromJson({ ...V1_CARD, description: "updated" }, repos, {
        onConflict: "replace",
      });
      expect(second.character.id).toBe(first.character.id);
      expect(second.character.description).toBe("updated");
      expect(repos.characters.list()).toHaveLength(1);
    });
  });
});

describe("gallery avatar mirroring", () => {
  it("mirrors the source image into the gallery", async () => {
    const { character } = await importCardFromJson(V2_CARD, repos, {
      blobDir: BLOB_DIR,
      sourcePng: TINY_PNG,
    });
    const gallery = repos.characters.listImages(character.id);
    expect(gallery).toHaveLength(1);
    expect(gallery[0]?.blob_path).toBe(character.avatar_path);
    expect(gallery[0]?.sort).toBe(0);
  });

  it("puts the avatar first and keeps V3 asset sorts collision-free", async () => {
    const card = {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "Multi",
        assets: [
          { type: "image/png", uri: `data:image/png;base64,${TINY_PNG_BASE64}` },
          { type: "image/png", uri: `data:image/png;base64,${TINY_PNG_BASE64}` },
        ],
      },
    };
    const { character } = await importCardFromJson(card, repos, {
      blobDir: BLOB_DIR,
      sourcePng: TINY_PNG,
    });
    const gallery = repos.characters.listImages(character.id);
    expect(gallery).toHaveLength(3);
    expect(gallery[0]?.blob_path).toBe(character.avatar_path);
    expect(gallery.map((image) => image.sort)).toEqual([0, 1, 2]);
    expect(new Set(gallery.map((image) => image.blob_path)).size).toBe(3);
  });

  it("does not duplicate the avatar mirror across replace re-imports", async () => {
    const first = await importCardFromJson(V2_CARD, repos, {
      blobDir: BLOB_DIR,
      sourcePng: TINY_PNG,
    });
    const second = await importCardFromJson(V2_CARD, repos, {
      blobDir: BLOB_DIR,
      sourcePng: TINY_PNG,
      onConflict: "replace",
    });
    expect(second.character.id).toBe(first.character.id);
    const gallery = repos.characters.listImages(second.character.id);
    expect(gallery).toHaveLength(1);
    expect(gallery[0]?.blob_path).toBe(second.character.avatar_path);
  });

  it("leaves the gallery empty when a JSON card carries no image", async () => {
    const { character } = await importCardFromJson(V1_CARD, repos);
    expect(character.avatar_path).toBeNull();
    expect(repos.characters.listImages(character.id)).toEqual([]);
  });

  it("imports V3 assets unchanged when the card has no source image", async () => {
    const { character } = await importCardFromJson(V3_CARD, repos, { blobDir: BLOB_DIR });
    const gallery = repos.characters.listImages(character.id);
    expect(gallery).toHaveLength(1);
    expect(gallery[0]?.sort).toBe(0);
    expect(gallery[0]?.blob_path).toContain(BLOB_DIR);
  });
});

describe("PNG card round-trip", () => {
  /** Builds a PNG carrying `card` in a `chara` tEXt chunk (ST style). */
  async function cardPng(card: unknown): Promise<Uint8Array> {
    const png = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    const chunks = extractPngChunks(png);
    chunks.splice(
      -1,
      0,
      PNGtext.encode("chara", Buffer.from(JSON.stringify(card)).toString("base64")),
    );
    return encodePngChunks(chunks);
  }

  it("imports from PNG, converts the avatar, and round-trips through export", async () => {
    const imported = await importCardFromPng(await cardPng(V2_CARD), repos, { blobDir: BLOB_DIR });
    const character = imported.character;
    expect(character.name).toBe("Bob");
    expect(character.alternate_greetings).toEqual(["Hmph.", "Go away."]);

    // The source PNG became a lossless WebP avatar.
    expect(character.avatar_path).toContain(BLOB_DIR);
    const avatarMetadata = await sharp(character.avatar_path as string).metadata();
    expect(avatarMetadata.format).toBe("webp");

    // The embedded book came along.
    expect(imported.lorebook?.name).toBe("Bob's World");
    expect(repos.lorebooks.listEntries(imported.lorebook?.id ?? "")).toHaveLength(1);

    // Export → re-import preserves the mapped fields.
    const exported = await exportCardPng(character);
    const reimported = await importCardFromPng(exported, repos, {
      blobDir: BLOB_DIR,
      onConflict: "replace",
    });
    const again = reimported.character;
    expect(again.name).toBe("Bob");
    expect(again.description).toBe("A v2 character.");
    expect(again.personality).toBe("gruff");
    expect(again.first_mes).toBe("What do you want?");
    expect(again.alternate_greetings).toEqual(["Hmph.", "Go away."]);
    expect(again.tags).toEqual(["fantasy", "male"]);
    expect(again.creator_notes).toBe("Made for testing.");
    expect(reimported.lorebook?.name).toBe("Bob's World");
  });

  it("prefers the ccv3 chunk over chara", async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#000000" },
    })
      .png()
      .toBuffer();
    const chunks = extractPngChunks(png);
    chunks.splice(
      -1,
      0,
      PNGtext.encode("chara", Buffer.from(JSON.stringify(V1_CARD)).toString("base64")),
      PNGtext.encode("ccv3", Buffer.from(JSON.stringify(V3_CARD)).toString("base64")),
    );
    const { character } = await importCardFromPng(encodePngChunks(chunks), repos, {
      blobDir: BLOB_DIR,
    });
    expect(character.name).toBe("Vera");
  });

  it("exports a placeholder PNG when no source image exists", async () => {
    const { character } = await importCardFromJson(V1_CARD, repos);
    const exported = await exportCardPng(character);
    const { character: reimported } = await importCardFromPng(exported, repos, {
      blobDir: BLOB_DIR,
      onConflict: "replace",
    });
    expect(reimported.name).toBe("Alice");
    expect(reimported.description).toBe("A test character.");
  });

  it("exports native JSON with card_raw inline", async () => {
    const { character } = await importCardFromJson(V2_CARD, repos);
    const json = exportCardJson(character);
    expect(json.name).toBe("Bob");
    expect(json.card_raw).toEqual(V2_CARD);
  });
});
