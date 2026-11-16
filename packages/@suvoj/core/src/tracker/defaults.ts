/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Built-in tracker defaults (the Suvoj Tracker surface).
 *
 * `TRACKER_JSON_PROMPT_TEMPLATE` remains a verbatim copy of the upstream
 * zTracker text. The system prompt, schema and HTML template are Suvoj's own
 * defaults — no longer the upstream SceneTracker shape — and are what "reset
 * to default" restores.
 */

/**
 * The default (user-editable) tracker system prompt. The `suvoj-tracker` mechanism
 * appends its own JSON-conformance system prompt (carrying the schema and a
 * worked example) after this text, so the output-format rules live there
 * instead of being duplicated here.
 */
export const DEFAULT_TRACKER_SYSTEM_PROMPT = `You are a Scene Tracker Assistant. You maintain one structured snapshot of the current roleplay scene: who is present, what they wear, what they want, what they know, and what they are doing. Use the latest message, the recent messages, and the previous tracker snapshots.

Key instructions:
* Copy, do not re-derive. If a field is unchanged, copy it verbatim from the previous tracker. Never re-infer pronouns, voice, or identity from a name, role, or description.
* Pronouns are facts. Copy them from the previous tracker or the card. If a new character's pronouns are not stated, record them once and keep them for the rest of the chat.
* Present characters get the full block: name, pronouns, outfit, posture, wants, knows, voice. "posture" includes how put-together or disheveled the character appears; there is no separate state-of-dress field.
* Off-stage characters get at most five entries, each as name + pronouns + one line of current activity. Do not re-describe their outfit, posture, or agenda. Update the activity line only when the recent messages mention it; otherwise copy it verbatim. Do not simulate off-screen events.
* knownCast is a names-only list of every named character established in the chat. Append new names; never drop a name. Cap the list at 20 names, oldest first.
* Knowledge is a licence. For each present character's "knows", list only what they witnessed, were told, or found as evidence. A belief may be wrong; record it as a belief. "secrets" holds two or three live facts, each attributed with "knows", "suspects", and optionally "misled".
* NPC-only internals: never infer {{user}}'s thoughts, wants, or knowledge. For {{user}}'s "wants" and "knows", write "N/A".
* Never invent. If a fact is not in the transcript or the previous tracker, write "unknown" rather than filling it in. Do not use reasonable assumptions or default character details.
* Include underwear in "outfit" when the scene establishes it. If the character is undressed, list the removed outfit.
* Location: a specific primary scene location with increasing specificity.
* Respond with the full tracker every time. Do not emit a partial object.`;

/**
 * The default tracker schema (draft-07 style) — Suvoj's own scene-tracking
 * shape, no longer mirroring zTracker's SceneTracker.
 */
export const DEFAULT_TRACKER_SCHEMA: Record<string, unknown> = {
  title: "SceneTracker",
  type: "object",
  description: "Snapshot of the current roleplay scene",
  properties: {
    location: {
      type: "string",
      description: "Specific scene location with increasing specificity",
    },
    characters: {
      type: "array",
      description: "Characters present in the immediate scene. One full block per character.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Character name" },
          pronouns: {
            type: "string",
            description:
              "Pronouns copied verbatim from the previous tracker or the card (e.g. she/her). Never re-inferred.",
          },
          outfit: {
            type: "string",
            description: "Complete outfit including underwear when the scene establishes it",
          },
          posture: {
            type: "string",
            description:
              "Physical posture and interaction, plus how put-together or disheveled the character appears",
          },
          wants: {
            type: "string",
            description: "One goal this scene. Write 'N/A' for {{user}}",
          },
          knows: {
            type: "string",
            description:
              "What this character witnessed, was told, or found as evidence. Short fact tags. Write 'N/A' for {{user}}",
          },
          voice: {
            type: "string",
            description:
              "One line of speech style: register, rhythm, vocabulary. Copy verbatim once established.",
          },
        },
        required: ["name", "pronouns", "outfit", "posture", "wants", "knows"],
      },
    },
    offstage: {
      type: "array",
      description: "At most five off-stage characters, most recently active first",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Character name" },
          pronouns: {
            type: "string",
            description: "Copied verbatim; never re-inferred",
          },
          doing: {
            type: "string",
            description:
              "One line: current activity. Update only on evidence; otherwise copy verbatim.",
          },
        },
        required: ["name", "pronouns", "doing"],
      },
    },
    knownCast: {
      type: "array",
      description:
        "Names only: every named character established in the chat. Append-only, capped at 20.",
      items: { type: "string" },
    },
    secrets: {
      type: "array",
      description: "Two or three live facts that someone is hiding or acting on",
      items: {
        type: "object",
        properties: {
          fact: { type: "string", description: "The fact, stated plainly" },
          knows: {
            type: "array",
            description: "Characters who know the fact",
            items: { type: "string" },
          },
          suspects: {
            type: "array",
            description: "Characters who suspect the fact",
            items: { type: "string" },
          },
          misled: {
            type: "array",
            description: "Characters who believe something false about it",
            items: { type: "string" },
          },
        },
        required: ["fact", "knows", "suspects"],
      },
    },
  },
  required: ["location", "characters", "offstage", "knownCast", "secrets"],
};

