/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PresetPrompt, PresetPromptMarker } from "./api-presets";

/**
 * Marker-slot metadata shared by the preset list and the editor: the
 * friendly name shown for each slot and a one-line description of what
 * the engine renders there. Users always see these names — never ids.
 */

/** Friendly label + one-line purpose for every marker slot. */
export const MARKER_INFO: Record<PresetPromptMarker, { name: string; description: string }> = {
  main: {
    name: "Main prompt",
    description: "The system prompt that leads every generation.",
  },
  worldInfoBefore: {
    name: "Lorebook (before)",
    description: "Lorebook entries injected before the character card.",
  },
  personaDescription: {
    name: "Persona description",
    description: "Your persona — the user's description.",
  },
  charDescription: {
    name: "Character description",
    description: "The character's description field.",
  },
  charPersonality: {
    name: "Character personality",
    description: "The character's personality field.",
  },
  scenario: {
    name: "Scenario",
    description: "The scene the conversation starts in.",
  },
  worldInfoAfter: {
    name: "Lorebook (after)",
    description: "Lorebook entries injected after the character card.",
  },
  dialogueExamples: {
    name: "Example dialogues",
    description: "The character's example dialogues.",
  },
  chatHistory: {
    name: "Chat history",
    description: "The conversation itself.",
  },
  jailbreak: {
    name: "Post-history instructions",
    description: "The last word after the chat — steering applied at the end.",
  },
};

/** The canonical top-to-bottom marker order for a fresh preset. */
const MARKER_ORDER: readonly PresetPromptMarker[] = [
  "main",
  "worldInfoBefore",
  "personaDescription",
  "charDescription",
  "charPersonality",
  "scenario",
  "worldInfoAfter",
  "dialogueExamples",
  "chatHistory",
  "jailbreak",
];

/**
 * Starter skeleton sent when creating a preset: all ten marker slots in
 * order and enabled, so a new preset is functional out of the box. Read-only
 * by convention — consumers that edit prompts clone their rows first (the
 * editor works on its own draft).
 */
export const NEW_PRESET_PROMPTS: PresetPrompt[] = MARKER_ORDER.map((marker) => ({
  id: marker,
  name: MARKER_INFO[marker].name,
  role: "system",
  content: "",
  enabled: true,
  marker,
  injection_position: 0,
  injection_depth: 4,
  injection_order: 100,
}));
