/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PromptMessage } from "../engine/prompt";
import { TRACKER_JSON_PROMPT_TEMPLATE } from "./defaults";
import { parseTrackerResponse } from "./parser";
import type { TrackerSchemaPart } from "./parts";
import type { TrackerData, TrackerGenerationInput, TrackerMechanism } from "./registry";
import { schemaToExample } from "./schema-to-example";

/**
 * The built-in `suvoj-tracker` mechanism — zTracker's prompt layout.
 *
 * Messages, in order: the character card and user persona blocks (each only
 * when present), the tracker system prompt, the windowed chat messages, the
 * previous tracker snapshots (oldest → newest, fenced as JSON), and the
 * JSON-conformance template carrying the active schema and its worked
 * example. `parseResponse` runs the shared repair parser.
 *
 * When the preset is split across several requests (see `parts`), every
 * request gets the SAME preamble and a JSON prompt carrying only its own
 * subset schema, prefixed with a "GENERATION PART i OF n" note that tells the
 * model the other fields are being produced in parallel. `parseResponses`
 * shallow-merges the parallel replies back into one object.
 */

/** `{{token}}` substitution without a template engine. */
function substitute(text: string, tokens: Record<string, string>): string {
  let out = text;
  for (const [token, value] of Object.entries(tokens)) {
    out = out.split(`{{${token}}}`).join(value);
  }
  return out;
}

/** Matches the two NAME macros, case-insensitively and tolerant of padding. */
const NAME_MACRO = /\{\{\s*(user|char)\s*\}\}/gi;

/**
 * Substitutes the name macros a tracker prompt may carry — `{{user}}` and
 * `{{char}}` (case-insensitive, surrounding whitespace tolerated, ST-style).
 * The tracker path deliberately does NOT run the full macro engine (no rolls,
 * variables or time side effects), so every other macro is left verbatim.
 * Missing names use the engine's own fallback convention ("User"/"Character").
 */
function substituteNames(text: string, names: { char: string; user: string }): string {
  // Fast path: prompts without any macro (the common case) skip the regex.
  if (!text.includes("{{")) {
    return text;
  }
  // A replacer FUNCTION, not a `$`-string: a name containing `$&`-style
  // sequences must be inserted literally, never treated as a match reference.
  return text.replace(NAME_MACRO, (_match, name: string) =>
    name.toLowerCase() === "user" ? names.user : names.char,
  );
}

/**
 * Deep variant of {@link substituteNames} for an arbitrary JSON-schema value:
 * strings are substituted, arrays and objects are rebuilt recursively, and
 * object KEYS are left as-is (a schema key is vocabulary, never prompt text).
 * Running this BEFORE `JSON.stringify` lets the serializer escape a name that
 * contains a quote — substituting into already-serialized JSON would corrupt it.
 */
function substituteNamesDeep(value: unknown, names: { char: string; user: string }): unknown {
  if (typeof value === "string") {
    return substituteNames(value, names);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteNamesDeep(item, names));
  }
  if (typeof value === "object" && value !== null) {
    // Rebuild rather than mutate: the active schema may be a shared constant
    // (DEFAULT_TRACKER_SCHEMA), so an in-place edit would leak across runs.
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = substituteNamesDeep(item, names);
    }
    return out;
  }
  return value;
}

/**
 * Resolves the NAME macro values once per input, mirroring the engine's macro
 * context (engine/chat.ts): the persona/character display names, with the
 * engine's own "User"/"Character" labels as the fallback.
 */
function trackerNames(input: TrackerGenerationInput): { char: string; user: string } {
  return {
    char: input.character?.name ?? "Character",
    user: input.persona?.name ?? "User",
  };
}

/** The system prompt carrying the schema + example response. */
function buildJsonPrompt(
  schema: Record<string, unknown>,
  names: { char: string; user: string },
  part?: { index: number; total: number },
): string {
  // Resolve name macros in the schema BEFORE serializing: substituting into
  // already-serialized JSON could break escaping (a persona named `He said
  // "hi"` would corrupt the document), and the derived worked example below
  // must inherit the SAME resolved text the schema carries.
  const resolved = substituteNamesDeep(schema, names) as Record<string, unknown>;
  const prompt = substitute(TRACKER_JSON_PROMPT_TEMPLATE, {
    schema: JSON.stringify(resolved, null, 2),
    example_response: JSON.stringify(schemaToExample(resolved), null, 2),
  });
  if (!part) {
    return prompt;
  }
  return `**GENERATION PART ${part.index} OF ${part.total}:** Produce ONLY the fields listed in the schema below. The other parts are generated in parallel — do not include their fields.\n\n${prompt}`;
}

