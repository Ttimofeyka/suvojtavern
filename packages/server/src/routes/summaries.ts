/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  applySummaryClear,
  engine,
  type Summary,
  summaryEvents,
  summaryInputSchema,
} from "@suvoj/core";
import { Hono } from "hono";
import { z } from "zod";
import { GatewayError, gatewayStatus, resolveEndpoint } from "../gateway";
import { resolveSummarizerProfile } from "../profiles";
import type { RouteDeps } from "../routes-deps";
import { badRequest, parseJsonBody } from "../routes-deps";
import { summariesConfigFor, summarizeUncovered } from "./generate-summaries";

const summarizeBodySchema = z.object({
  preset_id: z.string().optional(),
});

/** Max rows accepted by the import route (a sanity cap against runaway payloads). */
const IMPORT_ROW_CAP = 5000;

/** A stored summary plus the derived cost of the messages it replaces. */
type SummaryWithSource = Summary & { source_tokens: number };

/**
 * Adds the derived `source_tokens` every summaries response carries: the
 * content cost of the ACTIVE messages the row's range covers. It is computed
 * on read and never stored, and it is the left side of the UI's
 * "source → summary tokens" comparison (how much raw text the summary
 * replaced). Higher-level rows still span raw message positions, so the same
 * range rule applies to them. A stored null token count (an imported row) is
 * filled from the summary text, so both sides of the comparison always exist.
 */
function withSourceTokens(
  repos: RouteDeps["repos"],
  chatId: string,
  rows: readonly Summary[],
): SummaryWithSource[] {
  if (rows.length === 0) {
    return [];
  }
  const tokensBySeq = new Map<number, number>();
  let maxSeq = 0;
  for (const message of repos.messages.listActive(chatId)) {
    tokensBySeq.set(message.seq, engine.countTokens(message.content));
    if (message.seq > maxSeq) {
      maxSeq = message.seq;
    }
  }
  // prefix[seq] = tokens of every active message at positions <= seq.
  const prefix: number[] = new Array(maxSeq + 1).fill(0);
  for (let seq = 1; seq <= maxSeq; seq++) {
    prefix[seq] = (prefix[seq - 1] ?? 0) + (tokensBySeq.get(seq) ?? 0);
  }
  return rows.map((row) => {
    const to = Math.min(row.seq_to, maxSeq);
    const source = to < row.seq_from ? 0 : (prefix[to] ?? 0) - (prefix[row.seq_from - 1] ?? 0);
    return {
      ...row,
      tokens: row.tokens ?? engine.countTokens(row.summary),
      source_tokens: source,
    };
  });
}

/**
 * Import row: the core summary input plus the range sanity check
 * (`seq_from` <= `seq_to`) the storage schema itself does not enforce.
 */
const importSummarySchema = summaryInputSchema.superRefine((row, ctx) => {
  if (row.seq_from > row.seq_to) {
    ctx.addIssue({
      code: "custom",
      path: ["seq_from"],
      message: "seq_from must be <= seq_to",
    });
  }
});

const importBodySchema = z.object({
  summaries: z.array(importSummarySchema).max(IMPORT_ROW_CAP),
});

