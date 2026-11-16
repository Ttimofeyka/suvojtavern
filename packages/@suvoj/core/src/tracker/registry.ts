/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PromptMessage } from "../engine/prompt";
import type { Character } from "../schema/characters";
import type { Chat } from "../schema/chats";
import type { Persona } from "../schema/personas";
import type { TrackerConfig } from "../schema/tracker";
import { suvojTrackerMechanism } from "./mechanism-suvoj-tracker";
import type { TrackerSchemaPart } from "./parts";

/**
 * Tracker mechanisms — customizable tracker generation (the Suvoj Tracker
 * surface), mirroring the memory-strategy registry (engine/memory).
 *
 * A mechanism turns a generation input into prompt messages and parses the
 * raw model response back into tracker data. The engine itself never
 * performs HTTP calls: the server runs the messages through a gateway and
 * hands the raw reply back to `parseResponse`.
 */

/** The tracker state of one snapshot (the `data` column, parsed). */
export type TrackerData = Record<string, unknown>;

/** Everything a mechanism needs to build its generation prompt. */
export interface TrackerGenerationInput {
  chat: Chat;
  character: Character | null;
  persona: Persona | null;
  /** Windowed chat messages (the server pre-builds, active variants only). */
  messages: PromptMessage[];
  /** Previous tracker snapshots, oldest → newest. */
  previousTrackers: TrackerData[];
  config: TrackerConfig;
  /** The ACTIVE schema preset's schema object. */
  schema: Record<string, unknown>;
  /**
   * Resolved generation plan, one entry per request (length >= 1).
   * Single-request mechanisms may ignore it.
   */
  parts: TrackerSchemaPart[];
}

/** One request a multi-request mechanism asks the server to run. */
export interface TrackerGenerationRequest {
  messages: PromptMessage[];
}

/** One tracker generation mechanism, registered by id. */
export interface TrackerMechanism {
  /** Kebab-case id; `suvoj-tracker` is RESERVED for the built-in. */
  id: string;
  name: string;
  description?: string;
  /** Builds the messages sent to the tracker model. */
  buildGenerationMessages(input: TrackerGenerationInput): PromptMessage[];
  /** Parses the raw model response; throws on failure. */
  parseResponse(raw: string, input: TrackerGenerationInput): TrackerData;
  /**
   * When this AND `parseResponses` are present the server runs every request
   * in parallel (each through the tracker profile) and merges via
   * `parseResponses`; otherwise the required single-request pair runs once.
   */
  buildGenerationRequests?(input: TrackerGenerationInput): TrackerGenerationRequest[];
  /** Parses the parallel responses; `raws` is aligned with the request array. */
  parseResponses?(raws: string[], input: TrackerGenerationInput): TrackerData;
}

const mechanisms = new Map<string, TrackerMechanism>();

/** Registers (or replaces) a tracker mechanism by id. */
export function registerTrackerMechanism(mechanism: TrackerMechanism): void {
  mechanisms.set(mechanism.id, mechanism);
}

export function getTrackerMechanism(id: string): TrackerMechanism | undefined {
  return mechanisms.get(id);
}

export function listTrackerMechanisms(): TrackerMechanism[] {
  return [...mechanisms.values()];
}

/**
 * Removes a registered mechanism by id; returns whether one was registered.
 * Built-in ids are refused (returns false): a plugin mechanism reusing one
 * could otherwise never be removed, or shadow the built-in permanently.
 */
export function unregisterTrackerMechanism(id: string): boolean {
  if (BUILTIN_TRACKER_MECHANISM_IDS.includes(id)) {
    return false;
  }
  return mechanisms.delete(id);
}

/** Test hook: removes every registered mechanism. */
export function resetTrackerMechanisms(): void {
  mechanisms.clear();
}

// Built-in (its imports from this module are type-only → no runtime cycle).
export { suvojTrackerMechanism };

registerTrackerMechanism(suvojTrackerMechanism);

/** Re-registers the built-in tracker mechanism (after a test reset). */
export function registerBuiltinTrackerMechanisms(): void {
  registerTrackerMechanism(suvojTrackerMechanism);
}

/**
 * Ids of the built-in mechanisms, derived from the same object registered
 * above (so the list cannot drift). Plugin-declared mechanisms must not use
 * them: the plugin loader rejects such definitions upfront (see the
 * memory-strategy / pipeline-stage equivalents).
 */
export const BUILTIN_TRACKER_MECHANISM_IDS: readonly string[] = [suvojTrackerMechanism.id];