/**
 * The messages shared by every request of a generation, i.e. everything
 * BEFORE the JSON prompt (character, persona, system prompt, chat window,
 * previous snapshots). Split requests differ only in the final JSON prompt,
 * so building this once keeps their preambles byte-identical.
 */
function buildPreamble(
  input: TrackerGenerationInput,
  names: { char: string; user: string },
): PromptMessage[] {
  const messages: PromptMessage[] = [];

  if (input.character) {
    const { character } = input;
    // Card text is mechanism-authored prompt text and may carry macros; the
    // `name` itself is NOT substituted — it is already the resolved literal.
    let content = `Character: ${character.name}`;
    if (character.description) {
      content += `\n\n${substituteNames(character.description, names)}`;
    }
    if (character.personality) {
      content += `\n\nPersonality: ${substituteNames(character.personality, names)}`;
    }
    if (character.scenario) {
      content += `\n\nScenario: ${substituteNames(character.scenario, names)}`;
    }
    messages.push({ role: "system", content });
  }

  if (input.persona) {
    const { persona } = input;
    messages.push({
      role: "system",
      content: `User persona: ${persona.name}\n\n${substituteNames(persona.description, names)}`,
    });
  }

  messages.push({ role: "system", content: substituteNames(input.config.system_prompt, names) });
  messages.push(...input.messages);

  for (const tracker of input.previousTrackers) {
    messages.push({
      role: "system",
      content: `Previous tracker snapshot (keep consistent and build on it):\n\`\`\`json\n${JSON.stringify(tracker, null, 2)}\n\`\`\``,
    });
  }

  return messages;
}

/** The single-request message array: the shared preamble + the whole schema. */
function buildGenerationMessages(input: TrackerGenerationInput): PromptMessage[] {
  const names = trackerNames(input);
  return [
    ...buildPreamble(input, names),
    { role: "system", content: buildJsonPrompt(input.schema, names) },
  ];
}

/**
 * The plan to build requests from: the caller-resolved parts, or a single
 * whole-schema part when the input carries none (direct/programmatic use).
 */
function resolveParts(input: TrackerGenerationInput): TrackerSchemaPart[] {
  return input.parts.length > 0 ? input.parts : [{ index: 1, fields: [], schema: input.schema }];
}

export const suvojTrackerMechanism: TrackerMechanism = {
  id: "suvoj-tracker",
  name: "Suvoj Tracker",
  description: "Scene tracker with JSON-schema-driven generation and repair parsing",
  buildGenerationMessages,
  parseResponse: (raw: string): TrackerData => parseTrackerResponse(raw),
  buildGenerationRequests: (input) => {
    const parts = resolveParts(input);
    if (parts.length <= 1) {
      return [{ messages: buildGenerationMessages(input) }];
    }
    const total = parts.length;
    const names = trackerNames(input);
    const preamble = buildPreamble(input, names);
    return parts.map((part) => ({
      messages: [
        ...preamble,
        {
          role: "system",
          content: buildJsonPrompt(part.schema, names, { index: part.index, total }),
        },
      ],
    }));
  },
  parseResponses: (raws, input) => {
    const parts = resolveParts(input);
    if (parts.length <= 1) {
      return parseTrackerResponse(raws[0] ?? "");
    }
    // Atomic: an unparseable part throws and the whole generation fails, so a
    // partial merge can never be persisted as a complete tracker.
    const merged: TrackerData = {};
    for (const raw of raws) {
      // Own-key copy that skips `__proto__`: assigning it would invoke the
      // prototype setter and swap `merged`'s prototype instead of storing the
      // key. A normal object (not null-prototype) keeps ordinary semantics.
      for (const [key, value] of Object.entries(parseTrackerResponse(raw))) {
        if (key !== "__proto__") {
          merged[key] = value;
        }
      }
    }
    return merged;
  },
};
