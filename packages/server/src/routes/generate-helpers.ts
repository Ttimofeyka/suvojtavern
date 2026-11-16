/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { engine } from "@suvoj/core";
import type { Endpoint } from "../gateway";
import type { Gateway, Repos } from "../routes-deps";

/**
 * Helpers shared by the generation SSE route and the summaries maintenance
 * routes.
 *
 * - {@link makeSummarizer} sends the templated summarizer prompts as a
 *   system/user message pair (the summaries config's `system_prompt` +
 *   rendered `user_prompt`, see generate-summaries.ts).
 * - {@link makeSummarizeFn} bridges the engine's memory-strategy
 *   `summarizeFn` contract — `(rangeText: string) => Promise<string>`, see
 *   @suvoj/core `engine/memory` — to the server gateway. The engine's
 *   budget-pressure roll-ups supply plain merged range text (the rich
 *   templated prompting lives in the server's summarizeUncovered), so the
 *   bridge sends it as one user message. `chatCompletion` returns the full
 *   content — no delta accumulation is needed.
 * - {@link persistAssistantMessage} stores a generated reply, either as a new
 *   chat position, a new swipe of the last assistant message group, or an
 *   in-place continuation of that message.
 */

/** Low-temperature sampling for summarization calls. */
const SUMMARIZE_SAMPLING = { temperature: 0.3 };

/**
 * Resolves the sampling a summarizer call uses: with a connection
 * `profile`, the profile's samplers apply (minus `stream`) while
 * temperature stays the 0.3 quality guard; without one, fixed
 * low-temperature sampling.
 */
function summarizerSampling(
  profile?: { model: string; sampling: Record<string, unknown> } | null,
): Record<string, unknown> {
  if (!profile) {
    return SUMMARIZE_SAMPLING;
  }
  const sampling: Record<string, unknown> = { ...profile.sampling, temperature: 0.3 };
  delete sampling.stream;
  return sampling;
}

/**
 * Builds the gateway-backed summarizer the server's summarize flows use
 * for templated prompts: each call sends `[{role: "system"}, {role:
 * "user"}]` with the same profile/sampling logic as {@link
 * makeSummarizeFn} (profile samplers minus stream, temperature 0.3,
 * profile model). Returns the trimmed response content.
 */
export function makeSummarizer(
  gateway: Gateway,
  opts?: {
    signal?: AbortSignal;
    /** Connection profile supplying model + samplers; `null` = none. */
    profile?: { model: string; sampling: Record<string, unknown> } | null;
    /** Upstream for this profile; absent means no profile (the call fails cleanly). */
    endpoint?: Endpoint;
  },
): (system: string, user: string) => Promise<string> {
  return async (system, user) => {
    const result = await gateway.chatCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      summarizerSampling(opts?.profile),
      {
        signal: opts?.signal,
        model: opts?.profile?.model || undefined,
        endpoint: opts?.endpoint,
      },
    );
    return result.content.trim();
  };
}

/**
 * Builds the gateway-backed summarizer the `summaries` memory strategy calls
 * for each uncovered range. With a connection `profile`, the profile's
 * samplers apply (minus `stream`) while temperature stays the 0.3 quality
 * guard, and the profile's model is used when set; without one, fixed
 * low-temperature sampling is used (and the gateway fails cleanly with no
 * endpoint/model).
 *
 * `endpoint` accepts either a resolved value or a lazy resolver: the memory
 * strategy calls this callback only when a roll-up is actually needed, so a
 * resolver defers (and can reject on) an unconfigured optional profile until
 * then instead of aborting the surrounding generation eagerly.
 */
export function makeSummarizeFn(
  gateway: Gateway,
  opts?: {
    signal?: AbortSignal;
    /** Connection profile supplying model + samplers; `null` = none. */
    profile?: { model: string; sampling: Record<string, unknown> } | null;
    /** Upstream for this profile; absent means no profile (the call fails
     *  cleanly). A function is resolved on each call (the caller may memoize). */
    endpoint?: Endpoint | (() => Promise<Endpoint | undefined>);
  },
): (rangeText: string) => Promise<string> {
  return async (rangeText) => {
    const endpoint = typeof opts?.endpoint === "function" ? await opts.endpoint() : opts?.endpoint;
    const result = await gateway.chatCompletion(
      [{ role: "user", content: rangeText }],
      summarizerSampling(opts?.profile),
      {
        signal: opts?.signal,
        model: opts?.profile?.model || undefined,
        endpoint,
      },
    );
    return result.content.trim();
  };
}

