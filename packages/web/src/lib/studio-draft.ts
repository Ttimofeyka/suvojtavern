/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Character Studio's draft model.
 *
 * The studio edits the same SillyTavern card fields the character API stores,
 * but keeps them in one flat object so a step can read and write any field
 * without prop-drilling. Everything here is pure and DOM-free: mapping a
 * stored character into a draft, folding a draft back into a create/patch
 * payload, dirty comparison, readiness stats, applying a batch AI seed pass,
 * the compact context block sent to the AI, and the deterministic aura seed
 * for the live card preview.
 */

import type { CharacterFieldKey, SeedFieldKey, SeedFieldValue } from "./api-character-generation";
import type { Character, CreateCharacterInput } from "./api-characters";

/** Every editable card field, in one flat draft. */
export interface StudioDraft {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  alternate_greetings: string[];
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  tags: string[];
}

/** A fresh draft with no shared array instances. */
export function emptyStudioDraft(): StudioDraft {
  return {
    name: "",
    description: "",
    personality: "",
    scenario: "",
    first_mes: "",
    alternate_greetings: [],
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    tags: [],
  };
}

/** The scalar fields, in display order — used by dirty comparison and stats. */
const SCALAR_KEYS = [
  "name",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creator_notes",
  "system_prompt",
  "post_history_instructions",
] as const;

/** Trims, drops blanks, and de-duplicates while preserving first-seen order. */
export function normalizeStudioTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === "" || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

/** Maps a stored character onto the studio's draft. */
export function draftFromCharacter(character: Character): StudioDraft {
  return {
    name: character.name,
    description: character.description,
    personality: character.personality,
    scenario: character.scenario,
    first_mes: character.first_mes,
    alternate_greetings: [...character.alternate_greetings],
    mes_example: character.mes_example,
    creator_notes: character.creator_notes,
    system_prompt: character.system_prompt,
    post_history_instructions: character.post_history_instructions,
    tags: [...character.tags],
  };
}

/**
 * Folds a draft into an API payload. The name is the one required field; tags
 * are normalized and blank/whitespace greetings are dropped, mirroring the
 * editor's save contract.
 */
export function draftToInput(draft: StudioDraft): CreateCharacterInput {
  return {
    name: draft.name.trim(),
    description: draft.description,
    personality: draft.personality,
    scenario: draft.scenario,
    first_mes: draft.first_mes.trim(),
    alternate_greetings: draft.alternate_greetings
      .map((greeting) => greeting.trim())
      .filter((greeting) => greeting !== ""),
    mes_example: draft.mes_example,
    creator_notes: draft.creator_notes,
    system_prompt: draft.system_prompt,
    post_history_instructions: draft.post_history_instructions,
    tags: normalizeStudioTags(draft.tags),
  };
}

/** Stable projection for dirty comparison (arrays included in order). */
function draftSignature(draft: StudioDraft): string {
  return JSON.stringify({
    ...Object.fromEntries(SCALAR_KEYS.map((key) => [key, draft[key]])),
    alternate_greetings: draft.alternate_greetings,
    tags: draft.tags,
  });
}

/** True when the draft differs from its saved/initial baseline. */
export function draftsEqual(a: StudioDraft, b: StudioDraft): boolean {
  return draftSignature(a) === draftSignature(b);
}

/** Word count for prose; whitespace-only text is zero, never one. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

/** The numbers the preview card and the readiness meter display. */
export interface DraftStats {
  filledFields: number;
  totalFields: number;
  /** 0–100, rounded. */
  percent: number;
  words: number;
  characters: number;
  tags: number;
  greetings: number;
}

/** Readiness is presence-based: a field counts when it has non-blank text. */
export function draftStats(draft: StudioDraft): DraftStats {
  const scalarPresence = [
    draft.name,
    draft.description,
    draft.personality,
    draft.scenario,
    draft.first_mes,
    draft.mes_example,
    draft.creator_notes,
  ].filter((value) => value.trim() !== "").length;
  const totalFields = 8; // the seven scalars above plus tags
  const filledFields = scalarPresence + (draft.tags.length > 0 ? 1 : 0);
  const prose = [
    draft.description,
    draft.personality,
    draft.scenario,
    draft.first_mes,
    ...draft.alternate_greetings,
    draft.mes_example,
    draft.creator_notes,
  ].join(" ");
  return {
    filledFields,
    totalFields,
    percent: Math.round((filledFields / totalFields) * 100),
    words: countWords(prose),
    characters: prose.length,
    tags: draft.tags.length,
    greetings:
      (draft.first_mes.trim() !== "" ? 1 : 0) +
      draft.alternate_greetings.filter((greeting) => greeting.trim() !== "").length,
  };
}

/** The prose fields a seed pass can return; never the advanced overrides. */
const GENERATED_SCALAR_KEYS = [
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creator_notes",
] as const satisfies readonly SeedFieldKey[];

/**
 * Merges the AI seed pass's returned subset into a draft. Name and prose are
 * trimmed; tags are normalized and greetings drop blanks, mirroring the save
 * contract. Fields the model did not return (or returned with the wrong type)
 * stay exactly as they were.
 */
