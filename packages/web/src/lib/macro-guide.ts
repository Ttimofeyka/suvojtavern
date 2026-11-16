/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Static, structured reference for the macro engine (`@suvoj/core/src/engine/macros.ts`).
 *
 * This is the ONE place the in-app guide's content lives, so the modal component
 * stays presentational. Names below are the engine's lowercase switch keys — the
 * engine matches case-insensitively (`{{Char}}` works), so the canonical spelling
 * is only a label. `macro-guide.test.ts` pins the documented name set against the
 * real engine in both directions: a macro added to the engine without a row here,
 * or a row here the engine drops, fails the suite.
 */

/** One macro: its typed syntax plus the semantics worth surfacing in the UI. */
export interface MacroEntry {
  /** Canonical macro name without braces, e.g. "random". */
  name: string;
  /** The literal syntax as typed, e.g. "{{random:a,b,c}}". */
  syntax: string;
  /** One or two sentences: what it does and any semantics worth knowing. */
  description: string;
  /** A short before/after illustration. */
  example: string;
  /** Optional caveat/semantic note. */
  note?: string;
}

/** A titled group of related macros. */
export interface MacroSection {
  id: string;
  title: string;
  blurb: string;
  entries: MacroEntry[];
}

export const MACRO_SECTIONS: MacroSection[] = [
  {
    id: "identity",
    title: "Character & persona",
    blurb:
      "Who the prompt is speaking as and to. Names resolve per generation from the active card and persona.",
    entries: [
      {
        name: "char",
        syntax: "{{char}}",
        description: "The character's name — the card the current message belongs to.",
        example: "Hello, I'm {{char}}. → Hello, I'm Aria.",
      },
      {
        name: "user",
        syntax: "{{user}}",
        description: "The user's display name, taken from the active persona.",
        example: "{{user}} walks in. → Kai walks in.",
      },
      {
        name: "persona",
        syntax: "{{persona}}",
        description: "The active persona's description text. Empty when no persona is set.",
        example: "You are {{persona}}. → You are a curious explorer.",
      },
    ],
  },
  {
    id: "time",
    title: "Time & date",
    blurb:
      "The moment the prompt is assembled. All five read the same clock, so they always agree.",
    entries: [
      {
        name: "time",
        syntax: "{{time}}",
        description: "The current local time, 12-hour with an AM/PM suffix.",
        example: "It's {{time}}. → It's 3:45 PM.",
      },
      {
        name: "isotime",
        syntax: "{{isotime}}",
        description: "The current local time in 24-hour HH:MM form.",
        example: "{{isotime}} sharp. → 15:45 sharp.",
      },
      {
        name: "date",
        syntax: "{{date}}",
        description: "The current date, month name first.",
        example: "Today is {{date}}. → Today is September 4, 2026.",
      },
      {
        name: "isodate",
        syntax: "{{isodate}}",
        description: "The current date in ISO YYYY-MM-DD form.",
        example: "Log date: {{isodate}}. → Log date: 2026-09-04.",
      },
      {
        name: "weekday",
        syntax: "{{weekday}}",
        description: "The current weekday name.",
        example: "Happy {{weekday}}! → Happy Friday!",
      },
    ],
  },
  {
    id: "chat",
    title: "Chat context",
    blurb: "State pulled from the conversation itself — time away and the most recent line.",
    entries: [
      {
        name: "idle_duration",
        syntax: "{{idle_duration}}",
        description:
          'Humanized time since the user\'s last message — "a few seconds", "a minute", "3 minutes", "an hour", "2 days", "a month". Reads "just now" when there is no earlier message.',
        example: "Away for {{idle_duration}}. → Away for 3 minutes.",
      },
      {
        name: "lastmessage",
        syntax: "{{lastMessage}}",
        description: "The content of the most recent chat message.",
        example: "They said: {{lastMessage}} → They said: Let's go.",
      },
      {
        name: "//",
        syntax: "{{//comment}}",
        description:
          "A comment. The whole macro, braces included, is removed before the prompt is sent.",
        example: "Aria smiles.{{//she left the door open}} → Aria smiles.",
        note: "Useful for leaving notes in a card the model never sees.",
      },
    ],
  },
  {
    id: "random",
    title: "Randomness & dice",
    blurb:
      "Vary the wording, or let the dice decide. All values are evaluated when the prompt is assembled.",
    entries: [
      {
        name: "random",
        syntax: "{{random:a,b,c}}",
        description: "Picks one item at random, so it may change on every render.",
        example: "{{random:sword,shield,bow}} in hand. → shield in hand.",
        note: "Use :: between items when they contain commas ({{random:salt::bread, butter}}), or escape a comma as \\, inside one item.",
      },
      {
        name: "pick",
        syntax: "{{pick:a,b,c}}",
        description:
          "Picks one item, deterministically for a given chat and text — the same placeholder keeps the same value across re-renders.",
        example: "{{pick:red,blue,green}} sky. → blue sky.",
        note: "Same separators as random: :: between items, \\, to escape a comma.",
      },
      {
        name: "roll",
        syntax: "{{roll}}",
        description: "Rolls one twenty-sided die (1-20).",
        example: "Initiative: {{roll}} → Initiative: 9",
      },
      {
        name: "roll",
        syntax: "{{roll:2d6}}",
        description:
          "Rolls N dice of M sides and sums them; N defaults to 1 and at most 1000 dice are rolled.",
        example: "Damage: {{roll:2d6}} → Damage: 6",
      },
      {
        name: "roll",
        syntax: "{{roll:1-10}}",
        description: "A random whole number in the inclusive range X-Y.",
        example: "Luck: {{roll:1-10}} → Luck: 5",
      },
      {
        name: "roll",
        syntax: "{{roll:6}}",
        description: "A random whole number from 1 to N.",
        example: "d6: {{roll:6}} → d6: 3",
      },
    ],
  },
  {
    id: "variables",
    title: "Variables",
    blurb:
      "Store state across a text or a whole chat. Side effects land in order, so later macros in the same text see them.",
    entries: [
      {
        name: "setvar",
        syntax: "{{setvar::name::value}}",
        description: "Stores value under name and renders nothing itself.",
        example: "{{setvar::mood::curious}}Where to? → Where to?",
        note: "In a chat, writes land in that chat's scope and reads fall back to the global scope; with no chat, everything uses the global scope.",
      },
      {
        name: "getvar",
        syntax: "{{getvar::name}}",
        description:
          "Renders the stored value, or an empty string when the variable was never set.",
        example: "Mood: {{getvar::mood}} → Mood: curious",
      },
      {
        name: "getvar",
        syntax: "{{getvar::name::default}}",
        description:
          "Renders the stored value when set, otherwise the fallback after the second ::.",
        example: "{{getvar::weather::sunny}} → sunny",
      },
      {
        name: "addvar",
        syntax: "{{addvar::name::value}}",
        description:
          "Adds value numerically when both the old and new values parse as numbers, otherwise concatenates the text. Renders nothing.",
        example: "{{addvar::score::5}}Scored! → Scored!",
        note: "Unlike incvar/decvar, addvar never echoes the new value.",
      },
      {
        name: "incvar",
        syntax: "{{incvar::name}}",
        description: "Adds 1 and renders the new value.",
        example: "{{setvar::score::3}}{{incvar::score}} → 4",
      },
      {
        name: "decvar",
        syntax: "{{decvar::name}}",
        description: "Subtracts 1 and renders the new value.",
        example: "{{setvar::score::4}}{{decvar::score}} → 3",
      },
    ],
  },
  {
    id: "helpers",
    title: "Helpers",
    blurb: "Formatting and control macros that shape the text around everything else.",
    entries: [
      {
        name: "newline",
        syntax: "{{newline}}",
        description: "A literal line break. Use it where a single-line field cannot hold one.",
        example: "Line one{{newline}}Line two → Line one\\nLine two",
      },
      {
        name: "trim",
        syntax: "{{trim}}",
        description:
          "Removes itself and the line breaks hugging it on both sides — handy around a macro you removed.",
        example: "Text\\n\\n{{trim}}\\n\\nMore → Text\\nMore",
      },
      {
        name: "noop",
        syntax: "{{noop}}",
        description: "Renders nothing. A deliberate no-op for placeholder spots.",
        example: "{{noop}}Nothing to see. → Nothing to see.",
      },
      {
        name: "ui",
        syntax: "{{ui:style}}",
        description:
          "Renders the chosen value of the preset UI control with that id, so a preset can ask for a style or tone.",
        example: "Write in a {{ui:style}} style. → Write in a descriptive style.",
        note: "Stays verbatim when no control with that id resolves — here, {{ui:controlId}} would.",
      },
    ],
  },
];

/** Intro shown above the sections: what macros are and where they run. */
export const MACRO_INTRO: string[] = [
  "Macros are placeholders written in double braces — {{char}}, {{time}}, {{random:a,b,c}} — that the prompt engine replaces with live values right before a generation is sent. They let a card speak in the user's name, react to the clock, or vary its wording.",
  "Names are case-insensitive: {{Char}} and {{char}} are the same macro. A macro the engine does not recognise is left in the text verbatim, so a typo shows up in the prompt instead of silently vanishing.",
  "Macros are evaluated in character card fields, greetings, lorebook content, and preset prompts. Card authors reach for them most in the character editor's Introduction and Greetings fields.",
];

/** Case-insensitive substring match over name, syntax, description, and example. */
export function filterMacroSections(query: string): MacroSection[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return MACRO_SECTIONS;
  }
  return MACRO_SECTIONS.map((section) => ({
    ...section,
    entries: section.entries.filter((entry) =>
      [entry.name, entry.syntax, entry.description, entry.example].some((field) =>
        field.toLowerCase().includes(needle),
      ),
    ),
  })).filter((section) => section.entries.length > 0);
}
