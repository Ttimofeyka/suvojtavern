/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  type Character,
  type Chat,
  type engine,
  type Persona,
  type TrackerConfig,
  type TrackerSnapshot,
  tracker,
} from "@suvoj/core";
import { resolveEndpoint } from "../gateway";
import { resolveTrackerProfile } from "../profiles";
import type { Repos, RouteDeps } from "../routes-deps";

/**
 * The tracker generation service (the Suvoj Tracker surface): resolves the
 * tracker config, builds the mechanism's prompt over the chat's
 * active-variant history, runs it through the gateway on the tracker's
 * own connection profile, parses the response, and persists the snapshot
 * (pruned to `keep_last`).
 *
 * Failure classes: {@link TrackerRequestError} covers request-shaped
 * failures the routes answer with 400 (tracker disabled, nothing to
 * track, no connection profile); every other throw — gateway and parse
 * failures — is upstream-shaped and answers 502.
 */

/** 400-class tracker failure (disabled chat state / configuration). */
export class TrackerRequestError extends Error {}

/**
 * The resolved chat context the tracker (and plugin drawer tabs) build
 * from: the chat, its character and persona (mirroring
 * `engine.prepareGeneration`'s field access), and the windowed
 * active-variant history as gateway-ready PromptMessages.
 */
export interface ChatContext {
  chat: Chat;
  character: Character | null;
  persona: Persona | null;
  messages: engine.PromptMessage[];
}

/**
 * Loads a chat's context: chat → character (by `chat.character_id`) →
 * persona (by `chat.persona_id`), plus the ACTIVE-variant history
 * (`repos.messages.listActive` — the same single source of truth
 * `engine.prepareGeneration` assembles from), windowed to the newest
 * `includeLastMessages` messages (0 = all). `throughSeq` bounds the history
 * to positions at or before that chat position (inclusive), which the
 * `after_user_message` mode uses to track the PREVIOUS reply while the new
 * user turn is already persisted. Returns null when the chat is unknown.
 * Shared by the tracker service and the plugin host's panel-data surface —
 * do NOT invent a second variant filter.
 */
export function loadChatContext(
  repos: Repos,
  chatId: string,
  opts?: { includeLastMessages?: number; throughSeq?: number },
): ChatContext | null {
  const chat = repos.chats.get(chatId);
  if (!chat) {
    return null;
  }
  const character = repos.characters.get(chat.character_id) ?? null;
  const persona = chat.persona_id ? (repos.personas.get(chat.persona_id) ?? null) : null;
  const history = repos.messages.listActive(chat.id);
  const throughSeq = opts?.throughSeq;
  const scoped =
    throughSeq === undefined ? history : history.filter((message) => message.seq <= throughSeq);
  const includeLast = opts?.includeLastMessages ?? 0;
  const window = includeLast > 0 ? scoped.slice(-includeLast) : scoped;
  return {
    chat,
    character,
    persona,
    messages: window.map((message) => ({
      role: message.role,
      content: message.content,
      name: message.name ?? undefined,
    })),
  };
}

/** The active schema preset's rendering, falling back to the defaults. */
function renderFor(config: TrackerConfig): { html: string; css: string } {
  const preset = config.schema_presets[config.active_schema_key];
  return {
    html: preset?.html || tracker.DEFAULT_TRACKER_HTML,
    css: preset?.css || tracker.DEFAULT_TRACKER_CSS,
  };
}

/** One generated tracker: the persisted snapshot + its rendering. */
export interface TrackerGenerateResult {
  snapshot: TrackerSnapshot;
  render: { html: string; css: string };
}

