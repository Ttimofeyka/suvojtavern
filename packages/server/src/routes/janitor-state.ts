/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RouteDeps } from "../routes-deps";

/**
 * Per-app JanitorAI login state.
 *
 * Keyed by the RouteDeps object (not a module singleton) so two apps — or two
 * tests in the same process — never share a login flag. `status` reads it,
 * `login` flips `running` while its background poll is alive (rejecting a
 * concurrent attempt with 409), and successful imports mark the session
 * authenticated so the next status check can answer from cache.
 */
export interface JanitorLoginState {
  /** A login poll is in flight. */
  running: boolean;
  /** Last known authentication result. */
  loggedIn: boolean;
  /** When `loggedIn` was last written (for the status cache). */
  checkedAt: number;
  /**
   * Identity of the in-flight login poll. Bumped on every login start and on
   * logout, so an aborted poll notices it is stale and stops polling (instead
   * of holding `running`/`busy` until its three-minute deadline).
   */
  loginAttempt: number;
}

const states = new WeakMap<RouteDeps, JanitorLoginState>();

export function janitorLoginState(deps: RouteDeps): JanitorLoginState {
  let state = states.get(deps);
  if (state === undefined) {
    state = { running: false, loggedIn: false, checkedAt: 0, loginAttempt: 0 };
    states.set(deps, state);
  }
  return state;
}

/** Record a confirmed live session (used after a successful import/login). */
export function markJanitorLoggedIn(deps: RouteDeps): void {
  const state = janitorLoginState(deps);
  state.loggedIn = true;
  state.checkedAt = Date.now();
}

/** Record a cleared session (logout). */
export function markJanitorLoggedOut(deps: RouteDeps): void {
  const state = janitorLoginState(deps);
  state.loggedIn = false;
  state.checkedAt = Date.now();
}
