/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { engine, type Profile, tracker } from "@suvoj/core";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import { type Endpoint, GatewayError, resolveEndpoint } from "../gateway";
import { causeChain } from "../gateway-shared";
import { resolveActiveProfile, resolveSummarizerProfile } from "../profiles";
import type { RouteDeps } from "../routes-deps";
import { badRequest, parseJsonBody } from "../routes-deps";
import { encodeSseEvent } from "../sse";
import { generateTrackerSnapshot, trackerSnapshotDTO } from "../tracker/service";
import type { PersistMode } from "./generate-helpers";
import { makeSummarizeFn, persistAssistantMessage } from "./generate-helpers";
import { hasSummarizationWork, summariesConfigFor, summarizeUncovered } from "./generate-summaries";

const generateBodySchema = z.object({
  preset_id: z.string().optional(),
  persona_id: z.string().optional(),
  /** Request a new swipe of the last assistant message (regenerate). */
  regenerate: z.boolean().optional(),
  /** Extend the last assistant message in place (continue). */
  continue: z.boolean().optional(),
});

/** Error text for the SSE error event — never a stack trace. A GatewayError
 *  appends its detail line; other errors append their cause chain when it
 *  adds information the message alone lacks. */
function errorMessage(err: unknown): string {
  if (err instanceof GatewayError) {
    return err.detail ? `${err.message} — ${err.detail}` : err.message;
  }
  if (err instanceof Error && err.message !== "") {
    const chain = causeChain(err);
    return chain !== "" && chain !== err.message ? `${err.message}: ${chain}` : err.message;
  }
  return "Generation failed";
}

/**
 * A memoized, lazy endpoint resolver for an OPTIONAL background caller.
 *
 * `resolveEndpoint` throws a clean 400 for a profile with an empty `base_url`
 * (the seeded default profile's shape). Resolving that eagerly during the
 * "preparing" stage would abort even a plain generation that never summarizes,
 * so this defers the resolution (and its throw) until a call actually needs the
 * endpoint. The promise is cached so repeated resolutions share one
 * `getSecret` read; a `null` profile resolves to `undefined`.
 */
function lazyEndpoint(
  repos: RouteDeps["repos"],
  profile: Profile | null,
): () => Promise<Endpoint | undefined> {
  let pending: Promise<Endpoint> | undefined;
  return () => {
    if (!profile) {
      return Promise.resolve(undefined);
    }
    pending ??= resolveEndpoint(repos, profile);
    return pending;
  };
}