/**
 * The default tracker HTML template. Template syntax (a fixed contract —
 * the web renderer implements the same rules):
 *
 * - `{{path.to.value}}` — dot-path from the data root, HTML-escaped;
 * - `{{{path}}}` — dot-path, unescaped;
 * - `{{#each array}}…{{/each}}` — iteration (`{{this}}`, `{{this.field}}`,
 *   `{{@index}}` inside);
 * - `{{#if path}}…{{else}}…{{/if}}` — truthiness branching;
 * - `{{join array ", "}}` — joins an array of strings/numbers.
 *
 * The data root is the tracker JSON itself (NOT wrapped).
 */
export const DEFAULT_TRACKER_HTML = `<div class="tracker-card">
  <div class="tracker-row"><span class="tracker-label">Location</span><span class="tracker-value">{{location}}</span></div>
  {{#if knownCast}}<div class="tracker-row"><span class="tracker-label">Known Cast</span><span class="tracker-value">{{join knownCast ", "}}</span></div>{{/if}}
  {{#each characters}}
  <details class="tracker-section tracker-character">
    <summary class="tracker-character-name">{{this.name}}{{#if this.pronouns}} · {{this.pronouns}}{{/if}}</summary>
    <div class="tracker-row"><span class="tracker-label">Outfit</span><span class="tracker-value">{{this.outfit}}</span></div>
    <div class="tracker-row"><span class="tracker-label">Posture</span><span class="tracker-value">{{this.posture}}</span></div>
    <div class="tracker-row"><span class="tracker-label">Wants</span><span class="tracker-value">{{this.wants}}</span></div>
    <div class="tracker-row"><span class="tracker-label">Knows</span><span class="tracker-value">{{this.knows}}</span></div>
    {{#if this.voice}}<div class="tracker-row"><span class="tracker-label">Voice</span><span class="tracker-value">{{this.voice}}</span></div>{{/if}}
  </details>
  {{/each}}
  {{#if offstage}}
  <details class="tracker-section tracker-offstage">
    <summary class="tracker-section-name">Off-stage</summary>
    {{#each offstage}}
    <div class="tracker-row"><span class="tracker-label">{{this.name}}{{#if this.pronouns}} ({{this.pronouns}}){{/if}}</span><span class="tracker-value">{{this.doing}}</span></div>
    {{/each}}
  </details>
  {{/if}}
  {{#if secrets}}
  <details class="tracker-section tracker-secrets">
    <summary class="tracker-section-name">Secrets</summary>
    {{#each secrets}}
    <details class="tracker-section tracker-secret">
      <summary class="tracker-secret-summary">
        <span class="tracker-secret-fact">{{this.fact}}</span>
      </summary>
      {{#if this.knows}}<div class="tracker-row"><span class="tracker-label">Knows</span><span class="tracker-value">{{join this.knows ", "}}</span></div>{{/if}}
      {{#if this.suspects}}<div class="tracker-row"><span class="tracker-label">Suspects</span><span class="tracker-value">{{join this.suspects ", "}}</span></div>{{/if}}
      {{#if this.misled}}<div class="tracker-row"><span class="tracker-label">Misled</span><span class="tracker-value">{{join this.misled ", "}}</span></div>{{/if}}
    </details>
    {{/each}}
  </details>
  {{/if}}
</div>`;

/** The default tracker stylesheet: game-UI flavored, no external assets. It
 *  reads the frame's theme-aware `--tf-*` palette (TemplateFrame derives it
 *  from the active theme's own tokens) with the dark values as fallbacks, so
 *  the card repaints to match whatever theme — dark or light — is active. */
