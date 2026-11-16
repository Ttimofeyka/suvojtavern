/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { PresetPrompt } from "./api-presets";
import { prefixWarningText, volatileMacrosIn, volatilePrefixBlocks } from "./preset-cache";

/**
 * The editor's prefix-cache diagnosis is app copy backed by a mirrored list,
 * while the real classification lives in the engine. The cross-package
 * relative import is deliberate (as in `macro-guide.test.ts`): the web package
 * has no runtime dependency on `@suvoj/core`, but the suite must still fail
 * when the engine's notion of "volatile" moves.
 */

const ENGINE_MACROS = new URL("../../../@suvoj/core/src/engine/macros.ts", import.meta.url);

/** The engine's exported `VOLATILE_MACRO_NAMES`, read from its source. */
async function engineVolatileNames(): Promise<string[]> {
  const source = await Bun.file(ENGINE_MACROS).text();
  const block = /export const VOLATILE_MACRO_NAMES[^=]*=\s*\[([\s\S]*?)\]/.exec(source);
  const body = block?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "").sort();
}

/** A preset row with the fields the diagnosis reads. */
function row(overrides: Partial<PresetPrompt> = {}): PresetPrompt {
  return {
    id: "row",
    name: "Row",
    role: "system",
    content: "",
    enabled: true,
    injection_position: 0,
    injection_depth: 4,
    injection_order: 100,
    ...overrides,
  };
}

describe("volatileMacrosIn", () => {
  it("finds clock, idle, last-message, and RNG macros", () => {
    expect(volatileMacrosIn("at {{time}} on {{date}}")).toEqual(["time", "date"]);
    expect(volatileMacrosIn("{{idle_duration}} since {{lastMessage}}")).toEqual([
      "idle_duration",
      "lastmessage",
    ]);
  });

  it("matches names case-insensitively, like the engine", () => {
    expect(volatileMacrosIn("{{TIME}}")).toEqual(["time"]);
  });

  it("deduplicates repeats in first-appearance order", () => {
    expect(volatileMacrosIn("{{date}} {{time}} {{date}}")).toEqual(["date", "time"]);
  });

  it("does not treat {{pick}} as volatile — it is seeded, not random", () => {
    expect(volatileMacrosIn("{{pick:a,b,c}}")).toEqual([]);
  });

  it("ignores stable and unknown macros", () => {
    expect(volatileMacrosIn("{{char}} and {{user}} and {{nonsense}}")).toEqual([]);
  });

  it("reads the macro name before any arguments", () => {
    expect(volatileMacrosIn("{{roll:1d20}}")).toEqual(["roll"]);
  });
});

describe("volatilePrefixBlocks", () => {
  it("flags only rows before the chat history", () => {
    const blocks = volatilePrefixBlocks([
      row({ id: "main", marker: "main", content: "It is {{time}}." }),
      row({ id: "history", marker: "chatHistory" }),
      row({ id: "late", content: "It is {{time}}." }),
    ]);
    expect(blocks.map((block) => block.promptId)).toEqual(["main"]);
  });

  it("skips disabled rows", () => {
    const blocks = volatilePrefixBlocks([
      row({ id: "off", enabled: false, content: "{{time}}" }),
      row({ id: "history", marker: "chatHistory" }),
    ]);
    expect(blocks).toEqual([]);
  });

  it("skips depth injections, which render inside the live window", () => {
    const blocks = volatilePrefixBlocks([
      row({ id: "deep", injection_position: 1, content: "{{time}}" }),
      row({ id: "history", marker: "chatHistory" }),
    ]);
    expect(blocks).toEqual([]);
  });

  it("skips data-rendering markers, which own no text", () => {
    const blocks = volatilePrefixBlocks([
      row({ id: "desc", marker: "charDescription", content: "{{time}}" }),
      row({ id: "history", marker: "chatHistory" }),
    ]);
    expect(blocks).toEqual([]);
  });

  it("flags a volatile jailbreak when it renders before the history", () => {
    const blocks = volatilePrefixBlocks([
      row({ id: "jail", marker: "jailbreak", content: "{{weekday}}" }),
      row({ id: "history", marker: "chatHistory" }),
    ]);
    expect(blocks.map((block) => block.promptId)).toEqual(["jail"]);
  });

  it("does not flag the summary or tracker blocks — they render after the live window", () => {
    // Those blocks are not preset rows at all; a clean prefix must stay clean.
    const blocks = volatilePrefixBlocks([
      row({ id: "main", marker: "main", content: "{{char}} greets {{user}}." }),
      row({ id: "history", marker: "chatHistory" }),
      row({ id: "jail", marker: "jailbreak", content: "Stay in character." }),
    ]);
    expect(blocks).toEqual([]);
  });

  it("scans every row when no chat history slot exists", () => {
    const blocks = volatilePrefixBlocks([row({ id: "late", content: "{{time}}" })]);
    expect(blocks.map((block) => block.promptId)).toEqual(["late"]);
  });

  it("falls back to a readable label for a nameless row", () => {
    const blocks = volatilePrefixBlocks([
      row({ id: "blank", name: "  ", content: "{{time}}" }),
      row({ id: "history", marker: "chatHistory" }),
    ]);
    expect(blocks[0]?.label).toBe("unnamed prompt");
  });
});

describe("the mirrored volatile list", () => {
  it("matches the engine's VOLATILE_MACRO_NAMES exactly", async () => {
    const engine = await engineVolatileNames();
    // Guard the extraction: a broken regex would otherwise compare empty to
    // empty and pass while the lists drifted.
    expect(engine.length).toBeGreaterThan(0);
    const { VOLATILE_MACROS } = await import("./preset-cache");
    expect([...VOLATILE_MACROS].sort()).toEqual(engine);
  });
});

describe("prefixWarningText", () => {
  it("names the macros and the fix", () => {
    const text = prefixWarningText(["time", "date"]);
    expect(text).toContain("{{time}}, {{date}}");
    expect(text).toContain("before the chat history");
    expect(text).toContain("cache");
  });
});
