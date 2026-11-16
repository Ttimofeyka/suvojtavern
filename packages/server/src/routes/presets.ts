/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { engine, presetInputSchema } from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import type { RouteDeps } from "../routes-deps";
import { badRequest, parseJsonBody } from "../routes-deps";

/**
 * PATCH /api/presets/:id accepts any subset of the create fields; absent
 * fields are left untouched. A patched `prompts`/`settings` replaces the
 * whole stored JSON — `prompts` array order IS the layout.
 */
const presetPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  prompts: z.array(z.record(z.string(), z.unknown())).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

/**
 * PUT /api/presets/:id/controls body. `values` maps a control id to one of
 * that control's option ids; the route validates both halves against the
 * preset's declared controls before anything is stored.
 */
const presetControlsSchema = z.object({
  values: z.record(z.string(), z.string()),
});

/** Plain-object guard for the raw JSON settings blob. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Preset CRUD — /api/presets. */
export function presetsRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.post("/api/presets", async (c) => {
    const parsed = parseJsonBody(presetInputSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    return c.json(deps.repos.presets.create(parsed.value), 201);
  });

  app.get("/api/presets", (c) => c.json(deps.repos.presets.list()));

  app.get("/api/presets/:id", (c) => {
    const preset = deps.repos.presets.get(c.req.param("id"));
    if (!preset) {
      return c.json({ error: "preset not found" }, 404);
    }
    return c.json(preset);
  });

  app.patch("/api/presets/:id", async (c) => {
    const parsed = parseJsonBody(presetPatchSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const updated = deps.repos.presets.update(c.req.param("id"), parsed.value);
    if (!updated) {
      return c.json({ error: "preset not found" }, 404);
    }
    return c.json(updated);
  });

  /**
   * Sets the preset's UI-control choices. Only the given keys change: the
   * whole `settings` object is read raw and spread back, so every other key
   * (memory wiring, engine settings, future plugin state) survives. The
   * choice is then materialized onto the governed prompt rows — the
   * repository normalizes their stored `enabled` flags to match the chosen
   * option, so stored state, the editor and generation always agree.
   */
  app.put("/api/presets/:id/controls", async (c) => {
    const preset = deps.repos.presets.get(c.req.param("id"));
    if (!preset) {
      return c.json({ error: "preset not found" }, 404);
    }
    const parsed = parseJsonBody(presetControlsSchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }

    // The preset's own declared controls are the authority. `parseControls`
    // tolerates a hand-edited row, so a control the engine would drop is not
    // selectable here either. Plugin-contributed controls arrive in phase 3
    // as `plugin:<pluginId>:<controlId>` ids — they are accepted (and would
    // be validated by the plugin host) only when this preset declares a
    // control with exactly that id, which keeps the route honest until then.
    const controls = engine.parseControls(preset.settings.controls);
    for (const [key, value] of Object.entries(parsed.value.values)) {
      const control = controls.find((candidate) => candidate.id === key);
      if (!control) {
        return c.json(badRequest(`Unknown control "${key}"`, { control: key }), 400);
      }
      if (!control.options.some((option) => option.id === value)) {
        return c.json(
          badRequest(`Unknown option "${value}" for control "${key}"`, { control: key, value }),
          400,
        );
      }
    }

    // Merge over the RAW stored settings so nothing else is dropped; a
    // malformed/stale `control_values` (non-object) is replaced outright. The
    // base itself is guarded too: `toPreset` parses the `settings` column
    // without an object check, so a hand-edited row can hold a JSON string or
    // array — spreading that would produce index-keyed junk ("oops" →
    // {"0":"o","1":"o"}) and silently replace everything the user had.
    const base = isRecord(preset.settings) ? preset.settings : {};
    const existingValues = isRecord(base.control_values) ? base.control_values : {};
    const settings: Record<string, unknown> = {
      ...base,
      control_values: { ...existingValues, ...parsed.value.values },
    };
    const updated = deps.repos.presets.update(preset.id, { settings });
    if (!updated) {
      // Deleted between the read above and the write.
      return c.json({ error: "preset not found" }, 404);
    }
    // Observation only, and AFTER the write succeeded: fire `onControlChange`
    // for each changed bare control id. The write is already durable, so a
    // missing host, a host-level throw, or a throwing plugin handler must
    // never turn this into an error response — the host isolates its own hook
    // throws, and the guard here makes the contract explicit for a host that
    // is absent or misbehaving (routes composed without plugins).
    if (deps.plugins) {
      try {
        const values = deps.plugins.mergedControlValues(engine.fromStoredPreset(updated));
        for (const [controlId, value] of Object.entries(parsed.value.values)) {
          deps.plugins.controlChanged({
            source: "preset",
            ownerId: updated.id,
            controlId,
            value,
            values,
          });
        }
      } catch (err) {
        console.error(`[presets] control-change notification failed for ${updated.id}:`, err);
      }
    }
    // The response carries the governed rows too, not just the map: the write
    // materialized the choice onto their stored `enabled` flags, and the
    // Presets view opens the editor from its cached row — a stale cache would
    // render the pre-flip switches. `updated` is the post-write row.
    return c.json({ control_values: updated.settings.control_values, prompts: updated.prompts });
  });

  app.delete("/api/presets/:id", (c) => {
    if (!deps.repos.presets.delete(c.req.param("id"))) {
      return c.json({ error: "preset not found" }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}
