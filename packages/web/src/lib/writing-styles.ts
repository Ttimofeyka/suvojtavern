/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * Writing styles — how a streaming reply reveals itself in the transcript.
 *
 * The server streams a reply a token at a time. The client can either paint
 * each token the moment it lands ("instant", the default and the app's
 * original behaviour) or pace the reveal so the words flow in smoothly
 * instead of arriving in the network's bursts. A style pairs that pacing with
 * a matching caret (see the .live-cursor variants in styles/chat.css).
 *
 * The pacing math lives here as pure functions so the live stream controller
 * (stores/stream-reveal.ts) and the Settings preview share one rule and can
 * never drift apart.
 */

export type WritingStyle = "instant" | "smooth" | "typewriter" | "flow";

export interface WritingStyleSpec {
  id: WritingStyle;
  /** Picker label. */
  label: string;
  /** One-line picker description. */
  description: string;
  /**
   * Base reveal speed in characters per second. 0 disables smoothing: the
   * text lands exactly when it arrives (the default).
   */
  charsPerSecond: number;
  /**
   * Longest the reveal may lag behind the received text, in seconds. The rate
   * climbs while the backlog exceeds this, so a fast model can never leave the
   * visible text trailing far behind — and the stream's settle wait stays
   * short.
   */
  maxLagSeconds: number;
  /**
   * Reveal granularity: continuous characters, or whole words. Word mode holds
   * partial words back so the text lands in typewriter-like ticks.
   */
  granularity: "char" | "word";
}

export const WRITING_STYLES: readonly WritingStyleSpec[] = [
  {
    id: "instant",
    label: "Instant",
    description:
      "Text appears the moment it arrives, with a caret that blinks like a text editor's.",
    charsPerSecond: 0,
    maxLagSeconds: 0,
    granularity: "char",
  },
  {
    id: "smooth",
    label: "Smooth",
    description: "Characters ease in at a gentle, steady pace under a softly glowing caret.",
    charsPerSecond: 70,
    maxLagSeconds: 0.5,
    granularity: "char",
  },
  {
    id: "typewriter",
    label: "Typewriter",
    description: "Whole words land in deliberate ticks behind a solid block caret.",
    charsPerSecond: 30,
    maxLagSeconds: 0.6,
    granularity: "word",
  },
  {
    id: "flow",
    label: "Flow",
    description: "The reply rushes in at a brisk pace, its caret rippling as it goes.",
    charsPerSecond: 140,
    maxLagSeconds: 0.28,
    granularity: "char",
  },
];

/** The default style: the app's original, unpaced behaviour. */
export const DEFAULT_WRITING_STYLE: WritingStyle = "instant";

const SPECS = new Map<WritingStyle, WritingStyleSpec>();
for (const spec of WRITING_STYLES) {
  SPECS.set(spec.id, spec);
}

export function isWritingStyle(value: unknown): value is WritingStyle {
  return typeof value === "string" && SPECS.has(value as WritingStyle);
}

/** The spec for a style id, falling back to the default for an unknown id. */
export function writingStyleSpec(style: WritingStyle): WritingStyleSpec {
  return SPECS.get(style) ?? (SPECS.get(DEFAULT_WRITING_STYLE) as WritingStyleSpec);
}

/**
 * A reveal cursor: a float `progress` (monotonic, the ideal position) and the
 * integer `visible` length actually painted. Word granularity keeps `visible`
 * on a word boundary, so it can trail `progress`.
 */
export interface RevealState {
  progress: number;
  visible: number;
}

export function revealStart(): RevealState {
  return { progress: 0, visible: 0 };
}

const WHITESPACE = /\s/;

/** Back up from `candidate` to the end of the previous word, never past
 *  `lowerBound`, so a partial word is never painted. */
function snapToWord(target: string, candidate: number, lowerBound: number): number {
  let index = candidate;
  while (index > lowerBound && !WHITESPACE.test(target[index - 1] ?? "")) {
    index--;
  }
  return index;
}

/**
 * Advance a reveal by one frame. Pure — returns a fresh state and reads
 * nothing outside its arguments, so the preview loop and the live controller
 * share exactly one pacing rule.
 */
export function advanceReveal(
  spec: WritingStyleSpec,
  target: string,
  state: RevealState,
  dtSeconds: number,
): RevealState {
  const total = target.length;
  if (state.progress >= total) {
    return state.visible === total ? state : { progress: total, visible: total };
  }
  if (spec.charsPerSecond <= 0) {
    return { progress: total, visible: total };
  }
  const rate = Math.max(spec.charsPerSecond, (total - state.progress) / spec.maxLagSeconds);
  const progress = Math.min(total, state.progress + rate * dtSeconds);
  let visible = Math.floor(progress);
  if (spec.granularity === "word" && progress < total) {
    visible = snapToWord(target, visible, state.visible);
  }
  return { progress, visible: Math.max(visible, state.visible) };
}
