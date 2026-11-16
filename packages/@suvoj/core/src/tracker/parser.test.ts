/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { parseTrackerResponse } from "./parser";

describe("parseTrackerResponse", () => {
  it("parses a clean fenced json block", () => {
    const raw = '```json\n{"time": "10:00:00", "weather": "clear"}\n```';
    expect(parseTrackerResponse(raw)).toEqual({ time: "10:00:00", weather: "clear" });
  });

  it("accepts case-insensitive and bare fence language tags", () => {
    expect(parseTrackerResponse('```JSON\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseTrackerResponse('```\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("parses an unfenced json object", () => {
    expect(parseTrackerResponse('{"a": "b"}')).toEqual({ a: "b" });
  });

  it("ignores text around the fenced block", () => {
    const raw = 'Here you go:\n\n```json\n{"a": 1}\n```\n\nHope that helps!';
    expect(parseTrackerResponse(raw)).toEqual({ a: 1 });
  });

  it("extracts the balanced object from surrounding prose without a fence", () => {
    const raw = 'Sure thing! {"time": "1", "braces": "in } string { ok"} done.';
    expect(parseTrackerResponse(raw)).toEqual({ time: "1", braces: "in } string { ok" });
  });

  it("repairs trailing commas (objects and arrays)", () => {
    expect(parseTrackerResponse('{"a": 1, "b": [1, 2,],}')).toEqual({ a: 1, b: [1, 2] });
    expect(
      parseTrackerResponse('```json\n{\n  "characters": [\n    {"name": "A"},\n  ],\n}\n```'),
    ).toEqual({ characters: [{ name: "A" }] });
  });

  it("quotes bare string values (the `Lisbon` drift)", () => {
    const raw = `\`\`\`json
{
  "location": "Lisbon",
  "characters": [
    {
      "name": Lisbon,
      "pronouns": she/her
    }
  ],
  "knownCast": [Mira, Kael]
}
\`\`\``;
    expect(parseTrackerResponse(raw)).toEqual({
      location: "Lisbon",
      characters: [{ name: "Lisbon", pronouns: "she/her" }],
      knownCast: ["Mira", "Kael"],
    });
  });

  it("quotes bare values but leaves literals and numbers alone", () => {
    expect(
      parseTrackerResponse('{"ok": true, "n": 5, "nil": null, "name": Lisbon, "time": 10:30}'),
    ).toEqual({ ok: true, n: 5, nil: null, name: "Lisbon", time: "10:30" });
    expect(parseTrackerResponse('{"location": Lisbon Portugal}')).toEqual({
      location: "Lisbon Portugal",
    });
  });

  it("repairs smart quotes used as delimiters", () => {
    expect(parseTrackerResponse('{"say": “hello there”, “n”: “v”}')).toEqual({
      say: "hello there",
      n: "v",
    });
  });

  it("preserves smart quotes inside string values", () => {
    const raw = '{"quote": "she said “hi” loudly"}';
    expect(parseTrackerResponse(raw)).toEqual({ quote: "she said “hi” loudly" });
  });

  it("keeps braces inside strings from breaking extraction", () => {
    const raw = 'noise { "code": "{{not a macro}} { and }", "n": 1 } trailing';
    expect(parseTrackerResponse(raw)).toEqual({
      code: "{{not a macro}} { and }",
      n: 1,
    });
  });

  it("handles escaped quotes inside strings", () => {
    const raw = '{"a": "quoted \\"inner\\" text"}';
    expect(parseTrackerResponse(raw)).toEqual({ a: 'quoted "inner" text' });
  });

  it("repairs CRLF line endings and strips BOM/zero-width edges", () => {
    const raw = '\uFEFF```json\r\n{"a": 1}\r\n```\u200B';
    expect(parseTrackerResponse(raw)).toEqual({ a: 1 });
    // Unfenced: the BOM and zero-width char sit inside the candidate.
    expect(parseTrackerResponse('\uFEFF{"a": 1}\u200B')).toEqual({ a: 1 });
  });

  it("repairs smart quotes and trailing commas together", () => {
    const raw = "```json\n{\n “time”: “10:00”,\n “tags”: [“a”, “b”,],\n}\n```";
    expect(parseTrackerResponse(raw)).toEqual({ time: "10:00", tags: ["a", "b"] });
  });

  it("throws on garbage", () => {
    expect(() => parseTrackerResponse("no json here at all")).toThrow(
      /Failed to parse tracker response:/,
    );
    expect(() => parseTrackerResponse("```json\n???\n```")).toThrow(
      /Failed to parse tracker response:/,
    );
  });

  it("throws when the result is not an object", () => {
    expect(() => parseTrackerResponse("```json\n[1, 2, 3]\n```")).toThrow(
      /Failed to parse tracker response:/,
    );
    expect(() => parseTrackerResponse('```json\n"just a string"\n```')).toThrow(
      /Failed to parse tracker response:/,
    );
    expect(() => parseTrackerResponse("```json\nnull\n```")).toThrow(
      /Failed to parse tracker response:/,
    );
  });

  it("carries the first parse error message", () => {
    try {
      parseTrackerResponse("{ definitely not json");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/^Failed to parse tracker response: /);
    }
  });
});