/**
 * Generates one tracker snapshot for the chat and persists it.
 *
 * Swipe-aware attachment: the snapshot lands on ONE message ROW. `opts.
 * message_id` names it explicitly (the after_reply path passes the persisted
 * reply's id; after_user_message passes the reply the new user turn
 * follows); otherwise the current tail's ACTIVE message is the target (the
 * manual and before_reply paths). An explicit target ALSO bounds the tracker
 * prompt to history at or before its position, so a target behind the tail
 * never sees messages sent after it. The `previousTrackers` handed to the
 * model are the SELECTED-swipe trackers of positions STRICTLY BEFORE the
 * target's `seq`, so a regenerated/new swipe generates from zero — its own
 * sibling group (including the tracker of the swipe it replaces) is never
 * fed back.
 *
 * The active schema preset's `parts` config resolves the generation into
 * one or more REQUESTS (see `buildTrackerParts`). A mechanism that declares
 * the optional `buildGenerationRequests` + `parseResponses` pair builds the
 * request list itself; otherwise the required single-request pair runs
 * once. Every request runs in PARALLEL through the tracker's connection
 * profile (the profile's samplers with the 0.3 temperature guard and no
 * stream, `max_tokens` overridden by the config's `max_response_tokens`),
 * sharing the same sampling and options. The replies are parsed (merging
 * the parts on the multi path) and the created snapshot is pruned to
 * `keep_last` (pruning never deletes the newest).
 *
 * Failure is atomic: a gateway error or an unparseable part throws and
 * nothing is persisted, so a half-generated split can never become a
 * snapshot — retry from the panel. A missing mechanism falls back to the
 * built-in `suvoj-tracker` with a warning — never breaking the chat flow.
 */