/**
 * How a completed reply joins the transcript (see
 * {@link persistAssistantMessage}): a fresh position, a new swipe of the last
 * assistant group, or appended text on that group's active message.
 */
export type PersistMode = "append" | "regenerate" | "continue";

/**
 * The compiled `ai`-placement rules a generation applies to its reply, plus
 * whether any enabled rule actually targets `ai`. `active` is precomputed so
 * the common no-rules case skips both the transform and the metadata merge;
 * it is exactly `engine.hasRulesFor(rules, "ai")`.
 */
export interface AiRegexTransform {
  rules: engine.CompiledRegexRule[];
  active: boolean;
}

/**
 * The separator a `"continue"` reply prepends to the text it extends.
 *
 * SillyTavern inserts its `continue_postfix` (SPACE, the default in
 * scripts/openai.js `continue_postfix_types`) between a cycle prompt and its
 * continuation, and mirrors that separator into the streamed text too — a
 * continuation must never start mid-word. This is a deliberate refinement of
 * that rule, not an exact copy: ST inserts the postfix whenever the previous
 * text does not end in a space, even when it is empty, whereas we also skip
 * the separator for an empty previous (there is no word to break) and accept
 * any trailing whitespace (`\s$` covers space, newline, and tab — a second
 * one would show as a doubled gap). The same rule is duplicated by hand in
 * web's `continueSeparator` (lib/continue-text.ts) for the live bubble; keep
 * the two in sync.
 */
function continueSeparator(previous: string): string {
  return previous !== "" && !/\s$/.test(previous) ? " " : "";
}

/**
 * Persists a completed assistant reply.
 *
 * `mode` selects how the reply joins the transcript; the last active message
 * (when there is one) decides the two in-place paths:
 *
 * - `"append"`: a new position at the end of the chat (`insertMessage`, role
 *   "assistant", name = the character's).
 * - `"regenerate"`: when that last message is an assistant message, the
 *   content becomes a NEW variant of its swipe group (`addVariant`) and the
 *   active variant (`setActiveVariant`) — siblings share `variant_of` + `seq`,
 *   exactly one sibling per group is active. When it is not an assistant
 *   message (a user/system message, or an empty chat), the reply falls through
 *   to the append path: there is no assistant swipe to regenerate.
 * - `"continue"`: when that last message is an assistant message, the new text
 *   is appended to it IN PLACE via `editMessageContent` — same message id,
 *   same position, no new swipe. The merge goes through the repository's
 *   beforeEdit/afterEdit hooks, so plugins observe the continuation as an edit
 *   of that message. Joined by {@link continueSeparator}, the same
 *   SillyTavern-derived rule web's live bubble applies, so a continuation
 *   never starts mid-word and the live surface does not jump at settle. When
 *   the last message is NOT an assistant message (or the chat is empty), the
 *   reply falls back to the append path — a continuation has nothing to
 *   extend, and the model still saw the full history, exactly like
 *   SillyTavern's continue on a user message.
 *
 * `metadata` (e.g. reasoning) is written to the row for the inserted position
 * and the regenerated swipe — both are fresh rows, so they take the reply's own
 * metadata wholesale. A continuation is deliberately different: the row already
 * carries the first half's metadata, and the continuation supplies only the
 * appended text, so the continuation's own `metadata` is NOT written and the
 * existing row metadata (reasoning captured for the first half) is left
 * untouched rather than being overwritten by — or clobbered to null by — the
 * continuation's absent/partial reasoning. The one exception is the regex
 * marker below: when the ai pass is active it is folded into the existing
 * metadata (see `withRegexApplied`), never replacing the rest.
 *
 * Returns the persisted message id and final content. For a continuation the
 * id is the existing (unchanged) message's and the content is the merged
 * `previous + separator + reply` — the full stored truth the `done` event
 * carries, so the client can swap its live surface to it.
 *
 * `aiRegex` is the compiled `ai`-placement rule set resolved once per
 * generation (undefined = none). It is applied HERE, where the final text is
 * decided, rather than upstream in generate.ts, so `append`/`regenerate`/
 * `continue` cannot drift apart. When it is active, the reply's row is marked
 * `metadata.regex_applied = true` — the flag prompt assembly keys off to skip
 * the `ai` pass on that row — REGARDLESS of whether the text actually
 * changed: the flag means "this reply has already been through the ai pass",
 * not "this text differs from the raw reply". The consequence is that adding
 * a rule later never retroactively rewrites already-marked replies (the same
 * trade-off SillyTavern makes); unmarked legacy rows are still cleaned when
 * the prompt is assembled. When `aiRegex` is absent (or inactive) this
 * function is byte-identical to the pre-regex behaviour.
 */
