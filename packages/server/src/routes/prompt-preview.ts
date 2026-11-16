/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  SummariesRepository,
  Summary,
  SummaryInput,
  VariableScope,
  VariablesRepository,
} from "@suvoj/core";
import { engine, summaryInputSchema } from "@suvoj/core";
import { Hono } from "hono";
import { resolveActiveProfile } from "../profiles";
import type { RouteDeps } from "../routes-deps";

/**
 * Prompt inspector: `GET /api/chats/:id/prompt-preview` returns the prompt a
 * real generation would send — same pipeline, same preset resolution, same
 * profile samplers (so `context_size` / `max_tokens` and therefore the budget
 * match) — assembled WITHOUT any side effect.
 *
 * Prompt assembly is normally safe to run speculatively, with exactly three
 * exceptions. This route neutralises each one, and the tests prove it:
 *
 * 1. SUMMARIES WRITE. The `summaries` memory strategy's budget-pressure
 *    fallback calls `rollUp`, whose `SummariesRepository.create` INSERTS a
 *    level+1 row while the assembly is over budget (memory/summaries.ts).
 *    The strategy is handed a read-only view ({@link readOnlySummaries})
 *    whose `create` returns a correctly shaped row in memory: the loop sees
 *    it, covers its covered group and terminates identically, but nothing is
 *    persisted.
 *
 * 2. VARIABLES WRITE. `{{setvar}}` / `{{incvar}}` / `{{decvar}}` /
 *    `{{addvar}}` persist through the `variables` repository as macros
 *    evaluate (macros.ts) — and they must stay readable for the rest of the
 *    same text (ST's sequential substitution: `{{setvar::x::1}}{{getvar::x}}`
 *    renders "1"). {@link readOnlyVariables} keeps an in-memory overlay for
 *    those writes so reads stay faithful while the table is untouched.
 *
 * 3. TURN ADVANCEMENT. Sticky/cooldown/delay lorebook bookkeeping happens in
 *    `LorebookRunResult.commitTurn`, which `prepareGeneration` deliberately
 *    does NOT call — the caller does (only generate.ts, after the reply
 *    lands). This route simply never calls it.
 *
 * There is also no gateway/upstream call: the `summarizeFn` the summaries
 * strategy needs is a local passthrough (see {@link previewSummarize}), not
 * the real `makeSummarizeFn` bridge, and the summarizer connection profile is
 * therefore deliberately not resolved.
 */

/** Per-message chat-format overhead; mirrors the engine's private constant
 *  (engine/prompt.ts / engine/tokens.ts) — per-message counts are not part of
 *  `PreparedGeneration`, so the inspector recomputes them. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * The `summarizeFn` the summaries strategy needs to take its full, non-
 * degraded path (without one it early-returns the verbatim window and the
 * preview would not match a real send). A real run injects the gateway bridge
 * (`makeSummarizeFn`); the preview must not touch the network, so the merged
 * range text is returned verbatim. The strategy's STRUCTURE stays identical —
 * covered positions hide, snippets roll up, the budget maths and trimming are
 * the same — only the generated summary text differs (no model produced it).
 */
const previewSummarize = async (rangeText: string): Promise<string> => rangeText;

/**
 * Read-only `summaries` view for the memory strategy. The three read methods
 * delegate to the real repository; `create` returns a synthetic row carrying
 * the same shape as the repository's (`{ id, chat_id, level, seq_from,
 * seq_to, summary, tokens, created_at }`) WITHOUT inserting, so a roll-up is
 * visible to the assembly loop and its group is covered exactly as it would
 * be. No other member exists, so no write path can reach the database.
 *
 * The `unknown` cast is required because `SummariesRepository`'s private `db`
 * field makes it nominally typed; the structural object above is all the
 * strategy ever touches.
 */
function readOnlySummaries(repo: SummariesRepository): SummariesRepository {
  let synthetic = 0;
  return {
    list: (chatId: string) => repo.list(chatId),
    get: (id: string) => repo.get(id),
    listIntersecting: (chatId: string, seqs: number | readonly number[]) =>
      repo.listIntersecting(chatId, seqs),
    create: (chatId: string, input: SummaryInput): Summary => {
      // Same validation + shape as the repository, minus the INSERT.
      const data = summaryInputSchema.parse(input);
      synthetic += 1;
      return {
        id: `preview-summary-${synthetic}`,
        chat_id: chatId,
        ...data,
        created_at: new Date().toISOString(),
      };
    },
  } as unknown as SummariesRepository;
}

/**
 * Read-only `variables` view for macro evaluation. Reads (`get`/`list`) fall
 * through to the real repository; writes land in a per-request in-memory
 * overlay only. The overlay is what keeps ST semantics intact — a
 * `{{setvar}}` is visible to a later `{{getvar}}` in the same text — while a
 * stored value still reads back when nothing overrides it. `list` merges the
 * overlay over the stored pairs so a scoped dump is consistent too.
 */
