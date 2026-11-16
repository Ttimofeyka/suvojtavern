/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { st } from "@suvoj/core";
import { Hono } from "hono";
import type { RouteDeps } from "../routes-deps";

/** ASCII-safe, quote-free download filename derived from an entity name. */
function downloadName(name: string, ext: string): string {
  const safe = name.replace(/[^\w.-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "") || "export";
  return `${safe}.${ext}`;
}

/** Download headers: `Content-Disposition: attachment` plus the media type. */
function download(
  filename: string,
  type: string,
): { "Content-Type": string; "Content-Disposition": string } {
  return {
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${filename}"`,
  };
}

/** BodyInit from core's Uint8Array returns (a plain Uint8Array won't typecheck). */
function responseBody(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

/**
 * SillyTavern export routes — card PNG/JSON, chat JSONL, lorebook JSON —
 * all delivered as attachment downloads with safe ASCII filenames.
 */
export function transferExportRoutes(deps: RouteDeps): Hono {
  const { repos } = deps;
  const app = new Hono();

  app.get("/api/export/card/:id", async (c) => {
    const id = c.req.param("id");
    const character = repos.characters.get(id);
    if (!character) {
      return c.json({ error: `character ${id} not found` }, 404);
    }
    if (c.req.query("format") === "json") {
      const json = JSON.stringify(st.exportCardJson(character), null, 2);
      return new Response(json, {
        headers: download(downloadName(character.name, "json"), "application/json"),
      });
    }
    // avatar_path is stored relative to the process working dir
    // ("data/blobs/<uuid>.webp"), so exportCardPng resolves it from ".".
    const png = await st.exportCardPng(character, { dataDir: "." });
    return new Response(responseBody(png), {
      headers: download(downloadName(character.name, "png"), "image/png"),
    });
  });

  app.get("/api/export/chat/:id", (c) => {
    const id = c.req.param("id");
    const chat = repos.chats.get(id);
    if (!chat) {
      return c.json({ error: `chat ${id} not found` }, 404);
    }
    // exportChat wants the full history (listAll — swipes included).
    const character = repos.characters.get(chat.character_id);
    const persona = chat.persona_id !== null ? repos.personas.get(chat.persona_id) : null;
    const jsonl = st.exportChat(repos.messages.listAll(chat.id), {
      userName: persona?.name ?? "User",
      characterName: character?.name,
    });
    const name = downloadName(chat.title ?? character?.name ?? "chat", "jsonl");
    return new Response(jsonl, {
      headers: download(name, "application/x-ndjson"),
    });
  });

  app.get("/api/export/lorebook/:id", (c) => {
    const id = c.req.param("id");
    const lorebook = repos.lorebooks.get(id);
    if (!lorebook) {
      return c.json({ error: `lorebook ${id} not found` }, 404);
    }
    const json = JSON.stringify(
      st.exportLorebook(lorebook, repos.lorebooks.listEntries(lorebook.id)),
      null,
      2,
    );
    return new Response(json, {
      headers: download(downloadName(lorebook.name, "json"), "application/json"),
    });
  });

  app.get("/api/export/preset/:id", (c) => {
    const id = c.req.param("id");
    const preset = repos.presets.get(id);
    if (!preset) {
      return c.json({ error: `preset ${id} not found` }, 404);
    }
    // exportPreset emits our native document (no id/timestamps) — the row is
    // passed whole and the exporter picks only the round-trippable payload.
    const json = JSON.stringify(st.exportPreset(preset), null, 2);
    return new Response(json, {
      headers: download(downloadName(preset.name, "json"), "application/json"),
    });
  });

  return app;
}
