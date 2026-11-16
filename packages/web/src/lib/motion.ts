/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * SuvojTavern motion foundation — the JS half of the animation system.
 *
 * The CSS half (styles/motion.css + the duration tokens in tokens.css)
 * predates this file and stays in place for the existing `.anim-*` call
 * sites. This module is the Motion-library equivalent: one hook that every
 * JS-driven animation reads so the whole app speaks a single motion language
 * and honours BOTH reduced-motion signals at once:
 *
 *   1. the OS `prefers-reduced-motion` media query (via Motion's
 *      `useReducedMotion`), and
 *   2. the app's own `designAtom.motion` knob ("off" | "subtle" | "full"),
 *      which is what Settings → Appearance exposes and what
 *      `--motion-scale` already drives for CSS animations.
 *
 * The two are collapsed into a single `reduce` flag plus a duration/spring
 * scale, so a consumer only ever asks *this* module for a transition and
 * automatically degrades under either signal. Under `reduce` every duration
 * and spring collapses to a zero-duration tween: the animation still runs
 * (state changes land, `onAnimationComplete`/`onExitComplete` still fire)
 * but it lands in a single frame, which is what "no motion" should mean.
 *
 * Motion durations are SECONDS (unlike the CSS tokens' ms), so the base
 * values below intentionally mirror `--dur-*` / `--dur-page` from tokens.css
 * divided by 1000. Keep the two in sync if either changes.
 */

import { useAtomValue } from "jotai";
import type { MotionProps } from "motion/react";
import { useReducedMotion } from "motion/react";
import { useMemo } from "react";
import type { MotionIntensity } from "../stores/design";
import { designAtom } from "../stores/design";

/**
 * Motion's own transition/variants shapes, derived from the library's public
 * `MotionProps` rather than imported from `motion-dom` directly: motion-dom is
 * a transitive dependency (framer-motion → motion-dom), not a declared one, so
 * importing its types by name would be a phantom dependency that breaks the
 * moment Bun hoists differently. `NonNullable` strips the optional `undefined`
 * from the prop type.
 */
export type MotionTransition = NonNullable<MotionProps["transition"]>;
export type MotionVariants = NonNullable<MotionProps["variants"]>;

/** tokens.css --ease-out, as the cubic-bezier tuple Motion wants. */
const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** tokens.css --dur-* / --dur-page in seconds. */
const BASE_DURATION = {
  fast: 0.12,
  med: 0.2,
  slow: 0.32,
  panel: 0.24,
  page: 0.36,
} as const;

/**
 * `designAtom.motion === "subtle"` runs the same choreography faster. The
 * factor mirrors `--motion-scale: 0.6` in design.css so the CSS and JS halves
 * of the app slow down together.
 */
const SUBTLE_FACTOR = 0.6;

/** The one transition that means "land immediately" (still completes/emits). */
export const INSTANT: MotionTransition = { duration: 0 };

/**
 * Spring presets, slowest to quickest. Type is `spring` with stiffness/
 * damping/mass (not `visualDuration`) so they behave identically across the
 * Motion version range and compose with the reduced-motion collapse below.
 *  - gentle: no overshoot, for panels and large surfaces;
 *  - soft:   the default — a hint of settle, still calm;
 *  - snappy: tactile feedback (pressed chips, the segmented indicator).
 */
export const springGentle: MotionTransition = {
  type: "spring",
  stiffness: 180,
  damping: 26,
  mass: 0.9,
};
export const springSoft: MotionTransition = {
  type: "spring",
  stiffness: 320,
  damping: 30,
  mass: 0.8,
};
export const springSnappy: MotionTransition = {
  type: "spring",
  stiffness: 520,
  damping: 36,
  mass: 0.7,
};

/** Scaled duration values, in seconds. */
export interface MotionDurations {
  fast: number;
  med: number;
  slow: number;
  /** Floating-layer entrance (modal panels, popovers). */
  panel: number;
  /** Route/view roots. */
  page: number;
}

/** The resolved motion configuration every consumer reads. */
export interface AppMotion {
  /** True when the OS or the app's motion knob asks for no animation. */
  reduce: boolean;
  /** The raw app knob, for consumers that need to branch on it. */
  intensity: MotionIntensity;
  /** Spring transitions; all three are `INSTANT` under `reduce`. */
  spring: {
    gentle: MotionTransition;
    soft: MotionTransition;
    snappy: MotionTransition;
  };
  /** Duration values in seconds; all zero under `reduce`. */
  duration: MotionDurations;
  /** Base tween transition (med duration + the house ease). */
  transition: MotionTransition;
  /** Base transition plus a delay in seconds; delay is dropped under `reduce`. */
  withDelay(seconds: number): MotionTransition;
}

const ZERO_DURATION: MotionDurations = { fast: 0, med: 0, slow: 0, panel: 0, page: 0 };

/**
 * Read the resolved motion configuration. This is THE entry point: build every
 * transition from the returned object rather than hardcoding one, so the
 * reduced-motion and motion-intensity preferences apply for free.
 */
export function useAppMotion(): AppMotion {
  // `useReducedMotion` returns boolean | null (null before hydration / in a
  // non-browser environment); only an explicit `true` reduces.
  const prefersReduced = useReducedMotion() === true;
  const intensity = useAtomValue(designAtom).motion;
  const reduce = prefersReduced || intensity === "off";

  return useMemo<AppMotion>(() => {
    if (reduce) {
      return {
        reduce: true,
        intensity,
        spring: { gentle: INSTANT, soft: INSTANT, snappy: INSTANT },
        duration: ZERO_DURATION,
        transition: INSTANT,
        withDelay: () => INSTANT,
      };
    }

    const factor = intensity === "subtle" ? SUBTLE_FACTOR : 1;
    const duration: MotionDurations = {
      fast: BASE_DURATION.fast * factor,
      med: BASE_DURATION.med * factor,
      slow: BASE_DURATION.slow * factor,
      panel: BASE_DURATION.panel * factor,
      page: BASE_DURATION.page * factor,
    };
    const transition: MotionTransition = { duration: duration.med, ease: EASE_OUT };

    return {
      reduce: false,
      intensity,
      spring: { gentle: springGentle, soft: springSoft, snappy: springSnappy },
      duration,
      transition,
      // A reduced-motion consumer never reaches this branch, so no delay guard
      // is needed here; the `reduce` branch above already returns INSTANT.
      withDelay: (seconds: number) => ({ ...transition, delay: seconds }),
    };
  }, [reduce, intensity]);
}

/*
 * Variant builders. Every primitive and feature phase composes these instead
 * of inventing per-component keyframes, so entrance/exit distances and easing
 * stay identical across the app. Each returns Motion's `variants` shape keyed
 * `hidden` / `visible` / `exit`; consumers wire them with
 * `initial="hidden" animate="visible" exit="exit"`.
 */

/** Opacity only — cheap, for content that should not move. */
export function fadeVariants(motion: AppMotion): MotionVariants {
  return {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: motion.transition },
    exit: { opacity: 0, transition: motion.transition },
  };
}

