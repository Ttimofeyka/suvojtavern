/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Hono } from "hono";
import { z } from "zod";
import type { PluginHost } from "../plugins/host";
import { badRequest, parseJsonBody, type RouteDeps } from "../routes-deps";

/**
 * Plugin management API — the data surface the Settings UI renders (the
 * UI itself is a web-client concern):
 *
 * - `GET    /api/plugins` — every discovered plugin with enablement,
 *   settings schema + values, UI contributions, and load errors.
 * - `POST   /api/plugins/reload` — rescan the plugins folder (the reload
 *   button): new folders load, removed ones disappear, edited source
 *   re-imports.
 * - `PATCH  /api/plugins/:id` — `{ enabled: boolean }` toggles a plugin.
 * - `GET    /api/plugins/:id/settings` — effective settings.
 * - `PUT    /api/plugins/:id/settings` — replace stored settings
 *   (validated against the plugin's schema).
 * - `PUT    /api/plugins/:id/controls` — set the plugin's own control
 *   values (validated against its declared controls).
 * - `GET    /api/plugins/:id/tabs/:tabId/data?chatId=…` — one drawer
 *   tab's render envelope: the declared `htmlTemplate`/`css` plus the
 *   plugin's `onPanelData` hook result as `data`.
 */

const patchSchema = z.object({ enabled: z.boolean() });

const putSettingsSchema = z.object({ settings: z.record(z.string(), z.unknown()) });

/**
 * Body of `PUT /api/plugins/:id/controls`: a bare control id → option id map.
 * A focused route (rather than folding control values into the settings PUT)
 * because the two stores are separate keys — `plugin:<id>:settings` and
 * `plugin:<id>:control_values` — and a settings replace must not be able to
 * clear control choices (or vice versa). It also mirrors the preset route
 * (`PUT /api/presets/:id/controls`) so both surfaces read the same way.
 */
const putControlsSchema = z.object({ values: z.record(z.string(), z.string()) });

export function pluginsRoutes(deps: RouteDeps & { plugins: PluginHost }): Hono {
  const app = new Hono();

  app.get("/api/plugins", (c) => c.json({ plugins: deps.plugins.list() }));

  app.post("/api/plugins/reload", (c) => {
    deps.plugins.reloadAll();
    return c.json({ plugins: deps.plugins.list() });
  });

  app.patch("/api/plugins/:id", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(badRequest("Invalid JSON body"), 400);
    }
    const parsed = parseJsonBody(patchSchema, raw);
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const id = c.req.param("id");
    if (!deps.plugins.setEnabled(id, parsed.value.enabled)) {
      return c.json({ error: "Plugin not found" }, 404);
    }
    return c.json({ plugin: deps.plugins.list().find((plugin) => plugin.id === id) });
  });

  app.get("/api/plugins/:id/settings", (c) => {
    const id = c.req.param("id");
    if (!deps.plugins.has(id)) {
      return c.json({ error: "Plugin not found" }, 404);
    }
    return c.json({ settings: deps.plugins.getSettings(id) });
  });

  app.put("/api/plugins/:id/settings", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(badRequest("Invalid JSON body"), 400);
    }
    const parsed = parseJsonBody(putSettingsSchema, raw);
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const result = deps.plugins.putSettings(c.req.param("id"), parsed.value.settings);
    if (!result.ok) {
      return c.json(badRequest(result.error, result.details), result.status);
    }
    return c.json({ settings: result.settings });
  });

  /**
   * Sets the plugin's own control values. `values` maps a BARE control id to
   * one of that control's option ids; unknown controls/options are 400s with
   * per-key details. The response carries the plugin's fresh resolved values
   * so the web can update its state without a follow-up GET.
   */
  app.put("/api/plugins/:id/controls", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(badRequest("Invalid JSON body"), 400);
    }
    const parsed = parseJsonBody(putControlsSchema, raw);
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const result = deps.plugins.putControlValues(c.req.param("id"), parsed.value.values);
    if (!result.ok) {
      return c.json(badRequest(result.error, result.details), result.status);
    }
    return c.json({ control_values: result.controlValues });
  });

  // One drawer tab's render envelope: the host resolves plugin + tab + chat
  // (404s), runs the hook, and wraps its result with the tab's declared
  // template; a throwing hook surfaces as a 500 with its message — never a
  // stack trace.
  app.get("/api/plugins/:id/tabs/:tabId/data", async (c) => {
    const chatId = c.req.query("chatId");
    if (chatId === undefined || chatId === "") {
      return c.json(badRequest("Missing chatId query parameter"), 400);
    }
    try {
      const result = await deps.plugins.panelData(c.req.param("id"), c.req.param("tabId"), chatId);
      if (!result.ok) {
        return c.json({ error: result.error }, result.status);
      }
      return c.json(result.envelope);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Panel data failed" }, 500);
    }
  });

  return app;
}
