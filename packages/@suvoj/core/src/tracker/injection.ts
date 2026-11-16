/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PipelineStage } from "../engine/pipeline";
import type { Repositories } from "../repositories";
import type { Message } from "../schema/messages";
import { type TrackerConfig, type TrackerSnapshot, trackerConfigSchema } from "../schema/tracker";

/**
 * Tracker injection — the pipeline stage + config accessor (the Suvoj Tracker
 * surface).
 *
 * `getTrackerConfig` is the single resolution point for the tracker
 * configuration (stored under the `tracker_config` settings key): a missing
 * key yields the full default config, a partial object merges through zod
 * defaults, and invalid values fall back per-field.
 *
 * `trackerStage` runs AFTER `history` (see engine/pipeline's built-in
 * order): it appends the newest snapshots attached to the SELECTED (active)
 * swipe of the latest message positions to `ctx.history` as TRANSIENT
 * messages — they are rendered into the prompt but never persisted. Each
 * snapshot is rendered per `injection.format`: the default `plain` key/value
 * form (see {@link renderPlainSnapshot}), or the opt-in `json` fence.
 *
 * Injection is gated on the SAME two-switch predicate as generation
 * ({@link isTrackerEnabledForChat}): the global master switch AND the chat's
 * own `tracker_enabled`, so a chat switched off in its drawer stops
 * injecting immediately.
 */

/** Settings key holding the tracker configuration. */
export const TRACKER_CONFIG_KEY = "tracker_config";

/** Reads and validates the tracker configuration (defaults when unset). */
export function getTrackerConfig(repos: Repositories): TrackerConfig {
  const stored = repos.settings.get<unknown>(TRACKER_CONFIG_KEY);
  const parsed = trackerConfigSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : trackerConfigSchema.parse({});
}

/**
 * Whether tracking is on for one chat: the global master switch AND the
 * chat's own `tracker_enabled` column. An unknown chat falls back to the
 * global switch alone (there is nothing to opt out of).
 *
 * This is the single predicate every tracker surface reads — the generation
 * service, the auto-mode checks in the generate route, and the injection
 * stage — so the two switches can never disagree about whether a chat tracks.
 */
export function isTrackerEnabledForChat(repos: Repositories, chatId: string): boolean {
  if (!getTrackerConfig(repos).enabled) {
    return false;
  }
  const chat = repos.chats.get(chatId);
  return chat === null || chat.tracker_enabled;
}

/**
 * Read-only guard line prefixed to every `plain`-format injection. Why: the
 * opt-in `json` fence is byte-identical to what the tracker generator is
 * asked to produce, so a roleplay model sometimes continues/imitates it in
 * its reply; stating that the block is reference state the model must not
 * reproduce is the anti-imitation half of the default `plain` mode.
 */
export const PLAIN_INJECTION_GUARD =
  "Read-only reference state — never repeat, quote, or output this block in your reply, and never emit scene-state JSON in your response.";

/** True for plain JSON objects (excludes `null` and arrays). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a value the plain renderer can print inline. */
function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** Renders a scalar; `null` stays the literal `null`. */
function renderScalar(value: unknown): string {
  return value === null ? "null" : String(value);
}

/** Inline rendering for scalars and (rare) mixed-array members. */
function renderInline(value: unknown): string {
  if (isScalar(value)) {
    return renderScalar(value);
  }
  // Compact JSON with no fence — total, and never mistakable for the tracker
  // generation format that a model might otherwise continue.
  return JSON.stringify(value) ?? String(value);
}

/** Keys preferred as an array item's `- ` label, in priority order. */
const ARRAY_ITEM_LABEL_KEYS = ["name", "id", "uid", "key", "fact"] as const;

/** The key + value chosen as an array item's `- ` label, else `null`. */
function arrayItemLabel(item: Record<string, unknown>): { key: string; label: string } | null {
  for (const key of ARRAY_ITEM_LABEL_KEYS) {
    const value = item[key];
    if (typeof value === "string" && value !== "") {
      return { key, label: value };
    }
  }
  return null;
}

/**
 * Renders an array value: `key: a, b` for arrays of scalars, or a `- ` item
 * list for arrays of objects. Empty arrays render as `key: (empty)`; mixed
 * arrays collapse to the inline scalar form. An object item is labelled by
 * its `name`/`id`/`uid`/`key`/`fact` (else `item{n}`), and that label key is
 * not repeated in the nested lines — only the remaining keys indent under it.
 */
