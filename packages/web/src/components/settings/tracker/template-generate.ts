/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema → HTML template generation (Settings → Tracker's preset editor).
 *
 * The "Auto-generate from schema" action builds a starter HTML template
 * from the CURRENT edited schema, reusing the default template's class
 * vocabulary so the shipped/default CSS styles it out of the box:
 *
 * - root wrapper: `<div class="tracker-card">`;
 * - leaf field (string/number/boolean): one `.tracker-row` with a humanized
 *   `.tracker-label` and a `{{key}}` `.tracker-value`;
 * - object field: a collapsed `<details class="tracker-section">` headed
 *   by its humanized label as `.tracker-section-name`, wrapping a row per
 *   leaf property;
 * - array of strings: one row joined with `{{join key ", "}}`;
 * - array of objects: an `{{#each key}}` block of collapsed
 *   `.tracker-section.tracker-character` cards, headed by the first
 *   sub-field as `.tracker-character-name` in a `<summary>`.
 *
 * Anything else (deeper nesting, unknown shapes, malformed nodes) is
 * skipped — generation never throws and never invents fields.
 */

/** True for plain JSON objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The leaf types that render as a plain value row. */
function isLeafType(type: unknown): boolean {
  return type === "string" || type === "number" || type === "boolean";
}

/**
 * Humanizes a property key as a label: splits camelCase / underscores /
 * hyphens into words and capitalizes each ("charactersPresent" →
 * "Characters Present", "state_of_dress" → "State Of Dress").
 */
export function humanizeLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((word) => word !== "");
  if (words.length === 0) {
    return key;
  }
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/** One `.tracker-row` line for a leaf value. */
function rowLine(label: string, value: string, indent: string): string {
  return `${indent}<div class="tracker-row"><span class="tracker-label">${label}</span><span class="tracker-value">${value}</span></div>`;
}

/** One `<summary>` heading line opening a collapsible section. */
function summaryLine(className: string, text: string, indent: string): string {
  return `${indent}<summary class="${className}">${text}</summary>`;
}

/**
 * The leaf sub-properties of a group node (object properties or an
 * array-of-objects' item properties) in declaration order — deeper or
 * unknown shapes are skipped, never rendered.
 */
function leafSubEntries(properties: unknown): Array<[string, string]> {
  if (!isRecord(properties)) {
    return [];
  }
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(properties)) {
    if (isRecord(value) && isLeafType(value.type)) {
      out.push([key, value.type as string]);
    }
  }
  return out;
}

/** Emits the template lines for one top-level property. */
function fieldLines(key: string, value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const label = humanizeLabel(key);
  if (isLeafType(value.type)) {
    return [rowLine(label, `{{${key}}}`, "  ")];
  }
  if (value.type === "object") {
    const subs = leafSubEntries(value.properties);
    if (subs.length === 0) {
      return [];
    }
    return [
      '  <details class="tracker-section">',
      summaryLine("tracker-section-name", label, "    "),
      ...subs.map(([subKey]) => rowLine(humanizeLabel(subKey), `{{${key}.${subKey}}}`, "    ")),
      "  </details>",
    ];
  }
  if (value.type === "array") {
    const items = value.items;
    if (!isRecord(items)) {
      return [];
    }
    if (items.type === "string") {
      return [rowLine(label, `{{join ${key} ", "}}`, "  ")];
    }
    if (items.type === "object") {
      const subs = leafSubEntries(items.properties);
      const [head, ...rest] = subs;
      if (head === undefined) {
        return [];
      }
      const [firstKey] = head;
      return [
        `  {{#each ${key}}}`,
        '  <details class="tracker-section tracker-character">',
        summaryLine("tracker-character-name", `{{this.${firstKey}}}`, "    "),
        ...rest.map(([subKey]) => rowLine(humanizeLabel(subKey), `{{this.${subKey}}}`, "    ")),
        "  </details>",
        `  {{/each}}`,
      ];
    }
    return [];
  }
  return [];
}

/**
 * Generates an HTML template from a JSON schema. Works on the raw schema
 * (not just the form's supported subset): every renderable top-level
 * property contributes its block, anything unsupported is skipped.
 */
export function generateTemplateFromSchema(schema: Record<string, unknown>): string {
  const lines: string[] = ['<div class="tracker-card">'];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, value] of Object.entries(properties)) {
    lines.push(...fieldLines(key, value));
  }
  lines.push("</div>");
  return lines.join("\n");
}