export function persistAssistantMessage(
  repos: Repos,
  chatId: string,
  characterName: string,
  content: string,
  mode: PersistMode,
  metadata?: Record<string, unknown> | null,
  aiRegex?: AiRegexTransform,
): { id: string; content: string } {
  if (mode === "continue") {
    const history = repos.messages.listActive(chatId);
    const last = history[history.length - 1];
    if (last?.role === "assistant") {
      const separator = continueSeparator(last.content);
      // The row is re-persisted wholesale, so the ai pass must normally see
      // the WHOLE merged text — that is also what cleans legacy history whose
      // first half predates the rule. The one exception: when the existing
      // row is already marked as transformed, running the rules over it again
      // would double-apply a non-idempotent rule; only the appended fragment
      // is untransformed then.
      const alreadyApplied = last.metadata?.regex_applied === true;
      const transform = (text: string): string =>
        aiRegex?.active === true ? engine.applyRegexRules(text, aiRegex.rules, "ai") : text;
      const mergedContent = alreadyApplied
        ? last.content + separator + transform(content)
        : transform(last.content + separator + content);
      const merged = repos.messages.editMessageContent(
        last.id,
        mergedContent,
        // Marking the merged row preserves the existing half's reasoning:
        // the continuation's own metadata is still NOT written (see above),
        // only the flag is folded in.
        aiRegex?.active === true ? withRegexApplied(last.metadata) : undefined,
      );
      // editMessageContent returns null only when the row vanished between the
      // listActive read and the write — no await runs here, so that cannot
      // happen; the check keeps the function total and lets a surprise fall
      // back to the append path instead of throwing.
      if (merged) {
        return { id: merged.id, content: merged.content };
      }
    }
  } else if (mode === "regenerate") {
    const history = repos.messages.listActive(chatId);
    const last = history[history.length - 1];
    if (last?.role === "assistant") {
      const variant = repos.messages.addVariant(
        chatId,
        last.id,
        transformReply(content, aiRegex),
        "assistant",
        {
          name: characterName,
          metadata: replyMetadata(metadata, aiRegex),
        },
      );
      const active = repos.messages.setActiveVariant(variant.id);
      return { id: active.id, content: active.content };
    }
  }
  const message = repos.messages.insertMessage(chatId, {
    role: "assistant",
    content: transformReply(content, aiRegex),
    name: characterName,
    metadata: replyMetadata(metadata, aiRegex),
  });
  return { id: message.id, content: message.content };
}

/** Applies the `ai` rules to a fresh reply when the transform is active. */
function transformReply(content: string, aiRegex?: AiRegexTransform): string {
  if (aiRegex?.active !== true) {
    return content;
  }
  return engine.applyRegexRules(content, aiRegex.rules, "ai");
}

/**
 * The row metadata for a FRESH row (append/regenerate): the reply's own
 * metadata (e.g. reasoning) when the ai pass did not run, or that metadata
 * with `regex_applied` folded in when it did. `undefined`/`null` metadata
 * becomes the marker alone — never a clobbered reasoning field.
 */
function replyMetadata(
  metadata: Record<string, unknown> | null | undefined,
  aiRegex?: AiRegexTransform,
): Record<string, unknown> | null | undefined {
  return aiRegex?.active === true ? withRegexApplied(metadata) : metadata;
}

/** `metadata` (or a fresh object) with the `regex_applied` marker set. */
function withRegexApplied(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return { ...(metadata ?? {}), regex_applied: true };
}
