/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { ChubSource } from "./chub";
import { chubApiUrl, chubCardFromResponse, parseChubSource } from "./chub";

describe("parseChubSource", () => {
  it("accepts every chub host, trailing slashes, query strings and bare ids", () => {
    const expected: ChubSource = {
      kind: "ref",
      ref: { creator: "creator-alpha", project: "project-one" },
    };
    for (const input of [
      "https://chub.ai/characters/creator-alpha/project-one",
      "https://www.chub.ai/characters/creator-alpha/project-one",
      "https://venus.chub.ai/characters/creator-alpha/project-one",
      "https://characterhub.org/characters/creator-alpha/project-one",
      "https://www.characterhub.org/characters/creator-alpha/project-one",
      "http://chub.ai/characters/creator-alpha/project-one",
      "https://chub.ai/characters/creator-alpha/project-one/",
      "https://chub.ai/characters/creator-alpha/project-one?tab=comments",
      "CHUB.AI/characters/creator-alpha/project-one", // no scheme, upper-case
      "creator-alpha/project-one", // bare id
    ]) {
      expect(parseChubSource(input)).toEqual(expected);
    }
  });

  it("rejects chub lorebook URLs explicitly", () => {
    expect(parseChubSource("https://chub.ai/lorebooks/creator-alpha/some-book")).toEqual({
      kind: "error",
      message: "chub lorebook import is not supported yet",
    });
    expect(parseChubSource("https://venus.chub.ai/lorebooks/creator-alpha/some-book")).toEqual({
      kind: "error",
      message: "chub lorebook import is not supported yet",
    });
  });

  it("rejects malformed chub character URLs", () => {
    expect(parseChubSource("https://chub.ai/characters/only-a-creator")).toMatchObject({
      kind: "error",
    });
    expect(parseChubSource("https://chub.ai/characters/a/b/c")).toMatchObject({ kind: "error" });
    expect(parseChubSource("https://venus.chub.ai/characters/a/b/c/d")).toMatchObject({
      kind: "error",
    });
    expect(parseChubSource("https://chub.ai/profiles/creator-alpha")).toMatchObject({
      kind: "error",
    });
  });

  it("classifies non-chub and garbage input as other", () => {
    for (const input of [
      "https://example.com/card.png",
      "https://example.com/characters/a/b", // right path, wrong host
      "ftp://chub.ai/characters/a/b", // chub host but not http(s)
      "a/b/c", // three segments — neither a URL nor a bare id
      "just some text",
      "creator-alpha/", // one segment
      "",
    ]) {
      expect(parseChubSource(input)).toEqual({ kind: "other" });
    }
  });

  it("builds the chub API metadata URL", () => {
    expect(chubApiUrl({ creator: "creator-alpha", project: "project-one" })).toBe(
      "https://api.chub.ai/api/characters/creator-alpha/project-one?full=true",
    );
  });

  it("URL-encodes slugs that need it", () => {
    // A slug with spaces / reserved characters must not corrupt the
    // path or leak into the query string.
    expect(chubApiUrl({ creator: "creator alpha", project: "proj&ect?one" })).toBe(
      "https://api.chub.ai/api/characters/creator%20alpha/proj%26ect%3Fone?full=true",
    );
  });
});

describe("chubCardFromResponse", () => {
  const NODE = {
    max_res_url: "https://cdn.chub.ai/avatars/full.png",
    topics: ["Female", "Elf"],
    definition: {
      name: "Sylvie",
      personality: "A cheerful elf.",
      tavern_personality: "cheerful",
      scenario: "A forest clearing.",
      first_message: "Hello, traveler!",
      example_dialogs: "<START>\n{{user}}: Hi",
      description: "Made for testing.",
      system_prompt: "Be Sylvie.",
      post_history_instructions: "Stay in character.",
      alternate_greetings: ["Hi!", "Hey!"],
      embedded_lorebook: { name: "Forest", entries: [] },
      extensions: { depth_prompt: { prompt: "", depth: 4 } },
    },
  };

  it("maps a chub node onto a V2 card with SillyTavern field parity", () => {
    expect(chubCardFromResponse({ node: NODE }, "creator-alpha")).toEqual({
      card: {
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: "Sylvie",
          description: "A cheerful elf.", // chub "personality" → card description
          personality: "cheerful",
          scenario: "A forest clearing.",
          first_mes: "Hello, traveler!",
          mes_example: "<START>\n{{user}}: Hi",
          creator_notes: "Made for testing.", // chub "description" → creator notes
          system_prompt: "Be Sylvie.",
          post_history_instructions: "Stay in character.",
          alternate_greetings: ["Hi!", "Hey!"],
          tags: ["Female", "Elf"],
          creator: "creator-alpha",
          character_version: "",
          extensions: NODE.definition.extensions,
          character_book: NODE.definition.embedded_lorebook,
        },
      },
      avatarUrl: "https://cdn.chub.ai/avatars/full.png",
    });
  });

  it("tolerates missing definition fields and non-string topics", () => {
    expect(
      chubCardFromResponse(
        { node: { topics: ["Elf", 42], max_res_url: null, definition: { name: "Bare" } } },
        "creator-alpha",
      ),
    ).toEqual({
      card: {
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: "Bare",
          description: "",
          personality: "",
          scenario: "",
          first_mes: "",
          mes_example: "",
          creator_notes: "",
          system_prompt: "",
          post_history_instructions: "",
          alternate_greetings: [],
          tags: ["Elf"],
          creator: "creator-alpha",
          character_version: "",
          extensions: {},
        },
      },
      avatarUrl: null,
    });
  });

  it("drops a non-object embedded_lorebook and returns null without a node", () => {
    const withBadBook = chubCardFromResponse(
      { node: { definition: { name: "X", embedded_lorebook: "nope" } } },
      "creator-alpha",
    );
    expect(withBadBook?.card.data).not.toHaveProperty("character_book");

    expect(chubCardFromResponse({}, "creator-alpha")).toBeNull();
    expect(chubCardFromResponse({ node: null }, "creator-alpha")).toBeNull();
    expect(chubCardFromResponse(null, "creator-alpha")).toBeNull();
    expect(chubCardFromResponse("nope", "creator-alpha")).toBeNull();
  });
});
