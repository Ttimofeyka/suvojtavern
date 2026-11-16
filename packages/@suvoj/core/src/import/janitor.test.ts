/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { JanitorSource } from "./janitor";
import {
  htmlToText,
  janitorAvatarUrl,
  janitorCardFromMetadata,
  janitorCharacterApiUrl,
  janitorIsCardPublic,
  janitorLorebooks,
  janitorScriptApiUrl,
  janitorScriptEntries,
  parseJanitorSource,
  parseScriptPublishedContent,
} from "./janitor";

const ID = "64a0c863-506c-4191-82f6-9296c329152b";

describe("parseJanitorSource", () => {
  it("accepts janitor hosts, slugs, trailing slashes and query/hash", () => {
    const expected: JanitorSource = { kind: "ref", ref: { id: ID, slug: "office-lady" } };
    for (const input of [
      `https://janitorai.com/characters/${ID}_office-lady`,
      `https://www.janitorai.com/characters/${ID}_office-lady`,
      `http://janitorai.com/characters/${ID}_office-lady/`,
      `https://janitorai.com/characters/${ID}_office-lady?tab=comments`,
      `https://janitorai.com/characters/${ID}_office-lady#reviews`,
      `JANITORAI.COM/characters/${ID}_office-lady`, // scheme-less, upper-case host
    ]) {
      expect(parseJanitorSource(input)).toEqual(expected);
    }
  });

  it("accepts a slugless character URL", () => {
    expect(parseJanitorSource(`https://janitorai.com/characters/${ID}`)).toEqual({
      kind: "ref",
      ref: { id: ID, slug: null },
    });
    // A trailing underscore is an empty slug, not a slug.
    expect(parseJanitorSource(`https://janitorai.com/characters/${ID}_`)).toEqual({
      kind: "ref",
      ref: { id: ID, slug: null },
    });
  });

  it("accepts a scheme-less host path", () => {
    expect(parseJanitorSource(`janitorai.com/characters/${ID}_office-lady`)).toEqual({
      kind: "ref",
      ref: { id: ID, slug: "office-lady" },
    });
  });

  it("accepts a bare UUID (case-insensitive, trimmed)", () => {
    expect(parseJanitorSource(ID)).toEqual({ kind: "ref", ref: { id: ID, slug: null } });
    const upper = ID.toUpperCase();
    expect(parseJanitorSource(`  ${upper}  `)).toEqual({
      kind: "ref",
      ref: { id: upper, slug: null },
    });
  });

  it("rejects janitor non-character paths", () => {
    expect(parseJanitorSource("https://janitorai.com/scripts/123")).toEqual({
      kind: "error",
      message: "not a janitorai.com character URL",
    });
    expect(parseJanitorSource("https://janitorai.com/profile/someone")).toMatchObject({
      kind: "error",
    });
  });

  it("rejects malformed janitor character URLs", () => {
    expect(parseJanitorSource("https://janitorai.com/characters/not-a-uuid")).toMatchObject({
      kind: "error",
    });
    expect(parseJanitorSource(`https://janitorai.com/characters/${ID}_slug/extra`)).toMatchObject({
      kind: "error",
    });
    expect(parseJanitorSource("https://janitorai.com/characters/")).toMatchObject({
      kind: "error",
    });
  });

  it("classifies non-janitor and garbage input as other", () => {
    for (const input of [
      `https://example.com/characters/${ID}`, // right path, wrong host
      "https://chub.ai/characters/a/b",
      `ftp://janitorai.com/characters/${ID}`, // janitor host but not http(s)
      "just some text",
      "64a0c863-506c-4191", // partial uuid
      "",
    ]) {
      expect(parseJanitorSource(input)).toEqual({ kind: "other" });
    }
  });

  it("builds the character, script and avatar URLs", () => {
    expect(janitorCharacterApiUrl(ID)).toBe(`https://janitorai.com/hampter/characters/${ID}`);
    expect(janitorScriptApiUrl("123")).toBe("https://janitorai.com/hampter/script/123");
    expect(janitorAvatarUrl("a b/c.webp")).toBe(
      "https://ella.janitorai.com/bot-avatars/a%20b%2Fc.webp?width=1200",
    );
  });
});

describe("htmlToText", () => {
  it("flattens block tags, strips tags and decodes entities", () => {
    expect(htmlToText("<p>a<br>b</p><p>c&nbsp;&amp;&nbsp;d</p>")).toBe("a\nb\nc & d");
  });

  it("decodes quote/apostrophe entities and collapses whitespace", () => {
    expect(htmlToText("<div>He said &quot;hi&quot; &amp; &#39;bye&#39;</div>")).toBe(
      "He said \"hi\" & 'bye'",
    );
  });

  it("returns an empty string for empty/absent input", () => {
    expect(htmlToText("")).toBe("");
  });
});