export function generateRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  app.post("/api/chats/:id/generate", async (c) => {
    // Body is optional (all fields default); malformed JSON still 400s.
    let raw: unknown = {};
    const text = await c.req.text().catch(() => "");
    if (text.trim() !== "") {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json(badRequest("Invalid JSON body"), 400);
      }
    }
    const body = parseJsonBody(generateBodySchema, raw);
    if (!body.ok) {
      return c.json(body.error, 400);
    }
    const chatId = c.req.param("id");
    if (!deps.repos.chats.get(chatId)) {
      return c.json({ error: "Chat not found" }, 404);
    }

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    return stream(c, async (s) => {
      const signal = c.req.raw.signal;
      // Hoisted out of the try so the catch below can log which model the
      // failed run used (null until resolveActiveProfile runs).
      let profile: Profile | null = null;
      // Belt to the idleTimeout raise in index.ts: comment-only pings keep the
      // connection alive through arbitrarily long silences. Clients ignore
      // non-`data:` lines, and s.write never rejects (Hono swallows errors), so
      // the fire-and-forget write is safe.
      const heartbeat = setInterval(() => {
        void s.write(": ping\n\n");
      }, 15_000);
      // One auto-mode tracker generation: runs the service and emits the
      // `tracker` event — `ok: true` with the fresh snapshot + rendering, or
      // `ok: false` with the error message. `messageId` names the swipe the
      // snapshot attaches to; `null` (the before_reply/manual case) lets the
      // service resolve the CURRENT tail's active message. after_reply passes
      // the persisted reply's id.
      // The `tracking` status is the CALLER's job (see the parallel tail
      // below): it is written before the work starts so the event order never
      // depends on which concurrent step finishes first. A tracker failure
      // NEVER breaks the main generation stream (the heartbeat keeps covering
      // it); a client disconnect ends silently.
      const runTracker = async (messageId: string | null): Promise<void> => {
        try {
          const result = await generateTrackerSnapshot(deps, chatId, {
            signal,
            message_id: messageId,
          });
          await s.write(
            encodeSseEvent({
              type: "tracker",
              ok: true,
              snapshot: trackerSnapshotDTO(result.snapshot),
              render: result.render,
            }),
          );
        } catch (err) {
          // Client disconnect during tracking: end like any other abort
          // (the client is gone — nothing left to tell).
          if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
            return;
          }
          console.error(`[generate] tracker generation failed for chat ${chatId}:`, err);
          await s.write(encodeSseEvent({ type: "tracker", ok: false, error: errorMessage(err) }));
        }
      };

      /** Status event + `runTracker` — the before_reply path. */
      const emitTracker = async (messageId: string | null): Promise<void> => {
        await s.write(encodeSseEvent({ type: "status", stage: "tracking" }));
        await runTracker(messageId);
      };
      try {
        try {
          await s.write(encodeSseEvent({ type: "status", stage: "preparing" }));

          // The active connection profile decides model + samplers; without
          // one the resolved sampling is empty and the gateway call fails
          // cleanly (no endpoint, no model).
          profile = resolveActiveProfile(deps.repos);
          // The profile's endpoint (its own base URL + optional key) —
          // resolved once and reused by every main generation call below so a
          // custom endpoint actually takes effect.
          const endpoint = profile ? await resolveEndpoint(deps.repos, profile) : undefined;
          // Summarization runs through its OWN connection profile — the
          // summaries config's `profile_id` (the default profile when absent
          // or unknown), never the active chat profile. Both the assembly-time
          // roll-ups and the post-response step below share it (and its endpoint).
          // The endpoint is resolved LAZILY: the summarizer profile is optional
          // (never used by a non-summaries strategy) and the seeded default it
          // can fall back to has an empty `base_url`, so resolving here would
          // abort even a plain reply with a 400.
          const summariesConfig = summariesConfigFor(deps.repos, body.value.preset_id);
          const summarizeProfile = resolveSummarizerProfile(deps.repos, summariesConfig.profile_id);
          const summarizeEndpoint = lazyEndpoint(deps.repos, summarizeProfile);
          const trackerConfig = tracker.getTrackerConfig(deps.repos);
          // The per-chat switch rides alongside the global config: both must be
          // on for the auto modes to run. Read once here so before_reply and
          // after_reply can never disagree.
          const trackerOnForChat = tracker.isTrackerEnabledForChat(deps.repos, chatId);
          // The global regex rules the reply will be run through when it is
          // persisted — resolved (and compiled) once per generation, the same
          // way prompt assembly resolves its own copy. `active` is false when
          // no enabled rule targets `ai`, in which case persistence stays
          // byte-identical to the pre-regex behaviour.
          const regexRules = engine.compileRegexRules(engine.getRegexRules(deps.repos));
          const aiRegexActive = engine.hasRulesFor(regexRules, "ai");
          // before_reply: the snapshot lands BEFORE prompt assembly, so
          // the pipeline's tracker stage injects the fresh state into this
          // very prompt. A null target attaches it to the current tail's
          // active message (the latest user turn the service resolves) — the
          // reply it precedes does not exist yet. A failure never breaks the
          // stream — it surfaces as a `tracker` {ok:false} event and the
          // reply proceeds. `trackerOnForChat` folds in the per-chat switch.
          if (trackerOnForChat && trackerConfig.auto_mode === "before_reply") {
            await emitTracker(null);
          }
          const prepared = await engine.prepareGeneration({
            repos: deps.repos,
            chatId,
            presetId: body.value.preset_id,
            personaId: body.value.persona_id,
            // ST `injection_trigger` type for this run. Regenerate wins when
            // both flags are set, matching the persistence precedence below.
            // Swipes are regenerates in Suvoj, so `regenerate` covers them.
            generationType:
              body.value.regenerate === true
                ? "regenerate"
                : body.value.continue === true
                  ? "continue"
                  : "normal",
            sampling: profile?.sampling,
            summarizeFn: makeSummarizeFn(deps.gateway, {
              signal,
              profile: summarizeProfile,
              endpoint: summarizeEndpoint,
            }),
            // Plugin-contributed controls (namespaced `plugin:<id>:<control>`)
            // merge OVER the preset's own — the engine maps both into
            // `{{ui:…}}`. The preset half is resolved inside
            // `prepareGeneration`; here we only supply the plugin half, and
            // an absent host means no plugin contributions.
            uiValues: deps.plugins?.mergedControlValues(),
          });

          // Plugins run between assembly and the gateway call, chaining
          // message arrays (a returned array replaces the prompt for every
          // later plugin AND the model). A throwing plugin is logged and
          // skipped — generation never fails because of a plugin.
          const messages = deps.plugins
            ? deps.plugins.beforeGenerate({
                chat: prepared.chat,
                character: prepared.character,
                persona: prepared.persona,
                messages: prepared.messages,
                sampling: prepared.sampling,
                // The FULL resolved map (preset + plugin controls) the hook
                // observes — `mergedControlValues` with the just-loaded preset
                // so a plugin sees values consistent with what the prompt
                // macro-rendered.
                controls: deps.plugins.mergedControlValues(prepared.preset),
              })
            : prepared.messages;

          // The status event fires after the hook and retells the truth
          // when a plugin rewrote the messages (token counts recounted;
          // the context reservation is recovered from the original budget).
          let { tokenCount, budget } = prepared;
          if (messages !== prepared.messages) {
            const total = prepared.budget.used + prepared.budget.remaining;
            tokenCount = engine.countMessagesTokens(messages);
            budget = {
              context: prepared.budget.context,
              used: tokenCount,
              remaining: total - tokenCount,
            };
          }
          await s.write(
            encodeSseEvent({
              type: "status",
              stage: "prompt",
              tokenCount,
              budget,
              summary: prepared.summary,
            }),
          );

          // Delta/reasoning events fire in call order; the stream writer
          // serializes queued writes, so fire-and-forget preserves ordering.
          // An empty profile model reaches the gateway as undefined and fails
          // cleanly. onDelta plugins observe the chunks but cannot modify them
          // (observation only).
          const completion = await deps.gateway.chatCompletion(
            messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
            prepared.sampling,
            {
              model: profile?.model || undefined,
              endpoint,
              signal,
              onDelta: (content) => {
                deps.plugins?.delta({ chatId, content });
                void s.write(encodeSseEvent({ type: "delta", content }));
              },
              onReasoning: (content) => {
                void s.write(encodeSseEvent({ type: "reasoning", content }));
              },
            },
          );

          // Success only: persist the reply (or add a swipe when
          // regenerating), advance the lorebook turn state
          // (sticky/cooldown/delay — a no-op without a lorebook). Captured
          // thinking rides on the row as metadata — absent when the model
          // produced none, never empty strings/zeros.
          const metadata: Record<string, unknown> | undefined = completion.reasoning
            ? { reasoning: completion.reasoning }
            : undefined;
          if (metadata && completion.reasoningDurationMs !== undefined) {
            metadata.reasoning_duration_ms = completion.reasoningDurationMs;
          }
          // Plugins get the final word: a returned string replaces the
          // content that is persisted AND sent in the `done` event. The
          // reasoning metadata rides along untouched.
          const finalContent = deps.plugins
            ? deps.plugins.response({
                chatId,
                content: completion.content,
                metadata: metadata ?? null,
              })
            : completion.content;
          // How the reply joins the transcript. Regenerate and continue are
          // mutually exclusive request flags; when both are somehow set,
          // regenerate wins (a fresh swipe is the more specific, destructive-
          // of-nothing action) — documented at the persistence helper. The
          // assistant-only gate lives in persistAssistantMessage, which falls
          // back to the append path when the last message is not the trailing
          // assistant one.
          const mode: PersistMode =
            body.value.regenerate === true
              ? "regenerate"
              : body.value.continue === true
                ? "continue"
                : "append";
          // The final text is decided here; the `ai` regex transform (and the
          // `regex_applied` marker) is applied by persistAssistantMessage
          // itself, so append/regenerate/continue cannot drift apart. The
          // reasoning metadata rides along untouched (it is not transformed).
          const persisted = persistAssistantMessage(
            deps.repos,
            chatId,
            prepared.character.name,
            finalContent,
            mode,
            metadata,
            { rules: regexRules, active: aiRegexActive },
          );
          prepared.lorebook?.commitTurn();

          // The post-response tail: level-0 summarization and the after_reply
          // tracker snapshot. Neither depends on the other — they touch
          // different tables — so they run CONCURRENTLY and the tail costs
          // `max()` instead of `sum()` of two LLM round-trips.
          //
          // Both status events are written BEFORE either task starts, so the
          // event order is deterministic regardless of which finishes first,
          // and `done` still arrives last.
          //
          // Level-0 summarization runs AFTER the reply lands, never during
          // prompt assembly — and only over FULL chunks, so there is no
          // summarization call after every turn. Catch-up is capped per
          // response (8 chunks, see generate-summaries.ts): a long chat
          // freshly switched to summaries catches up over successive turns.
          // The stage is announced only when the run would create something
          // (a full chunk or a layer over its promotion cap): a fresh chat
          // has every message inside the verbatim window, and announcing
          // `summarizing` there would flash the pill while nothing runs.
          const summarizePending =
            prepared.preset.settings.memory.strategy === "summaries" &&
            hasSummarizationWork(deps.repos, chatId, summariesConfig, { fullOnly: true });
          const trackAfterReply = trackerOnForChat && trackerConfig.auto_mode === "after_reply";
          if (summarizePending) {
            await s.write(encodeSseEvent({ type: "status", stage: "summarizing" }));
          }
          if (trackAfterReply) {
            await s.write(encodeSseEvent({ type: "status", stage: "tracking" }));
          }

          // Failure in either task never fails the generation: the reply is
          // already persisted and `done` still follows. allSettled (not all)
          // keeps one failure from cancelling the other task mid-flight.
          const tailTasks: Promise<unknown>[] = [];
          if (summarizePending) {
            tailTasks.push(
              (async () => {
                try {
                  await summarizeUncovered(deps.repos, deps.gateway, chatId, summariesConfig, {
                    fullOnly: true,
                    profile: summarizeProfile,
                    // Resolved inside the task so the endpoint read never
                    // delays the tracker starting alongside it.
                    endpoint: await summarizeEndpoint(),
                    signal,
                  });
                } catch (err) {
                  // Client disconnect during summarization: end like any
                  // other abort (the client is gone — nothing left to tell).
                  if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
                    return;
                  }
                  console.error("post-response summarization failed:", err);
                }
              })(),
            );
          }
          if (trackAfterReply) {
            tailTasks.push(runTracker(persisted.id));
          }
          if (tailTasks.length > 0) {
            await Promise.allSettled(tailTasks);
          }
          // A client disconnect during the tail leaves nothing to tell.
          if (signal.aborted) {
            return;
          }
          // The reasoning fields exist only when thinking was captured —
          // clients branch on their absence. JSON.stringify would drop an
          // undefined reasoning_duration_ms, but the gateway always pairs
          // it with reasoning, so both arrive together.
          await s.write(
            encodeSseEvent({
              type: "done",
              message_id: persisted.id,
              content: persisted.content,
              ...(completion.reasoning !== undefined
                ? {
                    reasoning: completion.reasoning,
                    reasoning_duration_ms: completion.reasoningDurationMs,
                  }
                : {}),
            }),
          );
        } catch (err) {
          // Client disconnect: the gateway aborted the upstream call. Nothing
          // was persisted and nothing ever will be here — just end the stream.
          if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
            return;
          }
          // The console doesn't print custom Error props — carry the
          // GatewayError's status/detail explicitly so they land in the log.
          console.error(`[generate] chat ${chatId} failed:`, err, {
            chatId,
            presetId: body.value.preset_id ?? null,
            personaId: body.value.persona_id ?? null,
            model: profile?.model ?? null,
            status: err instanceof GatewayError ? (err.status ?? null) : null,
            detail: err instanceof GatewayError ? (err.detail ?? null) : null,
          });
          await s.write(encodeSseEvent({ type: "error", message: errorMessage(err) }));
        }
      } finally {
        // Every exit path — success, thrown errors, and the abort
        // early-returns — must clear the heartbeat: a leaked interval would
        // hang `bun test`, which drives this route through app.fetch
        // without Bun.serve.
        clearInterval(heartbeat);
      }
    });
  });

  return app;
}
