/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MemorySummaryInfo, PromptBudgetInfo, PromptMessageInfo } from "./api-generate";

/**
 * Pure view logic for the prompt inspector (components/chat/PromptPreview).
 *
 * The dry-run preview endpoint hands back an opaque list of assembled
 * messages; everything about how that list is LABELLED, SUBTOTALLED, and
 * COPIED lives here so it stays testable without a DOM. Nothing in this
 * module touches Solid, the network, or `navigator`.
 */

/** Display metadata for one message role. */
export interface PromptRoleDisplay {
  /** Row label, e.g. "System". */
  label: string;
  /** Stable tone key — the component renders `prompt-msg-<tone>`. */
  tone: string;
}

/** Tone for a role outside the known three: the server's message union is
 *  narrow, but an unexpected value must still render as something. */
export const FALLBACK_TONE = "other";

const ROLE_DISPLAYS: Record<string, PromptRoleDisplay> = {
  system: { label: "System", tone: "system" },
  user: { label: "User", tone: "user" },
  assistant: { label: "Assistant", tone: "assistant" },
};

/** Label + tone for a role; an unknown role keeps its raw name. */
export function roleDisplay(role: string): PromptRoleDisplay {
  const known = ROLE_DISPLAYS[role];
  if (known !== undefined) {
    return known;
  }
  const name = role.trim();
  return { label: name === "" ? "Unknown" : name, tone: FALLBACK_TONE };
}

/** Placeholder for a message with empty content — the block must never
 *  render as an unexplained gap. */
export const EMPTY_CONTENT_PLACEHOLDER = "(empty)";

/** Tokens coerced to a non-negative integer: a malformed count must never
 *  poison a total or a share. */
function safeTokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** A signed count coerced to a finite integer (remaining may go negative
 *  when a prompt overflows its context). */
function safeSigned(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

/** `used` as a percentage of `context`, rounded to a whole number.
 *  Uncapped on purpose: an over-context prompt reports >100 rather than
 *  silently reading as exactly full. 0 whenever the context is missing or
 *  non-positive — there is nothing to be a fraction of. */
export function usagePercent(used: number, context: number): number {
  if (!Number.isFinite(context) || context <= 0) {
    return 0;
  }
  return Math.round((safeTokens(used) / context) * 100);
}

/** Header summary of a budget: the numbers plus the single line the modal
 *  prints. `percent` is `used` against `context`. */
export interface BudgetSummary {
  used: number;
  context: number;
  remaining: number;
  percent: number;
  /** e.g. "100 / 400 tokens · 25% used · 300 remaining". */
  line: string;
}

export function summarizeBudget(budget: PromptBudgetInfo): BudgetSummary {
  const used = safeTokens(budget.used);
  const context = safeTokens(budget.context);
  const remaining = safeSigned(budget.remaining);
  const percent = usagePercent(used, context);
  return {
    used,
    context,
    remaining,
    percent,
    line: `${used.toLocaleString()} / ${context.toLocaleString()} tokens · ${percent}% used · ${remaining.toLocaleString()} remaining`,
  };
}

/** Per-role token subtotal. */
export interface RoleTokenTotal {
  role: string;
  label: string;
  tone: string;
  tokens: number;
}

/** Subtotals of an assembled prompt. */
export interface PromptTotals {
  /** Sum of every message's tokens. */
  total: number;
  /** Messages counted (0 for an empty list). */
  count: number;
  /** Per-role subtotals, in first-seen order. */
  byRole: RoleTokenTotal[];
  /** `total` against `context`, rounded (may exceed 100). */
  percent: number;
}

export function promptTotals(
  messages: readonly PromptMessageInfo[],
  context: number,
): PromptTotals {
  const byRole: RoleTokenTotal[] = [];
  let total = 0;
  for (const message of messages) {
    const tokens = safeTokens(message.tokens);
    total += tokens;
    const row = byRole.find((candidate) => candidate.role === message.role);
    if (row === undefined) {
      const display = roleDisplay(message.role);
      byRole.push({ role: message.role, label: display.label, tone: display.tone, tokens });
    } else {
      row.tokens += tokens;
    }
  }
  return { total, count: messages.length, byRole, percent: usagePercent(total, context) };
}

/** One message prepared for rendering. */
export interface PromptMessageView {
  /** 1-based position in the assembled prompt. */
  index: number;
  role: string;
  label: string;
  tone: string;
  /** Speaker name, or null when the message carries none. */
  name: string | null;
  /** Raw content — the component renders it as text. */
  content: string;
  /** True when `content` has no non-whitespace characters. */
  empty: boolean;
  tokens: number;
  /** `tokens` against the context, rounded (may exceed 100). */
  share: number;
}

/** Labels and annotates every message, in prompt order, for display. */
export function toMessageViews(
  messages: readonly PromptMessageInfo[],
  context: number,
): PromptMessageView[] {
  return messages.map((message, position) => {
    const display = roleDisplay(message.role);
    const name = message.name?.trim();
    const tokens = safeTokens(message.tokens);
    // A malformed payload must not crash the renderer: a missing content
    // reads as empty rather than throwing in String.trim.
    const content = typeof message.content === "string" ? message.content : "";
    return {
      index: position + 1,
      role: message.role,
      label: display.label,
      tone: display.tone,
      name: name === undefined || name === "" ? null : name,
      content,
      empty: content.trim() === "",
      tokens,
      share: usagePercent(tokens, context),
    };
  });
}

/** The whole assembled prompt as pasteable plain text: one `[Role]` (or
 *  `[Role: Name]`) header per message followed by its raw content. */
export function formatPromptText(messages: readonly PromptMessageInfo[]): string {
  return messages
    .map((message) => {
      const { label } = roleDisplay(message.role);
      const name = message.name?.trim();
      const header = name === undefined || name === "" ? `[${label}]` : `[${label}: ${name}]`;
      const content = typeof message.content === "string" ? message.content : "";
      return `${header}\n${content}`;
    })
    .join("\n\n");
}

/** Copy for the plugin-rewrite note; null when no plugin touched the prompt. */
export function pluginNotice(rewritten: boolean): string | null {
  return rewritten ? "A plugin rewrote this prompt before it was sent." : null;
}

/** Copy for the summary-block note; null when no summary was injected. */
export function summaryNotice(summary: MemorySummaryInfo | null | undefined): string | null {
  if (summary === null || summary === undefined) {
    return null;
  }
  return `Messages ${summary.seqFrom}–${summary.seqTo} were replaced by the injected summary block.`;
}