export async function generateTrackerSnapshot(
  deps: RouteDeps,
  chatId: string,
  opts?: { signal?: AbortSignal; message_id?: string | null },
): Promise<TrackerGenerateResult> {
  const config = tracker.getTrackerConfig(deps.repos);
  if (!config.enabled) {
    throw new TrackerRequestError("Tracker is disabled");
  }
  const chat = deps.repos.chats.get(chatId);
  if (!chat) {
    throw new TrackerRequestError("Chat not found");
  }
  // The per-chat switch: the global config is the master, this column lets one
  // chat opt out. Checked after the config gate so the two failure classes
  // stay distinct (global off vs. this chat off).
  if (!chat.tracker_enabled) {
    throw new TrackerRequestError("Tracker is disabled for this chat");
  }

  // The swipe this snapshot attaches to. An explicit `message_id` wins (the
  // after_reply path passes the persisted reply's id; after_user_message
  // passes the previous reply); otherwise the target is the current tail's
  // ACTIVE message. The row must exist AND belong to this chat: a stale or
  // foreign id would persist an orphan snapshot the swipe-aware reads can
  // never surface.
  const active = deps.repos.messages.listActive(chatId);
  const targetId = typeof opts?.message_id === "string" ? opts.message_id : active.at(-1)?.id;
  if (!targetId) {
    throw new TrackerRequestError("No messages to track yet");
  }
  const target = deps.repos.messages.get(targetId);
  if (!target || target.chat_id !== chatId) {
    throw new TrackerRequestError("Message not found");
  }

  // The prompt is read THROUGH the target's position. For after_reply the
  // target is the tail, so this is the full active history (unchanged); for
  // after_user_message the target sits one position behind the just-persisted
  // user turn, which therefore never enters the tracker's context.
  const context = loadChatContext(deps.repos, chatId, {
    includeLastMessages: config.include_last_messages,
    throughSeq: target.seq,
  });
  if (!context) {
    throw new TrackerRequestError("Chat not found");
  }
  if (context.messages.length === 0) {
    throw new TrackerRequestError("No messages to track yet");
  }

  let mechanism = tracker.getTrackerMechanism(config.mechanism);
  if (!mechanism) {
    console.warn(
      `Tracker mechanism '${config.mechanism}' not found, falling back to built-in suvoj-tracker`,
    );
    mechanism = tracker.getTrackerMechanism("suvoj-tracker");
  }
  if (!mechanism) {
    throw new TrackerRequestError(`Tracker mechanism '${config.mechanism}' not available`);
  }

  const profile = resolveTrackerProfile(deps.repos, config.profile_id);
  if (!profile) {
    throw new TrackerRequestError("No connection profile configured");
  }
  // The profile's upstream (its own base URL + key) — every request below
  // runs against it.
  const endpoint = await resolveEndpoint(deps.repos, profile);

  const preset = config.schema_presets[config.active_schema_key];
  const schema = preset?.schema ?? tracker.DEFAULT_TRACKER_SCHEMA;
  const input: tracker.TrackerGenerationInput = {
    chat: context.chat,
    character: context.character,
    persona: context.persona,
    messages: context.messages,
    // Only the SELECTED-swipe trackers of positions strictly BEFORE the
    // target's own: `listForMessagesBefore` filters by position, so the
    // target's whole sibling group (every swipe sharing its `seq`) is
    // excluded. A fresh swipe therefore generates "from zero" instead of
    // absorbing the tracker of the swipe it replaces.
    previousTrackers:
      config.include_last_trackers > 0
        ? deps.repos.trackers
            .listForMessagesBefore(chatId, target.seq, config.include_last_trackers)
            .map((snapshot) => snapshot.data)
        : [],
    config,
    schema,
    // The preset's split resolved into one request per field group (always
    // at least one; a non-split preset reuses the ORIGINAL schema).
    parts: tracker.buildTrackerParts(schema, preset?.parts),
  };

  // Multi-request mechanisms opt in by declaring BOTH methods (the loader
  // rejects a lone one). Aliased-condition narrowing (TS 4.4+) proves both
  // callable inside `if (multiRequest)`; `.call(mechanism, …)` preserves the
  // receiver a plugin's implementation may rely on (`this`).
  const buildRequests = mechanism.buildGenerationRequests;
  const parseResponses = mechanism.parseResponses;
  const multiRequest = buildRequests !== undefined && parseResponses !== undefined;
  const requests: tracker.TrackerGenerationRequest[] = multiRequest
    ? buildRequests.call(mechanism, input)
    : [{ messages: mechanism.buildGenerationMessages(input) }];
  if (requests.length === 0) {
    // Contract violation: a mechanism that resolves no request has nothing
    // to ask the model — fail loudly instead of persisting an empty snapshot.
    throw new Error("Tracker mechanism produced no generation requests");
  }

  // Same profile-sampling clone as the summarizer bridge (see
  // makeSummarizeFn): the profile's samplers minus stream, temperature
  // pinned to the 0.3 guard, max_tokens overridden by the tracker config.
  const sampling: Record<string, unknown> = { ...profile.sampling, temperature: 0.3 };
  delete sampling.stream;
  sampling.max_tokens = config.max_response_tokens;

  // All parts run in PARALLEL through the same profile/options, so a split
  // costs no more wall-clock than its slowest request. Promise.all rejects on
  // the first failure, leaving nothing to persist.
  const completions = await Promise.all(
    requests.map((request) =>
      deps.gateway.chatCompletion(request.messages, sampling, {
        signal: opts?.signal,
        model: profile.model || undefined,
        endpoint,
      }),
    ),
  );

  // Parse only after every reply arrived: a single unparseable part throws
  // and aborts the whole generation before any repo write (atomic).
  let data: tracker.TrackerData;
  if (multiRequest) {
    data = parseResponses.call(
      mechanism,
      completions.map((completion) => completion.content),
      input,
    );
  } else {
    data = mechanism.parseResponse(completions[0]?.content ?? "", input);
  }

  const snapshot = deps.repos.trackers.create(chatId, {
    message_id: target.id,
    data,
    schema_key: config.active_schema_key,
  });
  deps.repos.trackers.pruneTo(chatId, config.keep_last);
  return { snapshot, render: renderFor(config) };
}

/** The wire shape of one tracker snapshot (repo row minus chat_id/seq). */
export interface TrackerSnapshotDTO {
  id: string;
  message_id: string | null;
  schema_key: string;
  data: Record<string, unknown>;
  created_at: string;
}