describe("janitorCardFromMetadata", () => {
  // Real (trimmed) /hampter/characters response for a public card.
  const META = {
    id: ID,
    name: "Office Lady Body Swap",
    avatar: "1WaUd696eR02PtnJXdUin.webp",
    creator_name: "icyicecold",
    custom_tags: ["bodyswap", "tftg", "transformation"],
    description: "<p><strong>Here's some background:</strong> You were chosen</p><p></p>",
    personality: "Before swapping bodies with {{user}}, Hanako was a 26-year-old.",
    scenario: "{{user}} have been selected.",
    first_message: null,
    first_messages: ["*Hanako's alarm clock woke you up at 8 am.*", "*Alt greeting.*"],
    example_dialogs: "",
    showdefinition: true,
    scripts: [{ id: 123, type: "lorebook", title: "Sex play", is_public: true }],
  };

  it("maps a public character onto a V2 card exactly", () => {
    const result = janitorCardFromMetadata(META);
    expect(result).not.toBeNull();
    const data = result?.card.data as Record<string, unknown>;
    expect(result?.card.spec).toBe("chara_card_v2");
    expect(result?.card.spec_version).toBe("2.0");
    expect(data.name).toBe("Office Lady Body Swap");
    expect(data.description).toBe(META.personality);
    expect(data.personality).toBe("");
    expect(data.scenario).toBe("{{user}} have been selected.");
    expect(data.first_mes).toBe("*Hanako's alarm clock woke you up at 8 am.*");
    expect(data.alternate_greetings).toEqual(["*Alt greeting.*"]);
    expect(data.mes_example).toBe("");
    expect(data.creator_notes).toBe("Here's some background: You were chosen");
    expect(data.creator_notes).not.toContain("<");
    expect(data.creator_notes).not.toContain("&");
    expect(data.system_prompt).toBe("");
    expect(data.post_history_instructions).toBe("");
    expect(data.tags).toEqual(["bodyswap", "tftg", "transformation"]);
    expect(data.creator).toBe("icyicecold");
    expect(result?.avatarFile).toBe("1WaUd696eR02PtnJXdUin.webp");
    expect(result?.lorebooks).toEqual([{ id: "123", title: "Sex play", isPublic: true }]);
  });

  it("de-duplicates greetings preserving order", () => {
    const result = janitorCardFromMetadata({
      name: "Dup",
      first_messages: ["Hi", "Hi", "Bye"],
      first_message: "Hi",
      alternate_greetings: ["Bye", "Later"],
    });
    const data = result?.card.data as Record<string, unknown>;
    expect(data.first_mes).toBe("Hi");
    expect(data.alternate_greetings).toEqual(["Bye", "Later"]);
  });

  it("returns null without a usable name", () => {
    expect(janitorCardFromMetadata({ personality: "x" })).toBeNull();
    expect(janitorCardFromMetadata({ name: "   " })).toBeNull();
    expect(janitorCardFromMetadata(null)).toBeNull();
    expect(janitorCardFromMetadata("nope")).toBeNull();
  });

  it("falls back to raw_avatar and defaults greetings to empty", () => {
    const result = janitorCardFromMetadata({ name: "NoGreeting", raw_avatar: "raw.webp" });
    const data = result?.card.data as Record<string, unknown>;
    expect(data.first_mes).toBe("");
    expect(data.alternate_greetings).toEqual([]);
    expect(result?.avatarFile).toBe("raw.webp");
  });
});

describe("janitorLorebooks", () => {
  it("keeps only lorebook/advanced scripts with an id", () => {
    expect(
      janitorLorebooks({
        scripts: [
          { id: 1, type: "lorebook", title: "A", is_public: true },
          { id: 2, type: "advanced", title: "B" },
          { id: 3, type: "other", title: "C" },
          { type: "lorebook", title: "no id" },
          { id: 4, type: "lorebook", title: "D", is_public: false },
        ],
      }),
    ).toEqual([
      { id: "1", title: "A", isPublic: true },
      { id: "2", title: "B", isPublic: true },
      { id: "4", title: "D", isPublic: false },
    ]);
  });

  it("returns [] for missing or malformed scripts", () => {
    expect(janitorLorebooks(null)).toEqual([]);
    expect(janitorLorebooks({})).toEqual([]);
    expect(janitorLorebooks({ scripts: "nope" })).toEqual([]);
  });
});