export function applyGeneratedFields(
  draft: StudioDraft,
  fields: Partial<Record<SeedFieldKey, SeedFieldValue>>,
): StudioDraft {
  const next: StudioDraft = {
    ...draft,
    tags: [...draft.tags],
    alternate_greetings: [...draft.alternate_greetings],
  };
  if (typeof fields.name === "string" && fields.name.trim() !== "") {
    next.name = fields.name.trim();
  }
  if (Array.isArray(fields.tags)) {
    next.tags = normalizeStudioTags(fields.tags);
  }
  if (Array.isArray(fields.alternate_greetings)) {
    const seen = new Set<string>();
    next.alternate_greetings = fields.alternate_greetings
      .map((greeting) => greeting.trim())
      .filter((greeting) => {
        if (greeting === "" || seen.has(greeting)) {
          return false;
        }
        seen.add(greeting);
        return true;
      });
  }
  for (const key of GENERATED_SCALAR_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.trim() !== "") {
      next[key] = value.trim();
    }
  }
  return next;
}

/** Replaces one scalar field, returning a fresh draft. */
export function writeField(
  draft: StudioDraft,
  field: CharacterFieldKey,
  value: string,
): StudioDraft {
  return { ...draft, [field]: value };
}

/** Labels used in the context block; the AI dialog has the display labels. */
const CONTEXT_LABELS: Record<CharacterFieldKey, string> = {
  description: "DESCRIPTION",
  personality: "PERSONALITY",
  scenario: "SCENARIO",
  first_mes: "FIRST MESSAGE",
  mes_example: "EXAMPLE DIALOGUE",
  creator_notes: "CREATOR NOTES",
};

/** The order fields appear in the AI context block. */
const CONTEXT_ORDER: readonly CharacterFieldKey[] = [
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creator_notes",
];

/** Upper bound on the context block; keeps the prompt focused and cheap. */
const CONTEXT_MAX_CHARS = 5000;

/**
 * A compact, labelled block of the card's other fields for one AI pass. The
 * target field is omitted (it travels as CURRENT <FIELD>), blank fields drop
 * out, and the result is capped so a huge card cannot crowd out the request.
 */
export function draftContext(draft: StudioDraft, target: CharacterFieldKey): string {
  const parts: string[] = [];
  for (const field of CONTEXT_ORDER) {
    if (field === target) {
      continue;
    }
    const text = draft[field].trim();
    if (text !== "") {
      parts.push(`${CONTEXT_LABELS[field]}:\n${text}`);
    }
  }
  const alternates = draft.alternate_greetings
    .map((greeting) => greeting.trim())
    .filter((greeting) => greeting !== "");
  if (alternates.length > 0) {
    parts.push(
      `ALTERNATE GREETINGS:\n${alternates
        .map((greeting, index) => `#${index + 2}\n${greeting}`)
        .join("\n\n")}`,
    );
  }
  const joined = parts.join("\n\n");
  return joined.length > CONTEXT_MAX_CHARS
    ? `${joined.slice(0, CONTEXT_MAX_CHARS - 3)}...`
    : joined;
}

/** The deterministic visual identity of a card with no portrait. */
export interface CardAura {
  /** Conic gradient start angle, in degrees. */
  angle: number;
  /** Radial highlight position, in percent. */
  x: number;
  y: number;
  /** Accent mix percentages, 0–100. */
  mixA: number;
  mixB: number;
  /** Watermark glyph shown over the aura. */
  initial: string;
}

/**
 * Derives a stable aura from the name (falling back to tags, then
 * "untitled"). The same card always gets the same cover; a rename or a first
 * tag changes it. FNV-1a keeps the distribution even and cheap.
 */
export function auraFrom(seed: string, fallback = ""): CardAura {
  const source = seed.trim() !== "" ? seed.trim() : fallback.trim() || "untitled";
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const letter = source.match(/[\p{L}\p{N}]/u)?.[0];
  return {
    angle: hash % 360,
    x: 18 + ((hash >>> 3) % 64),
    y: 8 + ((hash >>> 9) % 42),
    mixA: 42 + ((hash >>> 15) % 28),
    mixB: 16 + ((hash >>> 21) % 22),
    initial: letter === undefined ? "?" : letter.toUpperCase(),
  };
}

/**
 * Coerces a stored/session value into a complete draft. Returns null when the
 * value is not a record with at least one recognizable card field, so a
 * corrupt session entry is discarded instead of restored as a blank card.
 */
export function coerceStudioDraft(value: unknown): StudioDraft | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const known = [...SCALAR_KEYS, "alternate_greetings", "tags"];
  if (!known.some((key) => key in record)) {
    return null;
  }
  const text = (key: string): string =>
    typeof record[key] === "string" ? (record[key] as string) : "";
  const list = (key: string): string[] =>
    Array.isArray(record[key])
      ? (record[key] as unknown[]).filter((item): item is string => typeof item === "string")
      : [];
  return {
    name: text("name"),
    description: text("description"),
    personality: text("personality"),
    scenario: text("scenario"),
    first_mes: text("first_mes"),
    alternate_greetings: list("alternate_greetings"),
    mes_example: text("mes_example"),
    creator_notes: text("creator_notes"),
    system_prompt: text("system_prompt"),
    post_history_instructions: text("post_history_instructions"),
    tags: list("tags"),
  };
}
