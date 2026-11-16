/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { badRequest, parseJsonBody, type RouteDeps } from "../routes-deps";

/** Variable values are arbitrary JSON (macros like {{setvar}} store any shape). */
const variableValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

const putVariableSchema = z.object({ value: variableValue });

/** Parses the JSON body with `schema`, or builds the 400 response for a bad one. */
async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(badRequest("Invalid JSON body"), 400);
  }
  const parsed = parseJsonBody(schema, raw);
  return parsed.ok ? parsed.value : c.json(parsed.error, 400);
}

/** The 404 response when the chat id is unknown, or `null` when it exists. */
function requireChat(c: Context, deps: RouteDeps): Response | null {
  const id = c.req.param("id") ?? "";
  return deps.repos.chats.get(id) === null ? c.json({ error: "Chat not found" }, 404) : null;
}

export function variablesRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  // --- global scope ---

  app.get("/api/variables", (c) => c.json(deps.repos.variables.list("global", null)));

  app.get("/api/variables/:key", (c) => {
    const value = deps.repos.variables.get("global", null, c.req.param("key"));
    if (value === null) {
      return c.json({ error: "Variable not set" }, 404);
    }
    return c.json({ value });
  });

  app.put("/api/variables/:key", async (c) => {
    const body = await parseBody(c, putVariableSchema);
    if (body instanceof Response) {
      return body;
    }
    deps.repos.variables.set("global", null, c.req.param("key"), body.value);
    return c.json({ ok: true });
  });

  app.delete("/api/variables/:key", (c) => {
    deps.repos.variables.delete("global", null, c.req.param("key"));
    return c.json({ ok: true });
  });

  // --- chat scope ---

  app.get("/api/chats/:id/variables", (c) => {
    const notFound = requireChat(c, deps);
    if (notFound !== null) {
      return notFound;
    }
    return c.json(deps.repos.variables.list("chat", c.req.param("id")));
  });

  app.get("/api/chats/:id/variables/:key", (c) => {
    const notFound = requireChat(c, deps);
    if (notFound !== null) {
      return notFound;
    }
    const value = deps.repos.variables.get("chat", c.req.param("id"), c.req.param("key"));
    if (value === null) {
      return c.json({ error: "Variable not set" }, 404);
    }
    return c.json({ value });
  });

  app.put("/api/chats/:id/variables/:key", async (c) => {
    const notFound = requireChat(c, deps);
    if (notFound !== null) {
      return notFound;
    }
    const body = await parseBody(c, putVariableSchema);
    if (body instanceof Response) {
      return body;
    }
    deps.repos.variables.set("chat", c.req.param("id"), c.req.param("key"), body.value);
    return c.json({ ok: true });
  });

  app.delete("/api/chats/:id/variables/:key", (c) => {
    const notFound = requireChat(c, deps);
    if (notFound !== null) {
      return notFound;
    }
    deps.repos.variables.delete("chat", c.req.param("id"), c.req.param("key"));
    return c.json({ ok: true });
  });

  return app;
}
