/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DEFAULT_TRACKER_CSS } from "../../tracker/defaults";
import type { Migration } from "../migrate";
import { stmt } from "../sql";

/**
 * 013 — repaint the persisted built-in tracker preset with the active theme.
 *
 * The tracker panel renders the ACTIVE preset's stored `css`, injected AFTER
 * the frame's `--tf-*` palette, so a preset that hardcodes its colors beats
 * the theme-aware palette by source order. The shipped `default` preset was
 * converted from hardcoded dark colors to the `--tf-*` tokens when the frame
 * learned to follow the theme, but the copy persisted in `tracker_config` at
 * first boot kept the old literals — leaving an existing install's tracker
 * dark under every light theme no matter how the panel was rebuilt.
 *
 * This rewrites that one preset's `css` to the current shipped default, and
 * only while it is still byte-identical to the stylesheet shipped before the
 * conversion. A preset the user edited (or any other preset) is left exactly
 * as it is: hand-written colors are meant to win.
 */

/**
 * The `default` preset's stylesheet exactly as it shipped before the
 * theme-aware conversion — a frozen historical copy, used ONLY as the
 * equality guard above. Never edit it to "fix" the constant: it must keep
 * matching the bytes stored by older installs or the migration stops firing.
 */
export const LEGACY_DEFAULT_TRACKER_CSS = `.tracker-card {
  font: inherit;
  color: #d8d5cd;
  background: #15171d;
  border: 1px solid #2b2f3a;
  border-radius: 10px;
  padding: 14px 16px;
  margin: 0;
  display: grid;
  gap: 12px;
}

.tracker-section {
  border: 1px solid #262a34;
  border-radius: 6px;
  background: #1b1e26;
  padding: 10px 12px;
}

.tracker-section + .tracker-section {
  border-top: 1px solid #262a34;
}

.tracker-scene {
  border-left: 3px solid #8a7a4f;
}

.tracker-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 0;
}

.tracker-label {
  color: #8b8fa3;
  font-size: 0.72em;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-align: right;
  white-space: nowrap;
}

.tracker-value {
  color: #d8d5cd;
  text-align: left;
}

.tracker-topic {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tracker-topic > span {
  color: #c8b878;
  background: rgba(138, 122, 79, 0.12);
  border: 1px solid rgba(138, 122, 79, 0.35);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 0.78em;
  letter-spacing: 0.04em;
}

.tracker-character {
  border-left: 3px solid #4f6a8a;
}

.tracker-character-name {
  color: #9fc2e8;
  font-size: 0.85em;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding-bottom: 6px;
  margin-bottom: 6px;
  border-bottom: 1px dashed #2b2f3a;
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

/* Caret: a small triangle that points right and rotates down when open. */
.tracker-section > summary::before {
  content: "";
  flex: none;
  width: 0;
  height: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid #8b8fa3;
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
  color: #a9adc0;
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

/** True for plain JSON objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const migration013ThemeAwareTrackerPresetCss: Migration = {
  id: 13,
  name: "theme_aware_tracker_preset_css",
  up: (db) => {
    const row = stmt<{ value: string }>(
      db,
      "SELECT value FROM settings WHERE key = 'tracker_config'",
    ).get();
    if (row === null) {
      return;
    }
    let config: unknown;
    try {
      config = JSON.parse(row.value);
    } catch {
      // A corrupt row is left to the app's own schema fallback: a migration
      // must never make startup throw.
      return;
    }
    const presets = isRecord(config) ? config.schema_presets : undefined;
    const preset = isRecord(presets) ? presets.default : undefined;
    if (!isRecord(preset) || preset.css !== LEGACY_DEFAULT_TRACKER_CSS) {
      // Absent, already theme-aware, or edited by hand — leave it alone.
      return;
    }
    stmt(db, "UPDATE settings SET value = ? WHERE key = 'tracker_config'").run(
      JSON.stringify({
        ...(config as Record<string, unknown>),
        schema_presets: {
          ...(presets as Record<string, unknown>),
          default: { ...preset, css: DEFAULT_TRACKER_CSS },
        },
      }),
    );
  },
};
