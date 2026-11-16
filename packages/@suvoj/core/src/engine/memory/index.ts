/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { z } from "zod";
import type { SummariesRepository } from "../../repositories/summaries";
import type { Message } from "../../schema/messages";

/**
 * Memory strategies — customizable history compaction for the prompt
 * pipeline (PLAN_PROMPT: two built-ins, extensible).
 *
 * A strategy receives the seq-ordered active history and a token budget for
 * it, and returns the history that survives (plus an optional summary block
 * injected AFTER the history by the assembler). Strategies may persist
 * state through the repositories they are handed (e.g. the summaries
 * strategy stores its summaries in the `summaries` table).
 */

/** Everything a strategy needs besides the history itself. */
export interface MemoryContext {
  chatId: string;
  /** Strategy configuration (validated by the strategy's own schema). */
  config: Record<string, unknown>;
  summaries: SummariesRepository;
  /**
   * Gateway-backed summarizer injected by the server. The engine itself
   * never performs HTTP calls; without a `summarizeFn` the summaries
   * strategy degrades to plain trimming.
   */
  summarizeFn?: (rangeText: string) => Promise<string>;
  rng?: () => number;
}

/** Summary block injected after the history (marker text included). */
export interface MemorySummary {
  /** First elided message seq. */
  seqFrom: number;
  /** Last elided message seq. */
  seqTo: number;
  /** Ready-to-inject text, e.g. `[Summary of earlier conversation]\n…`. */
  text: string;
}

export interface MemoryResult {
  /** Surviving (or replacement) history, still seq-ordered. */
  history: Message[];
  summary?: MemorySummary;
}

export interface MemoryStrategy {
  id: string;
  name: string;
  /** Optional zod schema the strategy validates its config against. */
  configSchema?: z.ZodType;
  apply(history: ReadonlyArray<Message>, budget: number, ctx: MemoryContext): Promise<MemoryResult>;
}

const strategies = new Map<string, MemoryStrategy>();

/** Registers (or replaces) a memory strategy by id. */
export function registerMemoryStrategy(strategy: MemoryStrategy): void {
  strategies.set(strategy.id, strategy);
}

export function getMemoryStrategy(id: string): MemoryStrategy | undefined {
  return strategies.get(id);
}

export function listMemoryStrategies(): MemoryStrategy[] {
  return [...strategies.values()];
}

/** Removes a registered strategy by id; returns whether one was registered. */
export function unregisterMemoryStrategy(id: string): boolean {
  return strategies.delete(id);
}

/** Test hook: removes every registered strategy. */
export function resetMemoryStrategies(): void {
  strategies.clear();
}

// Built-ins (their imports from this module are type-only → no runtime cycle).
import { summariesStrategy } from "./summaries";
import { trimStrategy } from "./trim";

export type { ResolvedMemory } from "./resolve";
export { resolveMemorySettings } from "./resolve";
export { summariesStrategy } from "./summaries";
export { trimStrategy } from "./trim";

registerMemoryStrategy(trimStrategy);
registerMemoryStrategy(summariesStrategy);

/**
 * Ids of the built-in strategies, derived from the same objects registered
 * above (so the list cannot drift). Plugin-declared strategies must not use
 * them: `unregisterMemoryStrategy` deletes by id, so a plugin strategy
 * reusing a built-in id would replace it while enabled and remove it
 * entirely on unload — a preset selecting that id would then find nothing.
 * The plugin loader rejects such definitions upfront.
 */
export const BUILTIN_MEMORY_STRATEGY_IDS: readonly string[] = [
  trimStrategy.id,
  summariesStrategy.id,
];