/** Maps a snapshot row to its wire shape. */
export function trackerSnapshotDTO(snapshot: TrackerSnapshot): TrackerSnapshotDTO {
  return {
    id: snapshot.id,
    message_id: snapshot.message_id,
    schema_key: snapshot.schema_key,
    data: snapshot.data,
    created_at: snapshot.created_at,
  };
}

/** The GET/POST tracker response shape. */
export interface TrackerSummaryPayload {
  /** The GLOBAL master switch (`tracker_config.enabled`). */
  enabled: boolean;
  /** This chat's own switch (`chats.tracker_enabled`). Tracking runs only
   *  when both are on; the drawer reads this to render its toggle. */
  chat_enabled: boolean;
  invisible: boolean;
  mechanism: string;
  snapshot: TrackerSnapshotDTO | null;
  /** Present whenever the tracker is enabled — even without a snapshot. */
  render: { html: string; css: string } | null;
}

/**
 * The shared tracker summary payload: the resolved config flags plus the
 * SELECTED swipe's newest snapshot — the same read the `tracker` pipeline stage
 * injects from, so the drawer and the prompt never disagree — and the active
 * schema preset's rendering. Disabled → `snapshot` and `render` null. Used by
 * GET and POST /tracker and the SSE integration.
 */
export function trackerSummaryPayload(repos: Repos, chatId: string): TrackerSummaryPayload {
  const config = tracker.getTrackerConfig(repos);
  // An unknown chat reports the global switch alone (there is no row to opt
  // out of); a known chat folds its own flag in. The panel keeps rendering
  // while the GLOBAL switch is on even if this chat is off, so the toggle
  // stays reachable.
  const chat = repos.chats.get(chatId);
  const chatEnabled = chat === null || chat.tracker_enabled;
  if (!config.enabled) {
    return {
      enabled: false,
      chat_enabled: chatEnabled,
      invisible: config.invisible,
      mechanism: config.mechanism,
      snapshot: null,
      render: null,
    };
  }
  // The panel shows the newest snapshot attached to a SELECTED swipe — the
  // exact read the pipeline stage injects from (`listForActiveMessages`), so
  // the card and the prompt can never disagree. That matters after an undo:
  // deleting the trailing messages leaves the tail untracked while the
  // surviving tracker (however many positions back) is still what the model is
  // fed, and a raw-position window would blank the panel on a tracker that is
  // live in the prompt.
  const latest = repos.trackers.listForActiveMessages(chatId, 1).at(-1);
  return {
    enabled: true,
    chat_enabled: chatEnabled,
    invisible: config.invisible,
    mechanism: config.mechanism,
    snapshot: latest ? trackerSnapshotDTO(latest) : null,
    render: renderFor(config),
  };
}

/** One message ROW's tracker: its newest snapshot and the active preset's rendering. */
export interface TrackerForMessagePayload {
  snapshot: TrackerSnapshotDTO | null;
  render: { html: string; css: string } | null;
}

/**
 * The per-row tracker payload behind GET /api/messages/:id/tracker: the NEWEST
 * snapshot attached to one message row plus the active schema preset's
 * rendering. Deliberately NOT gated on the tracker master switch or injection
 * settings — a row that already carries a snapshot stays viewable after the
 * tracker is disabled (the snapshot is persisted data, not a live setting).
 * `render` is present iff a snapshot is, so an untracked/unknown id yields
 * `{ snapshot: null, render: null }` (idempotent read, like the per-row DELETE).
 */
export function trackerSnapshotForMessage(
  repos: Repos,
  messageId: string,
): TrackerForMessagePayload {
  const snapshot = repos.trackers.getForMessage(messageId);
  if (!snapshot) {
    return { snapshot: null, render: null };
  }
  return {
    snapshot: trackerSnapshotDTO(snapshot),
    render: renderFor(tracker.getTrackerConfig(repos)),
  };
}