describe("janitorIsCardPublic", () => {
  it("requires showdefinition and a non-empty field", () => {
    expect(janitorIsCardPublic({ showdefinition: true, personality: "x" })).toBe(true);
    expect(janitorIsCardPublic({ showdefinition: true, scenario: "x" })).toBe(true);
    expect(janitorIsCardPublic({ showdefinition: true, personality: "  " })).toBe(false);
    expect(janitorIsCardPublic({ personality: "x" })).toBe(false);
    expect(janitorIsCardPublic(null)).toBe(false);
  });
});

describe("parseScriptPublishedContent", () => {
  /** Wrap `value` the way JanitorAI embeds its store in the page. */
  function embed(value: unknown): string {
    return `<script>window.mbxM.push(JSON.parse(${JSON.stringify(JSON.stringify(value))}))</script>`;
  }

  it("double-decodes the published content out of the page store", () => {
    const html = embed({ script: { scriptPublishedContent: { content: "  Real description  " } } });
    expect(parseScriptPublishedContent(html)).toBe("  Real description  ");
  });

  it("falls back to the embedded script.description", () => {
    const html = embed({ script: { script: { description: "Fallback" } } });
    expect(parseScriptPublishedContent(html)).toBe("Fallback");
  });

  it("returns an empty string for absent/malformed/empty content", () => {
    expect(parseScriptPublishedContent("")).toBe("");
    expect(parseScriptPublishedContent("<html>no store</html>")).toBe("");
    expect(parseScriptPublishedContent('window.mbxM.push(JSON.parse("not json"))')).toBe("");
    expect(
      parseScriptPublishedContent(embed({ script: { scriptPublishedContent: { content: "  " } } })),
    ).toBe("");
  });
});

describe("janitorScriptEntries", () => {
  it("maps a native entries array through the ST entry bridge", () => {
    const result = janitorScriptEntries({
      id: 7,
      title: "Sex play",
      description: "A public book",
      is_code_public: true,
      script: [
        {
          key: ["dragon"],
          content: "A dragon guards the hoard.",
          insertion_order: 50,
          constant: true,
          enabled: true,
          probability: 1,
          name: "Dragon",
        },
        {
          key: "elf, elven",
          content: "An elf lives here.",
          order: 5,
          enabled: false,
          probability: 0.5,
          position: 1,
          depth: 2,
        },
      ],
    });
    expect(result.isJs).toBe(false);
    expect(result.scriptSource).toBe("");
    expect(result.title).toBe("Sex play");
    expect(result.description).toBe("A public book");
    expect(result.isCodePublic).toBe(true);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({
      keys: ["dragon"],
      content: "A dragon guards the hoard.",
      comment: "Dragon",
      constant: true,
      selective: false,
      order: 50,
      probability: 100,
      enabled: true,
    });
    expect(result.entries[1]).toMatchObject({
      keys: ["elf", "elven"],
      content: "An elf lives here.",
      comment: "Entry 1",
      constant: false,
      selective: true,
      order: 5,
      position: 1,
      depth: 2,
      probability: 50,
      enabled: false,
    });
  });

  it("accepts a numeric-string probability (JAR's loose <= 1 comparison)", () => {
    const result = janitorScriptEntries({
      script: [
        { key: "a", content: "fraction", probability: "0.5" },
        { key: "b", content: "whole", probability: "50" },
        { key: "c", content: "junk", probability: "abc" },
      ],
    });
    expect(result.entries.map((entry) => entry.probability)).toEqual([50, 50, 100]);
  });

  it("parses a JSON-string script", () => {
    const result = janitorScriptEntries({
      script: JSON.stringify([{ key: "k", content: "v" }]),
    });
    expect(result.isJs).toBe(false);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ keys: ["k"], content: "v" });
  });

  it("treats non-JSON source as a JS script", () => {
    const source = "function onMessage(ctx) { return true; }";
    const result = janitorScriptEntries({ script: source, title: "Nine" });
    expect(result.isJs).toBe(true);
    expect(result.scriptSource).toBe(source);
    expect(result.entries).toEqual([]);
  });

  it("treats a JSON non-array string as a JS script", () => {
    const result = janitorScriptEntries({ script: '{"not":"entries"}' });
    expect(result.isJs).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it("returns an empty result for missing/malformed scripts and never throws", () => {
    for (const record of [null, {}, { script: null }, { script: 42 }, { script: "   " }]) {
      expect(janitorScriptEntries(record)).toEqual({
        entries: [],
        isJs: false,
        scriptSource: "",
        title: "",
        description: "",
        isCodePublic: false,
      });
    }
  });
});
