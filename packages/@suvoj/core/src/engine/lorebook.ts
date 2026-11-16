/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { VariablesRepository } from "../repositories/kv";
import type { LorebookEntry } from "../schema/lorebooks";
import type { MessageRole } from "../schema/messages";
import type { MacroContext } from "./macros";
import { evaluateMacros } from "./macros";
import { countTokens } from "./tokens";

/**
 * SillyTavern-compatible world info engine.
 *
 * Semantics mirror `public/scripts/world-info.js` of SillyTavern:
 * - primary keys any-match; `selective` entries additionally gate on
 *   `secondary` keys with `logic` 0=AND_ANY, 1=NOT_ALL, 2=NOT_ANY, 3=AND_ALL;
 * - keys wrapped like `/pattern/flags` are regexes (invalid ones never match);
 * - `match_whole_words` uses word boundaries for single-word keys;
 * - `constant` entries are always included (probability still applies);
 * - recursion re-scans the content of activated entries (bounded iterations),
 *   honoring `excludeRecursion` / `preventRecursion` / `delayUntilRecursion`;
 * - sticky / cooldown / delay are turn-based and persisted in the chat scope
 *   of the {@link VariablesRepository} so they survive restarts;
 * - entries sharing a `group` compete: `extra.groupOverride` wins, otherwise
 *   a `group_weight`-weighted random pick;
 * - a global token budget is applied in `order`-descending priority.
 */

/** SillyTavern world info entry positions (native mapping 0..4). */
export const LorebookPosition = {
  /** Before the character definitions (worldInfoBefore marker). */
  BeforeChar: 0,
  /** After the character definitions (worldInfoAfter marker). */
  AfterChar: 1,
  /**
   * Before the author's-note area. v1 has no dedicated AN block, so these
   * render after the character definitions, before AfterAN entries.
   */
  BeforeAN: 2,
  /** After the author's-note area (still inside worldInfoAfter). */
  AfterAN: 3,
  /** In-chat absolute depth injection (uses `depth` + `role`). */
  AtDepth: 4,
} as const;

export type LorebookPosition = (typeof LorebookPosition)[keyof typeof LorebookPosition];

/** Global world info settings (usually sourced from the preset). */
export interface LorebookSettings {
  /** How many recent messages are scanned (from the end of the history). */
  scanDepth: number;
  /** Global world info budget in tokens. */
  budgetTokens: number;
  /** Default case sensitivity (entries' own value wins). */
  caseSensitive?: boolean;
  /** Default whole-word matching (entries' own value wins). */
  matchWholeWords?: boolean;
  /** Maximum recursion iterations after the direct scan (default 2). */
  maxRecursion?: number;
}

/** Character-independent texts entries may opt into scanning (`match_fields`). */
export interface GlobalScanData {
  personaDescription?: string;
  characterDescription?: string;
  characterPersonality?: string;
  scenario?: string;
  creatorNotes?: string;
}

export interface LorebookScanContext {
  entries: ReadonlyArray<LorebookEntry>;
  /** Recent message contents, oldest → newest (scan depth counts from the end). */
  scanText: ReadonlyArray<string>;
  settings: LorebookSettings;
  /** Current character for `character_filter` matching. */
  character?: { name: string; tags: string[] } | null;
  /** Character/persona texts for `match_fields` scanning. */
  globalScan?: GlobalScanData;
  /** Present → timed effects (sticky/cooldown/delay) are loaded and persisted. */
  chatId?: string | null;
  vars?: VariablesRepository | null;
  /** RNG for probability gates and group rolls (defaults to `Math.random`). */
  rng?: () => number;
  /** Present → entry contents are macro-evaluated on activation (ST behavior). */
  macros?: MacroContext | null;
}

/** One activated entry, ready for the prompt assembler. */
export interface LorebookActivation {
  entry: LorebookEntry;
  /** Macro-evaluated content (the assembler must not evaluate it again). */
  content: string;
  tokens: number;
  position: LorebookPosition;
  depth: number;
  role: MessageRole;
}

