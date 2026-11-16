/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { createRepositories, wireSummaryCascade, wireTrackerCascade } from "@suvoj/core";
import { Hono } from "hono";
import { ZodError } from "zod";
import { type AccessConfig, basicAuth } from "./access";
import { createGateway, GatewayError, gatewayStatus } from "./gateway";
import { PluginHost, resolveDefaultPluginsDir } from "./plugins";
import { blobsRoutes } from "./routes/blobs";
import { characterGenerationRoutes } from "./routes/character-generation";
import { charactersRoutes } from "./routes/characters";
import { chatsRoutes } from "./routes/chats";
import { galleryRoutes } from "./routes/gallery";
import { generateRoutes } from "./routes/generate";
import { janitorRoutes } from "./routes/janitor";
import { lorebookGenerationRoutes } from "./routes/lorebook-generation";
import { lorebooksRoutes } from "./routes/lorebooks";
import { messagesRoutes } from "./routes/messages";
import { personasRoutes } from "./routes/personas";
import { pluginsRoutes } from "./routes/plugins";
import { presetsRoutes } from "./routes/presets";
import { profilesRoutes } from "./routes/profiles";
import { promptPreviewRoutes } from "./routes/prompt-preview";
import { regexRoutes } from "./routes/regex";
import { settingsRoutes } from "./routes/settings";
import { staticRoutes } from "./routes/static";
import { summariesRoutes } from "./routes/summaries";
import { trackerRoutes } from "./routes/tracker";
import { transferRoutes } from "./routes/transfer";
import { variablesRoutes } from "./routes/variables";
import type { JanitorBrowserHandle, RouteDeps } from "./routes-deps";

export interface CreateAppOptions {
  /** Fetch implementation for upstream calls (gateway, URL imports; tests stub this). */
  fetchImpl?: typeof fetch;
  /** Root directory for on-disk blobs; routes default to "data". */
  dataDir?: string;
  /**
   * Plugins root (one subfolder per plugin); defaults to the repo's
   * plugins/. Pass null to disable plugin discovery entirely (tests use
   * this to stay hermetic — no dependence on the real folder's contents).
   */
  pluginsDir?: string | null;
  /**
   * Basic-auth policy. When `requireAuth` is set, every request (including
   * /health) must present matching credentials; otherwise the app is open.
   */
  access?: AccessConfig;
  /**
   * JanitorAI browser engine. Tests inject a fake; otherwise the routes
   * construct a real one lazily (never at boot, so no Chrome process exists
   * until an import/login asks for it).
   */
  janitorBrowser?: JanitorBrowserHandle;
}

/**
 * Composes the whole server: the health check, every route module, and the
 * SPA fallback (mounted last, after /api and /blobs), plus the error
 * middleware that turns thrown errors into JSON bodies — never a stack
 * trace or raw error internals.
 */
export function createApp(db: Database, opts?: CreateAppOptions): Hono {
  const repos = createRepositories(db);
  // Deleting a covered message position takes its summaries (every level)
  // with it and un-hides what only those summaries were hiding — one
  // wiring at the composition root, on the default buses the PluginHost
  // below also listens on.
  wireSummaryCascade({ db, repos });
  // `tracker_snapshots.message_id` has no FK (migration 005), so deleting a
  // message would strand its snapshots — this wiring removes every deleted
  // row's snapshots, batched so a bulk delete is one pass. Same
  // composition-root reasoning as the summary cascade above.
  wireTrackerCascade({ repos });
  const gateway = createGateway({ repos, fetchImpl: opts?.fetchImpl });
  // Plugins load synchronously (Bun's require of ESM), so the first request
  // already sees them. A missing plugins/ folder simply means zero plugins —
  // and a broken plugin never takes the server down with it. An explicit
  // null opts out of discovery (undefined falls back to the default root).
  const plugins = new PluginHost({
    pluginsDir: opts?.pluginsDir === undefined ? resolveDefaultPluginsDir() : opts.pluginsDir,
    repos,
  });
  plugins.loadAll();
  const deps: RouteDeps & { plugins: PluginHost } = {
    repos,
    gateway,
    dataDir: opts?.dataDir,
    fetchImpl: opts?.fetchImpl,
    plugins,
    janitorBrowser: opts?.janitorBrowser,
  };

  const app = new Hono();

  // Gate everything before the first route is registered, so /health and the
  // SPA fallback are protected too — network exposure is opt-in via config.
  if (opts?.access?.requireAuth) {
    app.use("*", basicAuth(opts.access.username ?? "", opts.access.password ?? ""));
  }

  app.get("/health", (c) => c.json({ ok: true }));

  app.route("/", settingsRoutes(deps));
  app.route("/", variablesRoutes(deps));
  app.route("/", blobsRoutes(deps));
  app.route("/", charactersRoutes(deps));
  // A literal POST path (not a `/api/characters/:id` shape), so it never
  // collides with the characters CRUD routes regardless of mount order.
  app.route("/", characterGenerationRoutes(deps));
  // Also a literal POST path (not a `/api/lorebooks/:id` shape), so it never
  // collides with the lorebooks CRUD routes regardless of mount order.
  app.route("/", lorebookGenerationRoutes(deps));
  app.route("/", galleryRoutes(deps));
  app.route("/", personasRoutes(deps));
  app.route("/", lorebooksRoutes(deps));
  app.route("/", presetsRoutes(deps));
  app.route("/", profilesRoutes(deps));
  app.route("/", regexRoutes(deps));
  app.route("/", chatsRoutes(deps));
  app.route("/", messagesRoutes(deps));
  app.route("/", generateRoutes(deps));
  // Mounted before the SPA fallback like every API route; the path is distinct
  // from the generate/messages routes so registration order does not matter.
  app.route("/", promptPreviewRoutes(deps));
  app.route("/", summariesRoutes(deps));
  app.route("/", trackerRoutes(deps));
  app.route("/", pluginsRoutes(deps));
  app.route("/", transferRoutes(deps));
  // Native JanitorAI importer (its own browser engine); literal /api/janitor/*
  // paths, so it never collides with the transfer routes above.
  app.route("/", janitorRoutes(deps));
  // SPA fallback last: any GET missed by /api and /blobs serves the client.
  app.route("/", staticRoutes(deps));

  app.onError((err, c) => {
    if (err instanceof GatewayError) {
      return c.json({ error: err.message }, gatewayStatus(err));
    }
    if (err instanceof ZodError) {
      return c.json({ error: "Invalid request" }, 400);
    }
    return c.json({ error: "Internal error" }, 500);
  });

  return app;
}
