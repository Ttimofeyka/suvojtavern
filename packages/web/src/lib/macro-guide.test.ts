/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import type { MacroContext } from "../../../@suvoj/core/src/engine/macros";
import { evaluateMacros } from "../../../@suvoj/core/src/engine/macros";
import { filterMacroSections, MACRO_SECTIONS } from "./macro-guide";

/**
 * The guide is app copy, but its accuracy is a contract: it must document every
 * macro the engine supports and nothing more. The suite below imports the REAL
 * engine (the cross-package relative path is deliberate — the web package has
 * no runtime dependency on `@suvoj/core`) and drives it, so the guide cannot
 * silently drift when a macro is added or removed.
 */

/** Fixed clock so the date/time macros are deterministic across runs. */
const NOW = new Date(2026, 8, 4, 15, 45); // September 4, 2026 15:45 local

/** The macros that render the empty string by design — setvar/addvar store
 *  silently, trim/noop/comment remove themselves. The verbatim check below
 *  must not mistake "recognised and removed" for "unknown and left alone". */
const REMOVES_ITSELF = new Set(["setvar", "addvar", "trim", "noop", "//"]);

/** Minimal in-memory stand-in for VariablesRepository (the engine only reads
 *  `get`/`set`), so the suite stays hermetic — no DB, no fixtures. */
function memoryVars(): MacroContext["vars"] {
  const store = new Map<string, unknown>();
  return {
    get: (_scope: string, _scopeId: string | null, key: string) =>
      store.has(key) ? store.get(key) : null,
    set: (_scope: string, _scopeId: string | null, key: string, value: unknown) => {
      store.set(key, value);
    },
  } as unknown as MacroContext["vars"];
}

/** A fully populated context: every optional input is set so each syntax has
 *  something real to resolve against. */
function fullContext(vars: MacroContext["vars"]): MacroContext {
  return {
    char: "Aria",
    user: "Kai",
    persona: "A curious explorer.",
    chatId: "chat-1",
    vars,
    rng: () => 0.42,
    now: NOW,
    lastMessage: "Let's go.",
    lastMessageAt: new Date(2026, 8, 4, 15, 42),
    ui: { style: "descriptive" },
  };
}

/** The engine's recognised macro names, derived from its SOURCE at test time.
 *  Reading the file is deliberate: a hardcoded list here would only pin the
 *  guide against itself, so a macro added to the engine could ship
 *  undocumented and this suite would stay green. */
async function engineMacroNames(): Promise<string[]> {
  const path = new URL("../../../@suvoj/core/src/engine/macros.ts", import.meta.url);
  const source = await Bun.file(path).text();
  const cases = [...source.matchAll(/^\s*case "([^"]+)":/gm)].map((match) => match[1] ?? "");
  // The comment form is handled before the switch by an if-branch, not a case.
  const comment = /body\.startsWith\("\/\/"\)/.test(source) ? ["//"] : [];
  return [...new Set([...cases, ...comment])].sort();
}

/** Every supported macro name, lowercase without braces. The comment form is
 *  spelled "//". Kept as an explicit list so a failure reads as a diff — but it
 *  documents INTENT; engineMacroNames() above is what actually holds the guide
 *  to the engine. */
const SUPPORTED_MACRO_NAMES = [
  "//",
  "addvar",
  "char",
  "date",
  "decvar",
  "getvar",
  "idle_duration",
  "incvar",
  "isodate",
  "isotime",
  "lastmessage",
  "newline",
  "noop",
  "persona",
  "pick",
  "random",
  "roll",
  "setvar",
  "time",
  "trim",
  "ui",
  "user",
  "weekday",
].sort();

/** Names every engine must have. Guards the source extraction: if a refactor
 *  stops the regex matching, the derived set would be empty and would compare
 *  "equal" to a likewise-broken side instead of failing loudly. */
const WELL_KNOWN_MACROS = ["char", "user", "roll", "setvar", "ui"];

describe("MACRO_SECTIONS", () => {
  it("documents exactly the macros the engine supports", async () => {
    const engine = await engineMacroNames();
    // Guard the extraction itself before trusting it to compare anything.
    expect(
      engine.length,
      "engine source yielded no macro names — extraction broke",
    ).toBeGreaterThan(0);
    for (const name of WELL_KNOWN_MACROS) {
      expect(engine, `engine extraction missed the well-known macro "${name}"`).toContain(name);
    }

    const documented = [
      ...new Set(MACRO_SECTIONS.flatMap((section) => section.entries.map((entry) => entry.name))),
    ].sort();

    // Two assertions so a failure says WHICH side moved: the guide must match
    // the engine, and the engine must still match the documented intent list.
    expect(documented).toEqual(engine);
    expect(engine).toEqual(SUPPORTED_MACRO_NAMES);
  });

  it("gives every documented syntax a working, recognised literal", () => {
    // One shared store, evaluated in section order: the variables section puts
    // setvar before the reads that depend on it, exactly as a card author would.
    const vars = memoryVars();
    const ctx = fullContext(vars);
    for (const section of MACRO_SECTIONS) {
      for (const entry of section.entries) {
        const output = evaluateMacros(entry.syntax, ctx);
        if (REMOVES_ITSELF.has(entry.name)) {
          expect(output, `${entry.name} should render nothing`).toBe("");
        } else {
          expect(output, `${entry.name} was left verbatim — engine did not recognise it`).not.toBe(
            entry.syntax,
          );
        }
      }
    }
  });
});

describe("filterMacroSections", () => {
  it("returns every section for an empty query", () => {
    expect(filterMacroSections("")).toBe(MACRO_SECTIONS);
    expect(filterMacroSections("   ")).toBe(MACRO_SECTIONS);
  });

  it("keeps only matching sections and drops the empty ones", () => {
    const result = filterMacroSections("random");
    expect(result.map((section) => section.id)).toEqual(["random"]);
  });

  it("narrows entries within a surviving section", () => {
    const result = filterMacroSections("idle_duration");
    expect(result).toHaveLength(1);
    expect(result[0]?.entries.map((entry) => entry.name)).toEqual(["idle_duration"]);
  });

  it("matches case-insensitively", () => {
    expect(filterMacroSections("RANDOM").map((section) => section.id)).toEqual(
      filterMacroSections("random").map((section) => section.id),
    );
  });

  it("returns [] for a query that matches nothing", () => {
    expect(filterMacroSections("no-such-macro-anywhere")).toEqual([]);
  });
});