export const DEFAULT_TRACKER_CSS = `.tracker-card {
  font: inherit;
  color: var(--tf-card-fg, #d8d5cd);
  background: var(--tf-card-bg, #15171d);
  border: 1px solid var(--tf-card-border, #2b2f3a);
  border-radius: 10px;
  padding: 14px 16px;
  margin: 0;
  display: grid;
  gap: 12px;
}

.tracker-section {
  border: 1px solid var(--tf-section-border, #262a34);
  border-radius: 6px;
  background: var(--tf-section-bg, #1b1e26);
  padding: 10px 12px;
}

.tracker-section + .tracker-section {
  border-top: 1px solid var(--tf-section-border, #262a34);
}

.tracker-scene {
  border-left: 3px solid var(--tf-scene-accent, #8a7a4f);
}

.tracker-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 0;
}

.tracker-label {
  color: var(--tf-label, #8b8fa3);
  font-size: 0.72em;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-align: right;
  white-space: nowrap;
}

.tracker-value {
  color: var(--tf-card-fg, #d8d5cd);
  text-align: left;
}

.tracker-topic {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tracker-topic > span {
  color: var(--tf-topic-fg, #c8b878);
  background: var(--tf-topic-bg, rgba(138, 122, 79, 0.12));
  border: 1px solid var(--tf-topic-border, rgba(138, 122, 79, 0.35));
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 0.78em;
  letter-spacing: 0.04em;
}

.tracker-character {
  border-left: 3px solid var(--tf-character-accent, #4f6a8a);
}

.tracker-offstage {
  border-left: 3px solid var(--tf-scene-accent, #8a7a4f);
}

.tracker-secrets {
  border-left: 3px solid var(--tf-topic-border, rgba(138, 122, 79, 0.35));
}

/* Inside the Secrets well each secret is a light list item, not another
   card — the outer block keeps the same weight as Off-stage. */
.tracker-secrets .tracker-secret {
  background: transparent;
  border: 0;
  border-radius: 0;
  padding: 2px 0;
}

.tracker-secrets .tracker-secret + .tracker-secret {
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--tf-section-border, #262a34);
}

.tracker-secret > summary {
  align-items: flex-start;
}

.tracker-secret > summary::before {
  margin-top: 3px;
}

.tracker-secret-fact {
  color: var(--tf-card-fg, #d8d5cd);
  font-size: 0.9em;
  line-height: 1.35;
  min-width: 0;
  overflow-wrap: anywhere;
}

.tracker-secret > summary:hover .tracker-secret-fact {
  color: var(--tf-topic-fg, #c8b878);
}

.tracker-character-name {
  color: var(--tf-character-name, #9fc2e8);
  font-size: 0.85em;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding-bottom: 6px;
  margin-bottom: 6px;
  border-bottom: 1px dashed var(--tf-card-border, #2b2f3a);
}

/* Collapsible sections (object fields and list-of-objects items): closed
   by default — the summary is the section's heading. */
.tracker-section > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  list-style: none;
  user-select: none;
}

.tracker-section > summary::-webkit-details-marker {
  display: none;
}

.tracker-section > summary:focus-visible {
  outline: 2px solid var(--tf-scene-accent, #8a7a4f);
  outline-offset: 2px;
  border-radius: 4px;
}

/* Caret: a small triangle that points right and rotates down when open. */
.tracker-section > summary::before {
  content: "";
  flex: none;
  width: 0;
  height: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid var(--tf-label, #8b8fa3);
  transition: transform 120ms ease-out;
}

.tracker-section[open] > summary::before {
  transform: rotate(90deg);
}

/* A closed section reads as a single header line — no bottom border. */
.tracker-section:not([open]) > summary {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}

/* Heading for object-field sections without a natural name. */
.tracker-section-name {
  color: var(--tf-section-name, #a9adc0);
  font-size: 0.78em;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/* Variables inside collapsible sections stack — small label on top, the
   value below it at full width. No left/right positioning (space-between
   pushed values to the right and squeezed long text); just breathing
   room between variables. */
details.tracker-section .tracker-row {
  display: block;
  padding: 4px 0;
}

details.tracker-section .tracker-label {
  display: block;
  margin: 0 0 2px;
  text-align: left;
  white-space: normal;
}

details.tracker-section .tracker-value {
  display: block;
}`;

/**
 * Mechanism-internal JSON prompt template (adapted from zTracker's prompt
 * engineering). `{{schema}}` and `{{example_response}}` are substituted with
 * `split`/`join` — deliberately no template engine dependency.
 */
export const TRACKER_JSON_PROMPT_TEMPLATE = `You are a highly specialized AI assistant. Your SOLE purpose is to generate a single, valid JSON object that strictly adheres to the provided JSON schema.

**CRITICAL INSTRUCTIONS:**
1.  You MUST wrap the entire JSON object in a markdown code block (\`\`\`json
...
\`\`\`).
2.  Your response MUST NOT contain any explanatory text, comments, or any other content outside of this single code block.
3.  The JSON object inside the code block MUST be valid and conform to the schema.

**JSON SCHEMA TO FOLLOW:**
\`\`\`json
{{schema}}
\`\`\`

**EXAMPLE OF A PERFECT RESPONSE:**
\`\`\`json
{{example_response}}
\`\`\``;