/** Fade + upward rise — the default content entrance. */
export function riseVariants(motion: AppMotion, distance = 8): MotionVariants {
  return {
    hidden: { opacity: 0, y: distance },
    visible: { opacity: 1, y: 0, transition: motion.transition },
    // Exits travel half the distance: leaving should read as a dismissal, not
    // a reversal, and the shorter move keeps the unmount from feeling slow.
    exit: { opacity: 0, y: distance / 2, transition: motion.transition },
  };
}

/** Fade + scale pop — for floating layers and small status surfaces. */
export function scaleVariants(motion: AppMotion, from = 0.97): MotionVariants {
  return {
    hidden: { opacity: 0, scale: from },
    visible: { opacity: 1, scale: 1, transition: motion.transition },
    exit: { opacity: 0, scale: from, transition: motion.transition },
  };
}

/**
 * Dialog/panel choreography: a spring pop with a touch of rise, and a faster
 * tween on the way out (a dismissal should not linger). Under reduced motion
 * both collapse to `INSTANT`.
 */
export function panelVariants(motion: AppMotion): MotionVariants {
  return {
    hidden: { opacity: 0, scale: 0.98, y: 6 },
    visible: {
      opacity: 1,
      scale: 1,
      y: 0,
      transition: motion.reduce ? INSTANT : motion.spring.soft,
    },
    exit: {
      opacity: 0,
      scale: 0.99,
      y: 2,
      // `motion.transition` is already zero-duration under reduce, so this
      // stays instant without another branch.
      transition: { ...motion.transition, duration: motion.duration.fast },
    },
  };
}

/** Scrim fade for modal overlays — always a plain opacity tween. */
export function backdropVariants(motion: AppMotion): MotionVariants {
  return {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { duration: motion.duration.fast, ease: EASE_OUT } },
    exit: { opacity: 0, transition: { duration: motion.duration.fast, ease: EASE_OUT } },
  };
}

/**
 * Container variant for staggered list reveals. Children must carry a variant
 * with matching keys (e.g. `riseVariants`) for `staggerChildren` to sequence
 * them. The delay is zeroed under reduced motion so nothing arrives late.
 */
export function staggerContainer(motion: AppMotion, step = 0.05): MotionVariants {
  return {
    hidden: {},
    visible: {
      transition: motion.reduce
        ? {}
        : { staggerChildren: step, delayChildren: 0.02, when: "beforeChildren" },
    },
  };
}