function readOnlyVariables(repo: VariablesRepository): VariablesRepository {
  const overlay = new Map<string, unknown>();
  const keyOf = (scope: VariableScope, scopeId: string | null, key: string): string =>
    `${scope}\u0000${scope === "global" ? "" : (scopeId ?? "")}\u0000${key}`;
  const prefixOf = (scope: VariableScope, scopeId: string | null): string =>
    `${scope}\u0000${scope === "global" ? "" : (scopeId ?? "")}\u0000`;
  return {
    get: <T>(scope: VariableScope, scopeId: string | null, key: string): T | null => {
      const composite = keyOf(scope, scopeId, key);
      return (
        overlay.has(composite) ? overlay.get(composite) : repo.get<T>(scope, scopeId, key)
      ) as T | null;
    },
    set: <T>(scope: VariableScope, scopeId: string | null, key: string, value: T): void => {
      overlay.set(keyOf(scope, scopeId, key), value);
    },
    // Unreachable from prompt assembly (macros never delete); kept for the
    // shape and made write-free — a deletion only shadows the overlay.
    delete: (scope: VariableScope, scopeId: string | null, key: string): boolean => {
      overlay.delete(keyOf(scope, scopeId, key));
      return false;
    },
    list: (scope: VariableScope, scopeId: string | null): Record<string, unknown> => {
      const out = { ...repo.list(scope, scopeId) };
      const prefix = prefixOf(scope, scopeId);
      for (const [composite, value] of overlay) {
        if (composite.startsWith(prefix)) {
          out[composite.slice(prefix.length)] = value;
        }
      }
      return out;
    },
  } as unknown as VariablesRepository;
}

export function promptPreviewRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.get("/api/chats/:id/prompt-preview", async (c) => {
    const chatId = c.req.param("id");
    if (!deps.repos.chats.get(chatId)) {
      return c.json({ error: "Chat not found" }, 404);
    }

    // The active connection profile is the ONLY sampling source for a real
    // generation (and therefore the source of context_size / max_tokens that
    // drive both the memory budget and the final trim) — resolve it the same
    // way generate.ts does.
    const profile = resolveActiveProfile(deps.repos);

    // Assembly reaches exactly two write surfaces; replace them with the
    // read-only views above. Every other repository is read-only in this path
    // and can be shared as-is.
    const repos = {
      ...deps.repos,
      summaries: readOnlySummaries(deps.repos.summaries),
      variables: readOnlyVariables(deps.repos.variables),
    };

    const prepared = await engine.prepareGeneration({
      repos,
      chatId,
      // The inspector mirrors what the send button produces; that is a
      // `normal` generation (regenerate/continue are request flags the
      // preview has no input for). Explicit for parity with generate.ts.
      generationType: "normal",
      sampling: profile?.sampling,
      summarizeFn: previewSummarize,
      // Plugin controls, exactly as generate.ts supplies them — a preview must
      // reflect a plugin's control-dependent `{{ui:…}}` text/rewrite the same
      // way a real generation would.
      uiValues: deps.plugins?.mergedControlValues(),
    });

    // Plugins run between assembly and the gateway call, chaining message
    // arrays — the same hook generate.ts applies, so a preview reflects a
    // plugin's rewrite too. Identity is the rewrite signal, exactly as there:
    // `beforeGenerate` returns the input array untouched when no plugin
    // replaced it.
    const messages = deps.plugins
      ? deps.plugins.beforeGenerate({
          chat: prepared.chat,
          character: prepared.character,
          persona: prepared.persona,
          messages: prepared.messages,
          sampling: prepared.sampling,
          controls: deps.plugins.mergedControlValues(prepared.preset),
        })
      : prepared.messages;
    const pluginRewritten = messages !== prepared.messages;

    // A rewrite invalidates the assembly's token counts; recount the same way
    // generate.ts does, recovering the context reservation from the original
    // budget (`context − max_tokens` is preserved by the recount).
    let { tokenCount, budget } = prepared;
    if (pluginRewritten) {
      const total = prepared.budget.used + prepared.budget.remaining;
      tokenCount = engine.countMessagesTokens(messages);
      budget = {
        context: prepared.budget.context,
        used: tokenCount,
        remaining: total - tokenCount,
      };
    }

    return c.json({
      messages: messages.map((message) => ({
        role: message.role,
        ...(message.name === undefined ? {} : { name: message.name }),
        content: message.content,
        tokens: engine.countTokens(message.content) + MESSAGE_OVERHEAD_TOKENS,
      })),
      tokenCount,
      budget,
      ...(prepared.summary ? { summary: prepared.summary } : {}),
      // `PreparedGeneration.lorebook` is a `LorebookRunResult`: its
      // `activatedIds` Set is not JSON-able and its `commitTurn` closure has
      // no place in a response, so only the activations cross the wire — the
      // shape the inspector needs.
      lorebook: prepared.lorebook ? { activations: prepared.lorebook.activations } : null,
      plugin_rewritten: pluginRewritten,
    });
  });

  return app;
}