/** Turn-based state of one entry (persisted in the chat variable scope). */
interface EntryTimedState {
  /** Entry stays active through this turn number (sticky). */
  stickyUntil?: number;
  /** Re-activation blocked through this turn number (cooldown). */
  cooldownUntil?: number;
  /** Entry cannot activate before this turn number (delay). */
  delayUntil?: number;
  /** Entry was part of the last committed generation. */
  active?: boolean;
}

const TURN_KEY = "__wi:turn";
const STATE_KEY = "__wi:state";

export interface LorebookRunResult {
  /**
   * Activated entries in prompt layout order: position ascending, then
   * `order` ascending (higher order renders closer to the character
   * definitions, matching ST's unshift-into-array arrangement).
   */
  activations: LorebookActivation[];
  /** Ids of every activated entry (sticky bookkeeping). */
  activatedIds: ReadonlySet<string>;
  /**
   * Persists the turn advance: increments the chat's turn counter and writes
   * sticky/cooldown/delay transitions. No-op when the context has no chat
   * scope. Call once per *generated message*, after generation.
   */
  commitTurn(): void;
}

// --- key matching -----------------------------------------------------------

const regexKeyCache = new Map<string, RegExp | null>();

/**
 * ST convention: keys wrapped like `/pattern/flags` are regexes. Returns the
 * compiled regex, or `null` when the key is not regex-shaped or invalid.
 */
function compileKeyRegex(key: string): RegExp | null {
  const cached = regexKeyCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let regex: RegExp | null = null;
  const match = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(key);
  if (match) {
    const pattern = match[1] ?? "";
    // An unescaped inner `/` means the wrapper is not a real regex literal.
    if (!/(^|[^\\])\//.test(pattern)) {
      try {
        regex = new RegExp(pattern, match[2] ?? "");
      } catch {
        regex = null;
      }
    }
  }
  if (regexKeyCache.size > 1000) {
    regexKeyCache.clear();
  }
  regexKeyCache.set(key, regex);
  return regex;
}