function renderArray(key: string, value: unknown[], depth: number, lines: string[]): void {
  const pad = "  ".repeat(depth);
  if (value.length === 0) {
    lines.push(`${pad}${key}: (empty)`);
    return;
  }
  if (value.every(isRecord)) {
    lines.push(`${pad}${key}:`);
    value.forEach((item, index) => {
      const named = arrayItemLabel(item);
      lines.push(`${pad}  - ${named?.label ?? `item${index + 1}`}`);
      for (const [childKey, childValue] of Object.entries(item)) {
        if (childKey === named?.key) {
          continue;
        }
        renderEntry(childKey, childValue, depth + 2, lines);
      }
    });
    return;
  }
  lines.push(`${pad}${key}: ${value.map(renderInline).join(", ")}`);
}

/** Renders one `key: value` entry into `lines`, recursing into containers. */
function renderEntry(key: string, value: unknown, depth: number, lines: string[]): void {
  const pad = "  ".repeat(depth);
  if (Array.isArray(value)) {
    renderArray(key, value, depth, lines);
    return;
  }
  if (isRecord(value)) {
    lines.push(`${pad}${key}:`);
    for (const [childKey, childValue] of Object.entries(value)) {
      renderEntry(childKey, childValue, depth + 1, lines);
    }
    return;
  }
  lines.push(`${pad}${key}: ${renderScalar(value)}`);
}

/**
 * Renders a snapshot as `plain` content: the optional header line, the
 * read-only guard line, then one compact `key: value` line per entry, nested
 * values indented by two spaces per depth. Deterministic and total — an
 * unexpected shape degrades to `String`/compact JSON instead of throwing.
 */
export function renderPlainSnapshot(data: Record<string, unknown>, header: string): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    renderEntry(key, value, 0, lines);
  }
  const guard = `${header}${PLAIN_INJECTION_GUARD}`;
  return lines.length === 0 ? guard : `${guard}\n${lines.join("\n")}`;
}

/** Builds the transient history message for one snapshot (never persisted). */
function trackerMessage(chatId: string, snapshot: TrackerSnapshot, config: TrackerConfig): Message {
  const header = config.injection.header !== "" ? `${config.injection.header}\n` : "";
  const content =
    config.injection.format === "plain"
      ? renderPlainSnapshot(snapshot.data, header)
      : `${header}\`\`\`json\n${JSON.stringify(snapshot.data, null, 2)}\n\`\`\``;
  return {
    id: `tracker:${snapshot.id}`,
    chat_id: chatId,
    seq: snapshot.seq,
    role: config.injection.role,
    content,
    name: null,
    metadata: null,
    variant_of: null,
    active: true,
    created_at: snapshot.created_at,
  };
}

/**
 * The built-in `tracker` pipeline stage: renders the latest tracker
 * snapshots attached to the selected (active) swipe of the newest positions
 * (oldest → newest) into `ctx.tail` — the state block the assembler places
 * after the chat history and the memory summary, immediately before the
 * post-history instructions. A no-op when tracking is off for this chat (the
 * global switch or the chat's own flag), injection is off
 * (`include_last < 1`), or no selected position has a snapshot.
 *
 * Snapshots are STATE, not conversation: they live in `ctx.tail` rather than
 * behind the memory stages, so building a prompt never renders them as
 * trimmable history rows — and, because the block sits after the summary,
 * a summary that changes on a chunk boundary cannot push the tracker out of
 * the model's provider-side prefix cache.
 */
export const trackerStage: PipelineStage = {
  id: "tracker",
  run: async (ctx) => {
    const config = getTrackerConfig(ctx.repos);
    if (config.injection.include_last < 1 || !isTrackerEnabledForChat(ctx.repos, ctx.chat.id)) {
      return;
    }
    const snapshots =
      ctx.replacedSeq !== undefined
        ? // A regenerate/swipe replaces the tracker's own swipe, so read only
          // positions strictly BEFORE the replaced `seq` — that excludes the
          // whole sibling group (all swipes share one seq), and the snapshot
          // attached to the swipe being replaced never leaks into its
          // replacement's prompt.
          ctx.repos.trackers.listForMessagesBefore(
            ctx.chat.id,
            ctx.replacedSeq,
            config.injection.include_last,
          )
        : ctx.repos.trackers.listForActiveMessages(ctx.chat.id, config.injection.include_last);
    if (snapshots.length === 0) {
      return;
    }
    ctx.tail = [
      ...(ctx.tail ?? []),
      ...snapshots.map((snapshot) => trackerMessage(ctx.chat.id, snapshot, config)),
    ];
  },
};