export function summariesRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/api/chats/:id/summaries", (c) => {
    const chatId = c.req.param("id");
    if (!deps.repos.chats.get(chatId)) {
      return c.json({ error: "Chat not found" }, 404);
    }
    return c.json(withSourceTokens(deps.repos, chatId, deps.repos.summaries.list(chatId)));
  });

  /**
   * Summaries export: a versioned JSON snapshot of every summary row of
   * the chat, in the repository list order (level, then range) — the exact
   * shape the import route replaces the chat's summaries with. The derived
   * `source_tokens` rides along for tooling; the import strips unknown
   * fields, so the envelope round-trips unchanged.
   */
  app.get("/api/chats/:id/summaries/export", (c) => {
    const chatId = c.req.param("id");
    if (!deps.repos.chats.get(chatId)) {
      return c.json({ error: "Chat not found" }, 404);
    }
    return c.json({
      version: 1 as const,
      chat_id: chatId,
      exported_at: new Date().toISOString(),
      summaries: withSourceTokens(deps.repos, chatId, deps.repos.summaries.list(chatId)),
    });
  });

  /**
   * Summaries import: REPLACES every existing summary of the chat with the
   * body's rows (ids regenerate — imported ids are ignored) in one
   * transactional swap (a failure midway leaves the stored rows untouched),
   * then emits one summary-lifecycle event carrying the created and
   * deleted rows (an import never unhides messages: `unhiddenSeqs` is
   * always empty).
   */
  app.post("/api/chats/:id/summaries/import", async (c) => {
    const chatId = c.req.param("id");
    if (!deps.repos.chats.get(chatId)) {
      return c.json({ error: "Chat not found" }, 404);
    }
    const parsed = parseJsonBody(importBodySchema, await c.req.json().catch(() => undefined));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const { deleted, created } = deps.repos.summaries.replaceChatSummaries(
      chatId,
      parsed.value.summaries,
    );
    // Emitted only after the replace committed.
    if (created.length > 0 || deleted.length > 0) {
      summaryEvents.emit({ chatId, created, deleted, unhiddenSeqs: [] });
    }
    return c.json(withSourceTokens(deps.repos, chatId, created));
  });

  /**
   * Clear-all: deletes EVERY summary of the chat in one repository
   * transaction and emits one summary-lifecycle event carrying the removed
   * rows plus the positions they were hiding. The unhide set is recomputed
   * here (not via the message-deletion cascade) because plugins observe
   * this lifecycle event directly: a client-side "clear summaries" is a
   * coverage change, not a message change, so nothing else would tell them
   * which positions returned to the live window. A chat with no summaries
   * deleted nothing and emits no event; the response is still `ok`.
   */
  app.delete("/api/chats/:id/summaries", (c) => {
    const chatId = c.req.param("id");
    if (!deps.repos.chats.get(chatId)) {
      return c.json({ error: "Chat not found" }, 404);
    }
    const event = applySummaryClear({ repos: deps.repos }, chatId);
    return c.json({
      ok: true,
      deleted: event?.deleted ?? [],
      unhidden_seqs: event?.unhiddenSeqs ?? [],
    });
  });

  /** Edit body: text only — a summary's level and range are never editable. */
  const editSummarySchema = z.object({ summary: z.string() });

  /**
   * Summary edit: rewrites the stored TEXT (and its token count) of one
   * row. This changes no coverage — the range and level stay fixed — so no
   * summary-lifecycle event is emitted and no message is unhidden; only the
   * rendered block's text and its budget move. A summary id from another
   * chat is a 404, never a cross-chat edit.
   */
  app.patch("/api/chats/:id/summaries/:summaryId", async (c) => {
    const chatId = c.req.param("id");
    if (!deps.repos.chats.get(chatId)) {
      return c.json({ error: "Chat not found" }, 404);
    }
    const current = deps.repos.summaries.get(c.req.param("summaryId"));
    if (!current || current.chat_id !== chatId) {
      return c.json({ error: "Summary not found" }, 404);
    }
    const parsed = parseJsonBody(editSummarySchema, await c.req.json().catch(() => null));
    if (!parsed.ok) {
      return c.json(parsed.error, 400);
    }
    const summary = parsed.value.summary;
    const updated = deps.repos.summaries.update(current.id, {
      summary,
      tokens: engine.countTokens(summary),
    });
    return c.json(
      withSourceTokens(deps.repos, chatId, updated === null ? [] : [updated])[0] ?? null,
    );
  });

  app.post("/api/chats/:id/summarize", async (c) => {
    const chatId = c.req.param("id");
    if (!deps.repos.chats.get(chatId)) {
      return c.json({ error: "Chat not found" }, 404);
    }
    // Body is optional: `{ preset_id?: string }`, empty body allowed.
    let raw: unknown = {};
    const text = await c.req.text().catch(() => "");
    if (text.trim() !== "") {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json(badRequest("Invalid JSON body"), 400);
      }
    }
    const body = parseJsonBody(summarizeBodySchema, raw);
    if (!body.ok) {
      return c.json(body.error, 400);
    }
    if (body.value.preset_id !== undefined && !deps.repos.presets.get(body.value.preset_id)) {
      return c.json({ error: "Preset not found" }, 404);
    }

    try {
      const config = summariesConfigFor(deps.repos, body.value.preset_id);
      // The summarizer model runs through its own connection profile —
      // the config's `profile_id`, else the default profile. Unlike the
      // post-response step, the manual route also covers a pending
      // partial chunk (`fullOnly: false`). The request signal flows
      // through so a client disconnect aborts the gateway calls.
      const profile = resolveSummarizerProfile(deps.repos, config.profile_id);
      const endpoint = profile ? await resolveEndpoint(deps.repos, profile) : undefined;
      const created = await summarizeUncovered(deps.repos, deps.gateway, chatId, config, {
        profile,
        endpoint,
        signal: c.req.raw.signal,
      });
      return c.json(withSourceTokens(deps.repos, chatId, created));
    } catch (err) {
      // A GatewayError keeps its own client-visible status (the 400 for an
      // unconfigured profile) and is a 502 only when upstream-shaped; anything
      // else is a plain 500 with its message. Never a stack trace.
      if (err instanceof GatewayError) {
        return c.json({ error: err.message }, gatewayStatus(err));
      }
      return c.json({ error: err instanceof Error ? err.message : "Summarization failed" }, 500);
    }
  });

  return app;
}
