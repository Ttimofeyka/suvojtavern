/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it } from "bun:test";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import { createTestDb } from "../test-utils";
import {
  DEFAULT_TRACKER_SCHEMA,
  DEFAULT_TRACKER_SYSTEM_PROMPT,
  TRACKER_JSON_PROMPT_TEMPLATE,
} from "./defaults";
import { getTrackerConfig } from "./injection";
import { suvojTrackerMechanism } from "./mechanism-suvoj-tracker";
import { buildTrackerParts } from "./parts";
import type { TrackerGenerationInput } from "./registry";
import { schemaToExample } from "./schema-to-example";

describe("suvojTrackerMechanism", () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(createTestDb());
  });

  /** A full generation input: character, persona, window, trackers, schema. */
  function makeInput(overrides: Partial<TrackerGenerationInput> = {}): TrackerGenerationInput {
    const character = repos.characters.create({
      name: "Seraphina",
      description: "A catgirl librarian.",
      personality: "playful",
      scenario: "the library",
    });
    const persona = repos.personas.create({ name: "Alex", description: "A traveler." });
    const chat = repos.chats.create({ character_id: character.id, persona_id: persona.id });
    const input: TrackerGenerationInput = {
      chat,
      character,
      persona,
      messages: [
        { role: "user", content: "Hello!" },
        { role: "assistant", content: "Hi there." },
      ],
      previousTrackers: [
        { time: "10:00:00", location: "library" },
        { time: "10:00:05", location: "library, reading room" },
      ],
      config: getTrackerConfig(repos),
      schema: DEFAULT_TRACKER_SCHEMA,
      parts: [],
      ...overrides,
    };
    // Derive the plan from the EFFECTIVE schema (overrides may replace it),
    // unless a test supplies an explicit split.
    input.parts = overrides.parts ?? buildTrackerParts(input.schema);
    return input;
  }

  it("builds the full generation message array", () => {
    const input = makeInput();
    const messages = suvojTrackerMechanism.buildGenerationMessages(input);

    // The schema's `wants` / `knows` descriptions carry `{{user}}`; the
    // mechanism resolves NAME macros BEFORE serializing (so the derived
    // example inherits them too). Build the expected schema the same way by
    // splicing the persona name in.
    const expectedSchema = JSON.parse(
      JSON.stringify(DEFAULT_TRACKER_SCHEMA).replaceAll("{{user}}", "Alex"),
    ) as Record<string, unknown>;
    const expectedJsonPrompt = TRACKER_JSON_PROMPT_TEMPLATE.replaceAll(
      "{{schema}}",
      JSON.stringify(expectedSchema, null, 2),
    ).replaceAll("{{example_response}}", JSON.stringify(schemaToExample(expectedSchema), null, 2));

    expect(messages).toEqual([
      {
        role: "system",
        content:
          "Character: Seraphina\n\nA catgirl librarian.\n\nPersonality: playful\n\nScenario: the library",
      },
      { role: "system", content: "User persona: Alex\n\nA traveler." },
      { role: "system", content: DEFAULT_TRACKER_SYSTEM_PROMPT.replaceAll("{{user}}", "Alex") },
      { role: "user", content: "Hello!" },
      { role: "assistant", content: "Hi there." },
      {
        role: "system",
        content: `Previous tracker snapshot (keep consistent and build on it):\n\`\`\`json\n${JSON.stringify(input.previousTrackers[0], null, 2)}\n\`\`\``,
      },
      {
        role: "system",
        content: `Previous tracker snapshot (keep consistent and build on it):\n\`\`\`json\n${JSON.stringify(input.previousTrackers[1], null, 2)}\n\`\`\``,
      },
      { role: "system", content: expectedJsonPrompt },
    ]);
    // The template tokens are fully substituted.
    expect(messages[messages.length - 1]?.content).not.toContain("{{schema}}");
    expect(messages[messages.length - 1]?.content).not.toContain("{{example_response}}");
    // ...and so are the NAME macros inside the schema + worked example.
    expect(messages[messages.length - 1]?.content).not.toContain("{{user}}");
    expect(messages[messages.length - 1]?.content).toContain("Alex");
  });

  it("substitutes NAME macros in the schema and its worked example, leaving other macros", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: {
        note: { type: "string", description: "{{user}} / {{char}} / {{ USER }} / {{foo}}" },
      },
    };
    const input = makeInput({ schema });
    const jsonPrompt = suvojTrackerMechanism.buildGenerationMessages(input).at(-1)?.content ?? "";

    // `user`/`char` are case-insensitive and tolerate padding; `{{foo}}` is a
    // macro the tracker path does not implement and must survive verbatim.
    expect(jsonPrompt).toContain("Alex / Seraphina / Alex / {{foo}}");
    expect(jsonPrompt).not.toContain("{{user}}");
    expect(jsonPrompt).not.toContain("{{char}}");
    expect(jsonPrompt).not.toContain("{{ USER }}");
    // Appears in BOTH the schema and the derived example.
    expect(jsonPrompt.split("Alex / Seraphina / Alex / {{foo}}")).toHaveLength(3);
  });

  it("substitutes NAME macros in a custom system prompt", () => {
    const input = makeInput();
    input.config.system_prompt = "Talk to {{user}} about {{char}}, not {{foo}}.";
    const messages = suvojTrackerMechanism.buildGenerationMessages(input);
    expect(messages).toContainEqual({
      role: "system",
      content: "Talk to Alex about Seraphina, not {{foo}}.",
    });
  });

  it("falls back to User/Character when the persona and character are missing", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: { note: { type: "string", description: "{{user}} & {{char}}" } },
    };
    const input = makeInput({
      character: null,
      persona: null,
      messages: [],
      previousTrackers: [],
      schema,
    });
    input.config.system_prompt = "{{user}} + {{char}}";
    const messages = suvojTrackerMechanism.buildGenerationMessages(input);

    expect(messages).toContainEqual({ role: "system", content: "User + Character" });
    const jsonPrompt = messages.at(-1)?.content ?? "";
    expect(jsonPrompt).toContain("User & Character");
    expect(jsonPrompt).not.toContain("{{");
  });

  it("JSON-escapes a quote-containing name because substitution precedes serialization", () => {
    const persona = repos.personas.create({ name: 'He said "hi"', description: "A traveler." });
    const schema: Record<string, unknown> = {
      type: "object",
      properties: { note: { type: "string", description: "{{user}}" } },
    };
    const input = makeInput({ persona, schema });
    const jsonPrompt = suvojTrackerMechanism.buildGenerationMessages(input).at(-1)?.content ?? "";

    // Extract the schema block (the FIRST ```json in the template sits inside
    // the instructions, so anchor on the marker). If substitution happened
    // after `JSON.stringify`, the raw quote would make this unparseable.
    const marker = "**JSON SCHEMA TO FOLLOW:**\n```json\n";
    const afterMarker = jsonPrompt.slice(jsonPrompt.indexOf(marker) + marker.length);
    const schemaJson = afterMarker.slice(0, afterMarker.indexOf("\n```"));
    const parsed = JSON.parse(schemaJson) as {
      properties: { note: { description: string } };
    };
    expect(parsed.properties.note.description).toBe('He said "hi"');
  });

  it("substitutes NAME macros in character card text", () => {
    const character = repos.characters.create({
      name: "Seraphina",
      description: "A librarian who follows {{user}} everywhere.",
      personality: "loyal to {{user}}",
      scenario: "{{user}}'s visit",
    });
    const input = makeInput({ character });
    const messages = suvojTrackerMechanism.buildGenerationMessages(input);

    // Card fields are substituted; the `name` is left as the literal.
    expect(messages[0]).toEqual({
      role: "system",
      content:
        "Character: Seraphina\n\nA librarian who follows Alex everywhere.\n\nPersonality: loyal to Alex\n\nScenario: Alex's visit",
    });
  });

  it("builds only the system prompt and JSON template without context", () => {
    const chat = repos.chats.create({
      character_id: repos.characters.create({ name: "Solo" }).id,
    });
    const input = makeInput({
      character: null,
      persona: null,
      messages: [],
      previousTrackers: [],
      chat,
    });
    const messages = suvojTrackerMechanism.buildGenerationMessages(input);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: "system",
      content: DEFAULT_TRACKER_SYSTEM_PROMPT.replaceAll("{{user}}", "User"),
    });
    expect(messages[1]?.role).toBe("system");
    expect(messages[1]?.content).toContain("**JSON SCHEMA TO FOLLOW:**");
  });

  it("skips empty character card fields and a missing persona", () => {
    const character = repos.characters.create({ name: "Bare" });
    const input = makeInput({ character, persona: null });
    const messages = suvojTrackerMechanism.buildGenerationMessages(input);
    expect(messages[0]).toEqual({ role: "system", content: "Character: Bare" });
    expect(messages.some((message) => message.content.startsWith("User persona:"))).toBe(false);
  });

  it("uses the configured system prompt and schema", () => {
    const input = makeInput({ schema: { type: "object", properties: { n: { type: "number" } } } });
    input.config.system_prompt = "Custom tracker prompt";
    input.config.include_last_trackers = 0;
    const messages = suvojTrackerMechanism.buildGenerationMessages(input);
    expect(messages).toContainEqual({ role: "system", content: "Custom tracker prompt" });
    expect(messages[messages.length - 1]?.content).toContain('"n"');
  });

  it("parseResponse parses the fenced JSON block", () => {
    const input = makeInput();
    const raw = '```json\n{"time": "11:00:00"}\n```';
    expect(suvojTrackerMechanism.parseResponse(raw, input)).toEqual({ time: "11:00:00" });
  });

  it("parseResponse throws on garbage", () => {
    const input = makeInput();
    expect(() => suvojTrackerMechanism.parseResponse("total nonsense", input)).toThrow(
      /Failed to parse tracker response:/,
    );
  });

  /** A minimal two-field schema with an explicit 2-way split. */
  function makeSplitInput(): TrackerGenerationInput {
    const schema: Record<string, unknown> = {
      title: "Split",
      type: "object",
      properties: { time: { type: "string" }, location: { type: "string" } },
      required: ["time", "location"],
    };
    return makeInput({
      schema,
      parts: buildTrackerParts(schema, { count: 2, fields: { time: 1, location: 2 } }),
    });
  }

  it("buildGenerationRequests returns the single message array for one part", () => {
    const input = makeInput();
    const requests = suvojTrackerMechanism.buildGenerationRequests?.(input);
    expect(requests).toEqual([{ messages: suvojTrackerMechanism.buildGenerationMessages(input) }]);
  });

  it("buildGenerationRequests builds one shared-preamble request per part", () => {
    const input = makeSplitInput();
    const requests = suvojTrackerMechanism.buildGenerationRequests?.(input);
    expect(requests).toHaveLength(2);

    // Every request shares the exact preamble of the single-request layout.
    const preamble = suvojTrackerMechanism.buildGenerationMessages(input).slice(0, -1);
    expect(requests?.[0]?.messages.slice(0, -1)).toEqual(preamble);
    expect(requests?.[1]?.messages.slice(0, -1)).toEqual(preamble);

    const first = requests?.[0]?.messages.at(-1)?.content ?? "";
    expect(first.startsWith("**GENERATION PART 1 OF 2:**")).toBe(true);
    expect(first).toContain('"time"');
    expect(first).not.toContain('"location"');

    const second = requests?.[1]?.messages.at(-1)?.content ?? "";
    expect(second.startsWith("**GENERATION PART 2 OF 2:**")).toBe(true);
    expect(second).toContain('"location"');
    expect(second).not.toContain('"time"');
  });

  it("buildGenerationRequests falls back to the whole schema when parts is empty", () => {
    const input = makeInput();
    input.parts = [];
    const requests = suvojTrackerMechanism.buildGenerationRequests?.(input);
    expect(requests).toEqual([{ messages: suvojTrackerMechanism.buildGenerationMessages(input) }]);
  });

  it("parseResponses merges disjoint part JSON into one object", () => {
    const input = makeSplitInput();
    const merged = suvojTrackerMechanism.parseResponses?.(
      ['```json\n{"time": "11:00:00"}\n```', '{"location": "library"}'],
      input,
    );
    expect(merged).toEqual({ time: "11:00:00", location: "library" });
  });

  it("parseResponses throws when any part is unparseable", () => {
    const input = makeSplitInput();
    expect(() =>
      suvojTrackerMechanism.parseResponses?.(['{"time": "11:00:00"}', "total nonsense"], input),
    ).toThrow(/Failed to parse tracker response:/);
  });

  it("parseResponses parses the single response when there is one part", () => {
    const input = makeInput();
    const parsed = suvojTrackerMechanism.parseResponses?.(
      ['```json\n{"time": "11:00:00"}\n```'],
      input,
    );
    expect(parsed).toEqual({ time: "11:00:00" });
  });
});