function isWordChar(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

/** `(?:^|\W)(needle)(?:$|\W)` without compiling a regex per key. */
function wholeWordIncludes(haystack: string, needle: string): boolean {
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const before = index === 0 ? "" : (haystack[index - 1] ?? "");
    const after = index + needle.length;
    const afterChar = after >= haystack.length ? "" : (haystack[after] ?? "");
    if (!isWordChar(before) && !isWordChar(afterChar)) {
      return true;
    }
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

function matchKey(
  haystack: string,
  key: string,
  caseSensitive: boolean,
  wholeWords: boolean,
): boolean {
  const trimmed = key.trim();
  if (trimmed === "") {
    return false;
  }
  const regex = compileKeyRegex(trimmed);
  if (regex !== null) {
    try {
      return regex.test(haystack);
    } catch {
      return false;
    }
  }
  let hay = haystack;
  let needle = trimmed;
  if (!caseSensitive) {
    hay = hay.toLowerCase();
    needle = needle.toLowerCase();
  }
  if (!wholeWords) {
    return hay.includes(needle);
  }
  // ST rule: multi-word keys always match as substrings.
  if (/\s/.test(needle)) {
    return hay.includes(needle);
  }
  return wholeWordIncludes(hay, needle);
}

function secondaryLogicPasses(
  entry: LorebookEntry,
  haystack: string,
  caseSensitive: boolean,
  wholeWords: boolean,
): boolean {
  if (!entry.selective || entry.secondary.length === 0) {
    return true;
  }
  const matches = entry.secondary.map((key) => matchKey(haystack, key, caseSensitive, wholeWords));
  const anyMatch = matches.some((matched) => matched);
  switch (entry.logic) {
    case 0: // AND_ANY — at least one secondary key matches
      return anyMatch;
    case 1: // NOT_ALL — at least one secondary key does not match
      return matches.some((matched) => !matched);
    case 2: // NOT_ANY — no secondary key matches
      return !anyMatch;
    case 3: // AND_ALL — every secondary key matches
      return matches.every((matched) => matched);
    default:
      return anyMatch;
  }
}

// --- helpers ----------------------------------------------------------------

function extraFlag(entry: LorebookEntry, key: string): boolean {
  return entry.extra?.[key] === true;
}

function toRole(role: string | null): MessageRole {
  return role === "user" || role === "assistant" ? role : "system";
}

function normalizePosition(position: number): LorebookPosition {
  // Native positions are 0..4; anything else (raw ST imports) degrades to
  // "after character definitions".
  return position >= 0 && position <= 4
    ? (position as LorebookPosition)
    : LorebookPosition.AfterChar;
}

/** Character filter (ST `characterFilter`): include/exclude by name or tags. */
function characterFiltered(
  entry: LorebookEntry,
  character: { name: string; tags: string[] } | null | undefined,
): boolean {
  const filter = entry.character_filter;
  if (!filter) {
    return false;
  }
  if (!character) {
    // No character context: include-lists exclude the entry, exclude-lists keep it.
    const hasList = filter.names.length > 0 || filter.tags.length > 0;
    return hasList && !filter.isExclude;
  }
  if (filter.names.length > 0) {
    const included = filter.names.includes(character.name);
    if (filter.isExclude ? included : !included) {
      return true;
    }
  }
  if (filter.tags.length > 0) {
    const hasTag = character.tags.some((tag) => filter.tags.includes(tag));
    if (filter.isExclude ? hasTag : !hasTag) {
      return true;
    }
  }
  return false;
}

interface LoadedTimedState {
  turn: number;
  states: Record<string, EntryTimedState>;
}

function loadTimedState(ctx: LorebookScanContext): LoadedTimedState | null {
  if (!ctx.chatId || !ctx.vars) {
    return null;
  }
  const turn = ctx.vars.get<number>("chat", ctx.chatId, TURN_KEY) ?? 0;
  const states = ctx.vars.get<Record<string, EntryTimedState>>("chat", ctx.chatId, STATE_KEY) ?? {};
  return { turn, states };
}

// --- engine -----------------------------------------------------------------

export function runLorebook(ctx: LorebookScanContext): LorebookRunResult {
  const rng = ctx.rng ?? Math.random;
  const scanDepth = Math.max(1, ctx.settings.scanDepth);
  const maxRecursion = Math.max(0, ctx.settings.maxRecursion ?? 2);
  const budgetTokens = Math.max(0, ctx.settings.budgetTokens);

  const timed = loadTimedState(ctx);
  const turn = timed?.turn ?? 0;
  const states = new Map<string, EntryTimedState>(
    Object.entries(timed?.states ?? {}).map(([id, state]) => [id, { ...state }]),
  );
  const entryById = new Map(ctx.entries.map((entry) => [entry.id, entry]));

  const stateOf = (entryId: string): EntryTimedState => {
    let state = states.get(entryId);
    if (!state) {
      state = {};
      states.set(entryId, state);
    }
    return state;
  };

  // Budget priority: `order` descending (ST sortFn).
  const sorted = [...ctx.entries].sort((a, b) => b.order - a.order);

  // Base haystack per scan depth (per-entry `scan_depth` overrides), cached.
  const baseCache = new Map<number, string>();
  const baseHaystack = (depth: number): string => {
    const clamped = Math.min(Math.max(1, depth), Math.max(1, ctx.scanText.length));
    let base = baseCache.get(clamped);
    if (base === undefined) {
      const window = ctx.scanText.slice(-clamped);
      base = window.map((line) => line.trim()).join("\n");
      baseCache.set(clamped, base);
    }
    return base;
  };

  const globalScan = ctx.globalScan ?? {};
  const matchFields = (entry: LorebookEntry, text: string): string => {
    const fields = entry.match_fields;
    if (!fields) {
      return text;
    }
    const extra: string[] = [];
    if (fields.matchPersonaDescription && globalScan.personaDescription) {
      extra.push(globalScan.personaDescription);
    }
    if (fields.matchCharacterDescription && globalScan.characterDescription) {
      extra.push(globalScan.characterDescription);
    }
    if (fields.matchCharacterPersonality && globalScan.characterPersonality) {
      extra.push(globalScan.characterPersonality);
    }
    if (fields.matchScenario && globalScan.scenario) {
      extra.push(globalScan.scenario);
    }
    if (fields.matchCreatorNotes && globalScan.creatorNotes) {
      extra.push(globalScan.creatorNotes);
    }
    return extra.length === 0 ? text : `${text}\n${extra.join("\n")}`;
  };

  const isStickyNow = (entry: LorebookEntry): boolean => {
    const state = states.get(entry.id);
    return state?.stickyUntil !== undefined && state.stickyUntil > turn;
  };

  const activatedIds = new Set<string>();
  const activations: LorebookActivation[] = [];
  /** Entries that activated on their own merit (keys/constant), not via sticky carry-over. */
  const freshActivations = new Set<string>();
  let recurseText = "";
  const pendingDelayInit = new Set<string>();

  let pass = 0;
  while (pass <= maxRecursion) {
    const isRecursionPass = pass > 0;
    const candidates: LorebookEntry[] = [];

    for (const entry of sorted) {
      if (!entry.enabled || activatedIds.has(entry.id)) {
        continue;
      }
      if (characterFiltered(entry, ctx.character)) {
        continue;
      }
      const state = states.get(entry.id);
      const sticky = isStickyNow(entry);
      const delayed = state?.delayUntil !== undefined && state.delayUntil > turn;
      if (entry.delay > 0 && state?.delayUntil === undefined) {
        // First time this entry is seen: its delay starts counting now.
        pendingDelayInit.add(entry.id);
        if (!sticky) {
          continue;
        }
      }
      if (delayed) {
        continue;
      }
      const cooldown = state?.cooldownUntil !== undefined && state.cooldownUntil > turn;
      if (cooldown && !sticky) {
        continue;
      }
      if (isRecursionPass) {
        if (entry.recursion?.excludeRecursion && !sticky) {
          continue;
        }
      } else if (entry.recursion?.delayUntilRecursion && !sticky) {
        // Only activatable through recursion.
        continue;
      }
      if (entry.constant) {
        candidates.push(entry);
        freshActivations.add(entry.id);
        continue;
      }
      if (sticky) {
        // Sticky carry-over keeps the entry in the prompt but does not
        // refresh its own timer (only a genuine match does).
        candidates.push(entry);
        continue;
      }
      if (entry.keys.length === 0) {
        continue;
      }
      const depth = entry.scan_depth ?? scanDepth;
      const haystack = matchFields(entry, baseHaystack(depth) + recurseText);
      const caseSensitive = entry.case_sensitive;
      const wholeWords = entry.match_whole_words;
      const primary = entry.keys.some((key) => matchKey(haystack, key, caseSensitive, wholeWords));
      if (!primary) {
        continue;
      }
      if (!secondaryLogicPasses(entry, haystack, caseSensitive, wholeWords)) {
        continue;
      }
      candidates.push(entry);
      freshActivations.add(entry.id);
    }

    // Inclusion groups: entries sharing a `group` compete for one slot.
    const winners = applyInclusionGroups(candidates, activatedIds, entryById, rng);

    // Probability + budget, sticky entries first, then priority order.
    const ordered = [...winners].sort((a, b) => {
      const stickyDiff = (isStickyNow(b) ? 1 : 0) - (isStickyNow(a) ? 1 : 0);
      return stickyDiff !== 0 ? stickyDiff : b.order - a.order;
    });

    let usedTokens = activations.reduce((sum, activation) => sum + activation.tokens, 0);
    let overflowed = false;
    let ignoreBudgetRemaining = ordered.filter((entry) => extraFlag(entry, "ignoreBudget")).length;
    const passRecurse: string[] = [];

    for (const entry of ordered) {
      const ignoresBudget = extraFlag(entry, "ignoreBudget");
      if (ignoresBudget) {
        ignoreBudgetRemaining -= 1;
      }
      if (overflowed && !ignoresBudget) {
        if (ignoreBudgetRemaining > 0) {
          continue;
        }
        break;
      }
      // Sticky entries never re-roll probability (ST behavior).
      if (!isStickyNow(entry) && entry.probability < 100 && rng() * 100 > entry.probability) {
        continue;
      }
      const content = ctx.macros ? evaluateMacros(entry.content, ctx.macros) : entry.content;
      const tokens = countTokens(content);
      if (!ignoresBudget && usedTokens + tokens > budgetTokens) {
        overflowed = true;
        continue;
      }
      usedTokens += tokens;
      activatedIds.add(entry.id);
      activations.push({
        entry,
        content,
        tokens,
        position: normalizePosition(entry.position),
        depth: entry.depth,
        role: toRole(entry.role),
      });
      if (!entry.recursion?.preventRecursion) {
        passRecurse.push(content);
      }
    }

    if (passRecurse.length === 0 || pass === maxRecursion) {
      break;
    }
    recurseText = `${recurseText}\n${passRecurse.join("\n")}`;
    pass += 1;
  }

  // Layout order for the assembler: position, then order ascending.
  activations.sort((a, b) => {
    if (a.position !== b.position) {
      return a.position - b.position;
    }
    if (a.entry.order !== b.entry.order) {
      return a.entry.order - b.entry.order;
    }
    return a.entry.display_index - b.entry.display_index;
  });

  const commitTurn = (): void => {
    if (!timed || !ctx.chatId || !ctx.vars) {
      return;
    }
    for (const entryId of pendingDelayInit) {
      const entry = entryById.get(entryId);
      if (!entry) {
        continue;
      }
      const state = stateOf(entryId);
      if (state.delayUntil === undefined) {
        state.delayUntil = turn + entry.delay;
      }
    }
    for (const entryId of activatedIds) {
      const entry = entryById.get(entryId);
      if (!entry) {
        continue;
      }
      const state = stateOf(entryId);
      state.active = true;
      // Only genuine (key/constant) activations refresh the sticky timer.
      if (entry.sticky > 0 && freshActivations.has(entryId)) {
        state.stickyUntil = Math.max(state.stickyUntil ?? 0, turn + 1 + entry.sticky);
      }
    }
    for (const [entryId, state] of states) {
      if (state.active === true && !activatedIds.has(entryId)) {
        const entry = entryById.get(entryId);
        if (entry && entry.cooldown > 0) {
          state.cooldownUntil = Math.max(state.cooldownUntil ?? 0, turn + 1 + entry.cooldown);
        }
        state.active = false;
      }
    }
    ctx.vars.set("chat", ctx.chatId, TURN_KEY, turn + 1);
    ctx.vars.set("chat", ctx.chatId, STATE_KEY, Object.fromEntries(states));
  };

  return { activations, activatedIds, commitTurn };
}

/** Inclusion group resolution: one winner per non-empty `group`. */
function applyInclusionGroups(
  candidates: ReadonlyArray<LorebookEntry>,
  activatedIds: ReadonlySet<string>,
  entryById: ReadonlyMap<string, LorebookEntry>,
  rng: () => number,
): LorebookEntry[] {
  const ungrouped: LorebookEntry[] = [];
  const groups = new Map<string, LorebookEntry[]>();
  for (const entry of candidates) {
    const group = entry.group?.trim();
    if (!group) {
      ungrouped.push(entry);
      continue;
    }
    const members = groups.get(group);
    if (members) {
      members.push(entry);
    } else {
      groups.set(group, [entry]);
    }
  }
  const winners = [...ungrouped];
  for (const [group, members] of groups) {
    // A member of this group is already active → the group keeps its winner.
    const alreadyActive = [...activatedIds].some((id) => {
      const activated = entryById.get(id);
      return activated?.group?.trim() === group;
    });
    if (alreadyActive) {
      continue;
    }
    if (members.length === 1) {
      winners.push(members[0] as LorebookEntry);
      continue;
    }
    // groupOverride forces the winner (highest order wins among overrides).
    const overrides = members.filter((entry) => extraFlag(entry, "groupOverride"));
    if (overrides.length > 0) {
      const override = overrides.reduce((best, entry) => (entry.order > best.order ? entry : best));
      winners.push(override);
      continue;
    }
    // Weighted random by group_weight (default 100).
    const totalWeight = members.reduce((sum, entry) => sum + (entry.group_weight ?? 100), 0);
    let roll = rng() * totalWeight;
    let winner: LorebookEntry | null = null;
    for (const entry of members) {
      roll -= entry.group_weight ?? 100;
      if (roll <= 0) {
        winner = entry;
        break;
      }
    }
    if (winner) {
      winners.push(winner);
    }
  }
  return winners;
}
