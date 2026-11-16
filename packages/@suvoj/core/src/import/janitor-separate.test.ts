/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  extractCard,
  extractCharName,
  extractExample,
  extractFirstMessage,
  extractScenario,
  getSystemContent,
  separate,
  splitEntries,
} from "./janitor-separate";

const PUBLIC_ENTRY = "The silver key opens the hidden vault beneath the old chapel.";
const CLOSED_ENTRY = "The closed entry: a secret ritual happens at midnight.";

/** A synthetic JanitorAI `generateAlpha` payload with every wrapper present. */
function systemContent(): string {
  return [
    "[System: You are a helpful assistant. Stay in character at all times.]",
    "<Hanako's Persona>",
    "Hanako is a 26-year-old office worker.",
    "She has long black hair.",
    "</Hanako's Persona>",
    "<UserPersona>",
    "The user is {{user}}.",
    "</UserPersona>",
    "<Scenario>",
    "You and Hanako swapped bodies overnight.",
    "</Scenario>",
    "<Example dialogues>",
    "{{user}}: Good morning.",
    "{{char}}: Morning, sleepyhead.",
    "</Example dialogues>",
    PUBLIC_ENTRY,
    "",
    CLOSED_ENTRY,
  ].join("\n");
}

function payload() {
  return {
    messages: [
      { role: "system", content: systemContent() },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "  *She waves.*  " },
    ],
  };
}

describe("getSystemContent", () => {
  it("returns the system message content", () => {
    expect(getSystemContent(payload())).toBe(systemContent());
  });

  it("returns an empty string when absent or malformed", () => {
    expect(getSystemContent({ messages: [] })).toBe("");
    expect(getSystemContent({ messages: [{ role: "user", content: "x" }] })).toBe("");
    expect(getSystemContent(null)).toBe("");
    expect(getSystemContent({ messages: "nope" })).toBe("");
    expect(getSystemContent("garbage")).toBe("");
  });
});

describe("separate", () => {
  it("keeps only the closed-lorebook block, stripping wrappers and public entries", () => {
    const result = separate(payload(), "", [PUBLIC_ENTRY]);
    expect(result.lorebookText).toBe(CLOSED_ENTRY);
    expect(result.entries).toEqual([CLOSED_ENTRY]);
    expect(result.removed.map((entry) => entry.label)).toEqual([
      "jailbreak",
      "card",
      "userPersona",
      "scenario",
      "example",
      "publicLorebook",
    ]);
    expect(result.systemContent).toBe(systemContent());
  });

  it("leaves public entries in place when publicContents is not supplied", () => {
    const result = separate(payload());
    expect(result.lorebookText).toBe(`${PUBLIC_ENTRY}\n\n${CLOSED_ENTRY}`);
    expect(result.entries).toEqual([PUBLIC_ENTRY, CLOSED_ENTRY]);
  });

  it("removes a public entry across whitespace/glyph differences", () => {
    const content = "Intro.\nThe silver\nkey opens the hidden vault.\nKept entry.";
    const result = separate({ messages: [{ role: "system", content }] }, "", [
      "The silver key opens the hidden vault.",
    ]);
    expect(result.lorebookText).toBe("Intro.\n\nKept entry.");
  });

  it("subtracts a known card's lines", () => {
    const content = "The card line that should vanish.\nThe kept line.";
    const result = separate({ messages: [{ role: "system", content }] }, content.split("\n")[0]);
    expect(result.lorebookText).toBe("The kept line.");
    expect(result.removed.map((entry) => entry.label)).toContain("knownCard");
  });

  it("tolerates malformed payloads", () => {
    expect(separate(null)).toEqual({
      systemContent: "",
      lorebookText: "",
      removed: [],
      entries: [],
    });
  });
});

describe("splitEntries", () => {
  it("splits on blank lines and drops blanks", () => {
    expect(splitEntries("a\n\nb\n\n\nc")).toEqual(["a", "b", "c"]);
    expect(splitEntries("   \n\n   ")).toEqual([]);
    expect(splitEntries("")).toEqual([]);
  });
});

describe("extract*", () => {
  it("extracts the card, name, scenario, example and first message", () => {
    const captured = payload();
    expect(extractCard(captured)).toBe(
      "Hanako is a 26-year-old office worker.\nShe has long black hair.",
    );
    expect(extractCharName(captured)).toBe("Hanako");
    expect(extractScenario(captured)).toBe("You and Hanako swapped bodies overnight.");
    expect(extractExample(captured)).toBe(
      "{{user}}: Good morning.\n{{char}}: Morning, sleepyhead.",
    );
    expect(extractFirstMessage(captured)).toBe("*She waves.*");
  });

  it("returns empty strings when the wrappers are absent", () => {
    const bare = { messages: [{ role: "system", content: "Nothing to see here." }] };
    expect(extractCard(bare)).toBe("");
    expect(extractCharName(bare)).toBe("");
    expect(extractScenario(bare)).toBe("");
    expect(extractExample(bare)).toBe("");
    expect(extractFirstMessage(bare)).toBe("");
  });

  it("skips a leading <UserPersona> block when extracting the card and name", () => {
    const onlyUser = {
      messages: [{ role: "system", content: "<UserPersona>\nI am the user.\n</UserPersona>" }],
    };
    expect(extractCard(onlyUser)).toBe("");
    expect(extractCharName(onlyUser)).toBe("");
  });
});
