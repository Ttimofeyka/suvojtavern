/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LorebookEntryInput } from "@suvoj/core";
import { lorebookGeneration, st } from "@suvoj/core";
import { type Endpoint, GatewayError, resolveEndpoint } from "../gateway";
import { resolveLorebookGenerationProfile } from "../profiles";
import type { RouteDeps } from "../routes-deps";
import { JANITOR_ORIGIN, type JanitorView } from "./browser";
import { getJanitorBrowser } from "./browser-instance";
import { downloadAvatar, fetchCharacterMetadata, probeLogin } from "./client";
import { JanitorError, messageOf, notLoggedInError } from "./errors";
import {
  assertNoNameConflict,
  blobDirFor,
  cardNameOf,
  type JanitorImportResult,
  requireJanitorRef,
} from "./import";
import { emptyLorebookRead, type LorebookScan, persistLorebooks, readLorebooks } from "./lorebooks";

/**
 * Phase B: full JAR-parity extraction.
 *
 * When a character's definition is private, the catalog API returns nothing
 * usable, but JanitorAI still assembles a complete prompt (card + scenario +
 * triggered lorebook entries) and ships it to the client in the
 * `/generateAlpha` response. This module drives a throwaway browser session:
 *
 *  1. switch the account into "extraction mode" — a self-owned dummy proxy
 *     preset is selected (so the client assembles a proxy prompt and fires
 *     `/generateAlpha`) and `context_length` is forced to 0 (so the server
 *     does not truncate and unwrap the persona block);
 *  2. create a `{{user}}` persona so the macro survives substitution;
 *  3. create a fresh chat and auto-trigger it: send "." to read the card from
 *     the captured prompt, then send that card back as a message so as many
 *     closed-lorebook entries as possible fire;
 *  4. isolate the genuinely closed entries with `st.separate` and rebuild them
 *     into a native lorebook through Suvoj's own lorebook-generation LLM
 *     plumbing;
 *  5. import the reconstructed card.
 *
 * The profile snapshot, the throwaway persona (only when we created it) and the
 * temporary chat are always undone in a `finally`, success or failure, so a
 * throw between create and cleanup cannot strand them on the real account.
 *
 * Phase B needs a real, logged-in JanitorAI session (Cloudflare + the live
 * DOM), so it cannot be exercised hermetically — the tests cover the reachable
 * failure paths only.
 */

const API_SETTINGS_URL = `${JANITOR_ORIGIN}/hampter/api-settings`;
const PROXY_CONFIGS_URL = `${API_SETTINGS_URL}/proxy-configs`;
const PERSONAS_URL = `${JANITOR_ORIGIN}/hampter/personas`;
const CHATS_URL = `${JANITOR_ORIGIN}/hampter/chats`;

/** The literal persona name that makes JanitorAI's `{{user}}` substitution a no-op. */
const USER_MACRO_NAME = "{{user}}";

/** JAR's capture windows: a short probe, then the full (lorebook-firing) turn. */
const CAPTURE_TIMEOUT_DOT_MS = 60_000;
const CAPTURE_TIMEOUT_FULL_MS = 120_000;
/** Gap between the probe turn and the full turn (JAR's `settleMs`). */
const SEND_SETTLE_MS = 1_500;

// --- coercion helpers --------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((item) => item !== "");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
  return [];
}

function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

// --- api-settings / extraction mode ------------------------------------------

export interface ExtractionSnapshot {
  selectedProxyConfigId: string | null;
  source: string | null;
  generationSettings: Record<string, unknown> | null;
  dummyServerId: string;
}

/** Random lowercase-alphanumeric string. */
function randomString(len: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/**
 * The throwaway proxy preset. Name/port/key are randomised so the preset is not
 * fingerprintable; `client_id` MUST be fresh every run because the server
 * permanently burns each one (reusing it — even after deleting the preset —
 * answers 409 API_SETTINGS_PROXY_CONFIG_CONFLICT).
 */
function buildDummyPreset(): Record<string, unknown> {
  const port = 8001 + Math.floor(Math.random() * 57000);
  return {
    api_key: `sk-${randomString(48)}`,
    api_url: `http://127.0.0.1:${port}/v1/chat/completions`,
    model: "gpt-4o",
    name: randomString(12),
    prompt_id: null,
    client_id: crypto.randomUUID(),
  };
}

/**
 * An error that never echoes a raw response body. An `api-settings` PATCH body
 * can include the user's proxy configs — `api_key` included — so only the HTTP
 * status and a short, structured `error`/`message` field are surfaced.
 */
function httpFailure(prefix: string, res: { status: number; body: string }): Error {
  const reason = jsonReason(res.body);
  return new Error(`${prefix}: HTTP ${res.status}${reason === "" ? "" : ` (${reason})`}`);
}

/** The top-level `error`/`message` string of a JSON body, capped; "" otherwise. */
function jsonReason(body: string): string {
  try {
    const record = asRecord(JSON.parse(body));
    const message = asString(record.error) || asString(record.message);
    return message.length > 80 ? `${message.slice(0, 80)}…` : message;
  } catch {
    return "";
  }
}

async function getApiSettings(view: JanitorView): Promise<Record<string, unknown>> {
  const res = await view.fetch(API_SETTINGS_URL);
  if (res.status >= 400) throw new Error(`get api-settings failed: HTTP ${res.status}`);
  try {
    return asRecord(JSON.parse(res.body));
  } catch {
    throw new Error("get api-settings: response was not JSON");
  }
}

async function patchApiSettings(view: JanitorView, patch: Record<string, unknown>): Promise<void> {
  const res = await view.fetch(API_SETTINGS_URL, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status >= 400) {
    throw httpFailure("patch api-settings failed", res);
  }
}

/** Create + select the dummy proxy and force `context_length` 0. */
export async function enterExtractionMode(view: JanitorView): Promise<ExtractionSnapshot> {
  const before = await getApiSettings(view);
  const settings = asRecord(before.settings);
  const originalSelectedId = asString(settings.selected_proxy_config_id) || null;
  const originalSource = asString(settings.source) || null;
  const originalGen = isRecord(settings.generation_settings)
    ? (settings.generation_settings as Record<string, unknown>)
    : null;

  const dummy = buildDummyPreset();
  // Build the snapshot up front: the dummy's own client_id is known before any
  // request, so a failure below can always clean up (the caller only receives a
  // snapshot on success, and `restoreProfile(null)` is a no-op).
  const snapshot: ExtractionSnapshot = {
    selectedProxyConfigId: originalSelectedId,
    source: originalSource,
    generationSettings: originalGen,
    dummyServerId: "",
  };

  try {
    const createRes = await view.fetch(PROXY_CONFIGS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dummy),
    });
    if (createRes.status >= 400) {
      throw httpFailure("create proxy-config failed", createRes);
    }
    // The POST body carries our client_id; re-read to resolve the server id.
    const after = await getApiSettings(view);
    const created = asArray(after.proxy_configs)
      .map(asRecord)
      .find((config) => config.client_id === dummy.client_id);
    const dummyServerId = created ? asString(created.id) : "";
    if (dummyServerId === "") throw new Error("dummy proxy preset not found after create");
    snapshot.dummyServerId = dummyServerId;

    // The must-have: select the proxy so the client assembles a proxy prompt.
    await patchApiSettings(view, { selected_proxy_config_id: dummyServerId });
    // Best-effort extras, isolated so a rejection cannot undo the selection.
    try {
      await patchApiSettings(view, { source: "proxy" });
    } catch (err) {
      console.warn("[janitor] could not force source=proxy:", messageOf(err));
    }
    try {
      await patchApiSettings(view, {
        generation_settings: { ...(originalGen ?? {}), context_length: 0 },
      });
    } catch (err) {
      console.warn("[janitor] could not force context_length 0:", messageOf(err));
    }

    return snapshot;
  } catch (error) {
    // Undo whatever landed: the select PATCH can time out AFTER the server
    // applied it, so restore even when the failure was the selection itself.
    // Resolve the server id by re-reading when the lookup never completed.
    const dummyServerId =
      snapshot.dummyServerId !== ""
        ? snapshot.dummyServerId
        : await resolveDummyServerId(view, String(dummy.client_id));
    await restoreProfile(view, { ...snapshot, dummyServerId });
    throw error;
  }
}

/** Re-read `/proxy-configs` to resolve the server id for `clientId`; "" on failure. */
async function resolveDummyServerId(view: JanitorView, clientId: string): Promise<string> {
  try {
    const after = await getApiSettings(view);
    const created = asArray(after.proxy_configs)
      .map(asRecord)
      .find((config) => config.client_id === clientId);
    return created ? asString(created.id) : "";
  } catch {
    return "";
  }
}

/** Restore the original selection/settings and delete the injected dummy. */
export async function restoreProfile(
  view: JanitorView,
  snapshot: ExtractionSnapshot | null,
): Promise<void> {
  if (snapshot === null) return;
  // Always PATCH every field extraction mode may have forced. `enterExtractionMode`
  // writes `source:"proxy"` and `context_length:0` unconditionally, so an absent
  // original must be restored explicitly (null / {}) — skipping it would leave
  // the user's generation routing silently changed.
  const patch: Record<string, unknown> = {
    selected_proxy_config_id: snapshot.selectedProxyConfigId ?? null,
    source: snapshot.source ?? null,
    generation_settings: snapshot.generationSettings ?? {},
  };
  try {
    await patchApiSettings(view, patch);
  } catch (err) {
    console.warn("[janitor] restore api-settings failed:", messageOf(err));
  }
  if (snapshot.dummyServerId !== "") {
    try {
      const res = await view.fetch(`${PROXY_CONFIGS_URL}/${snapshot.dummyServerId}`, {
        method: "DELETE",
      });
      if (res.status >= 400) {
        console.warn(`[janitor] delete dummy proxy-config failed: HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn("[janitor] delete dummy proxy-config failed:", messageOf(err));
    }
  }
}

// --- personas ----------------------------------------------------------------

export interface Persona {
  id: string;
  name: string;
  appearance: string;
  user_id?: string;
}

function toPersona(record: Record<string, unknown>): Persona {
  const userId = asString(record.user_id);
  return {
    id: asString(record.id),
    name: asString(record.name),
    appearance: asString(record.appearance),
    ...(userId === "" ? {} : { user_id: userId }),
  };
}

async function listPersonas(view: JanitorView): Promise<Record<string, unknown>[]> {
  const res = await view.fetch(PERSONAS_URL);
  if (res.status >= 400) throw new Error(`list personas failed: HTTP ${res.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error("list personas: response was not JSON");
  }
  const list = Array.isArray(parsed)
    ? parsed
    : asArray(asRecord(parsed).personas).length > 0
      ? asArray(asRecord(parsed).personas)
      : asArray(asRecord(parsed).data);
  return list.map(asRecord);
}

async function createPersona(view: JanitorView, name: string): Promise<Record<string, unknown>> {
  const res = await view.fetch(PERSONAS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Mirrors the JanitorAI web client's exact payload so the server accepts it.
    body: JSON.stringify({ appearance: "", avatar: "", groupId: null, name, pronouns: null }),
  });
  if (res.status >= 400) {
    throw httpFailure("create persona failed", res);
  }
  try {
    return asRecord(JSON.parse(res.body));
  } catch {
    throw new Error("create persona: response was not JSON");
  }
}

/**
 * The persona a capture injects, plus whether this run created it. Cleanup must
 * delete only the ones we created: a user who already owns a `{{user}}` persona
 * would otherwise lose it.
 */
export interface EnsuredPersona {
  persona: Persona;
  created: boolean;
}

/** Find an existing `{{user}}` persona or create one (idempotent). */
export async function ensureUserMacroPersona(view: JanitorView): Promise<EnsuredPersona> {
  let existing: Record<string, unknown>[] = [];
  try {
    existing = await listPersonas(view);
  } catch (err) {
    // A failed list is non-fatal — fall through and create one.
    console.warn("[janitor] could not list personas:", messageOf(err));
  }
  const found = existing.find((persona) => asString(persona.name) === USER_MACRO_NAME);
  if (found) return { persona: toPersona(found), created: false };
  return { persona: toPersona(await createPersona(view, USER_MACRO_NAME)), created: true };
}

/** Best-effort delete of the throwaway persona; failures are not thrown. */
export async function deletePersona(view: JanitorView, personaId: string): Promise<void> {
  if (personaId === "") return;
  const res = await view.fetch(`${PERSONAS_URL}/${personaId}`, { method: "DELETE" });
  if (res.status >= 400) {
    console.warn(`[janitor] delete persona failed: HTTP ${res.status}`);
  }
}

// --- chats -------------------------------------------------------------------

export async function createChat(view: JanitorView, characterId: string): Promise<string> {
  const res = await view.fetch(CHATS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ character_id: characterId }),
  });
  if (res.status >= 400) {
    throw httpFailure("create chat failed", res);
  }
  let data: Record<string, unknown>;
  try {
    data = asRecord(JSON.parse(res.body));
  } catch {
    throw new Error("create chat: response was not JSON");
  }
  if (data.id === null || data.id === undefined) throw new Error("create chat: no id in response");
  return String(data.id);
}

export async function deleteChat(view: JanitorView, chatId: string): Promise<void> {
  if (chatId === "") return;
  const res = await view.fetch(`${CHATS_URL}/${chatId}`, { method: "DELETE" });
  if (res.status >= 400) {
    console.warn(`[janitor] delete chat ${chatId} failed: HTTP ${res.status}`);
  }
}

// --- interaction: sending a chat message -------------------------------------

/**
 * In-page script that types `text` into the chat composer and sends it.
 *
 * JanitorAI has no send-message API — the only way is to drive the DOM, and its
 * selectors are not stable across releases, so this mirrors JAR's best-effort
 * approach (`findInput` candidates, modal dismissal, abort-then-send). Setting a
 * value on a React-controlled textarea needs the native prototype setter plus a
 * bubbling `input` event, otherwise React never sees the change. Returns a
 * boolean: false when no composer was found.
 */
function buildComposerScript(text: string): string {
  const payload = JSON.stringify(text);
  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SELECTORS = ["textarea[placeholder]", "form textarea", "textarea", "div[contenteditable='true']"];
  const visible = (el) => !!el && el.offsetParent !== null;
  const findInput = () => {
    for (const sel of SELECTORS) {
      const all = document.querySelectorAll(sel);
      for (let i = all.length - 1; i >= 0; i -= 1) {
        if (visible(all[i])) return { el: all[i], sel };
      }
    }
    return null;
  };
  const dismissModals = () => {
    const overlays = document.querySelectorAll('[class*="modalOverlay" i], [class*="ModalOverlay"]');
    if (overlays.length === 0) return;
    const close = document.querySelector('[class*="modal" i] button[aria-label*="close" i], [role="dialog"] button[aria-label*="close" i]');
    if (close) close.click();
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  };
  const abortGeneration = () => {
    const stop = document.querySelector('button[aria-label*="stop" i], button[aria-label*="cancel" i]');
    if (stop && visible(stop)) stop.click();
  };
  const setText = (el, sel, value) => {
    if (sel.indexOf("contenteditable") >= 0) {
      el.focus();
      el.textContent = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      if (document.execCommand) document.execCommand("insertText", false, value);
      if ((el.textContent || "") === "") el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return;
    }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const clickSend = (el) => {
    const isSend = (b) => {
      if (!b || b.offsetParent === null || b.disabled) return false;
      const label = (b.getAttribute("aria-label") || "").toLowerCase();
      return label.indexOf("stop") < 0 && label.indexOf("cancel") < 0;
    };
    const cands = document.querySelectorAll('button[aria-label*="send" i], button[class*="sendButton" i], button[type="submit"]');
    for (let i = 0; i < cands.length; i += 1) {
      if (isSend(cands[i])) { cands[i].click(); return true; }
    }
    const scope = el.closest("form") || el.parentElement;
    if (scope) {
      const btns = Array.prototype.slice.call(scope.querySelectorAll("button")).filter(isSend);
      if (btns.length) { btns[btns.length - 1].click(); return true; }
    }
    return false;
  };
  let found = null;
  for (let i = 0; i < 40 && !found; i += 1) {
    dismissModals();
    found = findInput();
    if (!found) await sleep(300);
  }
  if (!found) return false;
  const { el, sel } = found;
  if (el.scrollIntoView) el.scrollIntoView({ block: "end" });
  dismissModals();
  setText(el, sel, ${payload});
  await sleep(150);
  abortGeneration();
  await sleep(150);
  if (!clickSend(el)) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  }
  return true;
})()`;
}

async function sendMessage(view: JanitorView, text: string): Promise<void> {
  const ok = await view.evaluate<boolean>(buildComposerScript(text));
  if (ok !== true) throw new Error("chat input not found");
}

// --- persona injection + generateAlpha capture --------------------------------

/**
 * Rewrite an outgoing `/generateAlpha` body so it carries our `{{user}}`
 * persona. JanitorAI substitutes the `{{user}}` macro with the active persona's
 * name server-side, so a persona literally called `{{user}}` keeps the macro
 * portable in the capture. Mirrors the real client's request shape.
 */
function applyPersonaOverride(body: Record<string, unknown>, persona: Persona): boolean {
  if (persona.id === "") return false;
  const appearance = persona.appearance;
  const entry = { appearance, id: persona.id, name: persona.name, user_id: persona.user_id };
  body.personas = [entry];
  body.profiles = [{ appearance, id: persona.id, name: persona.name, type: "persona" }];
  if (isRecord(body.chat)) body.chat.persona_id = persona.id;
  return true;
}

export interface Captured {
  url: string;
  payload: Record<string, unknown>;
}

interface CaptureWaiter {
  resolve: (captured: Captured) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A one-at-a-time queue of captured `generateAlpha` payloads. */
function createCaptureQueue() {
  const waiters: CaptureWaiter[] = [];
  return {
    deliver(captured: Captured): void {
      const waiter = waiters.shift();
      if (waiter === undefined) return;
      clearTimeout(waiter.timer);
      waiter.resolve(captured);
    },
    next(timeoutMs: number): Promise<Captured> {
      return new Promise<Captured>((resolve, reject) => {
        const waiter: CaptureWaiter = {
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("timed out waiting for a generateAlpha capture"));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

/** True for an assembled generation payload we can extract a lorebook from. */
function looksLikePayload(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !Array.isArray(value.messages)) return false;
  return value.messages.some(
    (message) =>
      isRecord(message) && message.role === "system" && typeof message.content === "string",
  );
}

/**
 * Parse a captured `generateAlpha` body. The request sets
 * `accept: text/event-stream`, so be defensive: try JSON first, then pull the
 * outermost JSON object out of the text.
 */
function parseGenerateAlphaPayload(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const first = body.indexOf("{");
    const last = body.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    try {
      parsed = JSON.parse(body.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return looksLikePayload(parsed) ? parsed : null;
}

/**
 * Register the `generateAlpha` response hook + persona request-rewrite. Both
 * require a prior `navigate()` on this view (the caller has navigated to the
 * chat page). Awaits the CDP domains so the first `generateAlpha` can neither
 * miss the probe capture nor go out un-rewritten (the real account name would
 * then leak into the rebuilt lorebook). Duplicate bodies are dropped.
 */
async function attachCapture(
  view: JanitorView,
  queue: ReturnType<typeof createCaptureQueue>,
  persona: Persona | null,
): Promise<void> {
  const recent = new Map<string, number>();
  const seen = (body: string): boolean => {
    const now = Date.now();
    for (const [key, at] of recent) {
      if (now - at > 15_000) recent.delete(key);
    }
    let hash = 0;
    for (let i = 0; i < body.length; i += 1) hash = (hash * 31 + body.charCodeAt(i)) | 0;
    const key = `${body.length}:${hash}`;
    if (recent.has(key)) return true;
    recent.set(key, now);
    return false;
  };
  await view.onResponse(
    (url) => url.includes("/generateAlpha"),
    (url, body) => {
      if (seen(body)) return;
      const payload = parseGenerateAlphaPayload(body);
      if (payload !== null) queue.deliver({ url, payload });
    },
  );
  // CDP-side scope is the narrow `*generateAlpha*` glob; the predicate above
  // still decides whether a paused request is actually rewritten.
  await view
    .interceptRequest(
      (url) => url.includes("/generateAlpha"),
      (body) => {
        if (persona === null) return null;
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          return applyPersonaOverride(parsed, persona) ? JSON.stringify(parsed) : null;
        } catch {
          return null;
        }
      },
      "*generateAlpha*",
    )
    .catch((err) => console.warn("[janitor] persona request-rewrite failed:", messageOf(err)));
}

export interface AutoTriggerResult {
  /** The character card read from the "." probe capture. */
  card: string;
  /** The full (lorebook-firing) capture. */
  full: Captured;
}

/**
 * Suppress-then-capture: send "." to read the card from the assembled prompt,
 * then send the card text back so closed-lorebook entries fire on as many keys
 * as possible. The hook and rewrite are registered before anything is sent.
 * `persona`, when set, is injected into the outgoing `/generateAlpha` request.
 */
export async function runAutoTrigger(
  view: JanitorView,
  extraTriggerText: string,
  persona: Persona | null = null,
): Promise<AutoTriggerResult> {
  const queue = createCaptureQueue();
  await attachCapture(view, queue, persona);

  const dotWait = queue.next(CAPTURE_TIMEOUT_DOT_MS);
  await sendMessage(view, ".");
  const dot = await dotWait;

  const card = st.extractCard(dot.payload);
  if (card === "") throw new Error("could not find the character card in the capture");

  const triggerText = extraTriggerText !== "" ? `${card}\n\n${extraTriggerText}` : card;
  await sleep(SEND_SETTLE_MS);
  const fullWait = queue.next(CAPTURE_TIMEOUT_FULL_MS);
  await sendMessage(view, triggerText);
  const full = await fullWait;

  return { card, full };
}

// --- closed-lorebook LLM rebuild ---------------------------------------------

/**
 * System prompt for the closed-lorebook rebuild. Ported from JAR's
 * `SYSTEM_PROMPT`: the input is entry bodies concatenated into a captured
 * prompt, and the model splits them into discrete World Info entries and infers
 * trigger keys (using the character card as context).
 */
const CLOSED_LOREBOOK_SYSTEM_PROMPT = `You reconstruct a SillyTavern World Info (lorebook) from raw text.

You are given text that was extracted from an LLM chat prompt. It contains one or more
lorebook entries that a roleplay platform injected into the prompt because their trigger
keywords matched. The character card and user persona have already been removed; what
remains is lorebook entry bodies concatenated together (often separated by blank lines).

Your job:
1. Split the text into discrete, self-contained World Info entries. Each coherent block
   about one topic (a person, place, faction, item, rule, lore fact) is one entry. Do NOT
   merge unrelated topics; do NOT split a single topic across entries.
2. For each entry, write:
   - "content": the entry body, cleaned up but faithful to the source (keep the facts).
   - "key": an array of primary trigger keywords/phrases a chat would mention to surface
     this entry (names, aliases, places, distinctive nouns). Infer them from the content,
     and from the character card if one is provided as context.
   - "keysecondary": optional array of secondary keywords (leave [] if not needed).
   - "comment": a short title for the entry (the topic name).
   - "order": optional integer insertion order (lower = inserted earlier); default 100.
3. Output ONLY a JSON object of the form:
   { "entries": [ { "comment": "...", "key": ["..."], "keysecondary": [], "content": "...", "order": 100 }, ... ] }
No markdown, no prose, no code fences — JSON only.`;

interface RebuildContext {
  card: string;
  scenario: string;
  name: string;
}

interface RebuildOutcome {
  entries: LorebookEntryInput[];
  warning: string | null;
}

/** Strip code fences and surrounding chatter, then keep the outermost JSON. */
function stripFences(text: string): string {
  let out = text.trim();
  const fence = out.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence?.[1] !== undefined) out = fence[1].trim();
  const first = out.search(/[[{]/);
  const lastObj = out.lastIndexOf("}");
  const lastArr = out.lastIndexOf("]");
  const last = Math.max(lastObj, lastArr);
  if (first >= 0 && last > first) out = out.slice(first, last + 1);
  return out;
}

/** Parse the model's JSON into native entries; tolerates `{entries:[...]}`. */
function parseLorebookEntries(raw: string): LorebookEntryInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : asArray(asRecord(parsed).entries);
  const out: LorebookEntryInput[] = [];
  for (const item of list) {
    const record = asRecord(item);
    const content = asString(record.content).trim();
    if (content === "") continue;
    const constant = record.constant === true;
    out.push({
      keys: toStringArray(record.key ?? record.keys ?? record.keywords),
      secondary: toStringArray(record.keysecondary ?? record.secondary ?? record.secondary_keys),
      content,
      comment: asString(record.comment) || null,
      order: finiteNumber(record.order) ?? 100,
      constant,
      selective: !constant,
    });
  }
  return out;
}

function buildClosedLorebookMessages(
  lorebookText: string,
  context: RebuildContext,
): { role: string; content: string }[] {
  const parts: string[] = [];
  if (context.card !== "") {
    parts.push(
      "CONTEXT — the character card these entries accompany. Use it ONLY to infer " +
        "better trigger keys and resolve names/aliases. Do NOT output any of this card " +
        `text as entries:\n\n${context.card}`,
    );
  }
  if (context.scenario !== "") {
    parts.push(
      "CONTEXT — the scenario / setup for this roleplay. Use it ONLY to infer better " +
        `trigger keys (names, places, situations). Do NOT output any of this as entries:\n\n${context.scenario}`,
    );
  }
  parts.push(`Raw lorebook text to convert into entries:\n\n${lorebookText}`);
  return [
    { role: "system", content: CLOSED_LOREBOOK_SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n\n---\n\n") },
  ];
}

/**
 * Rebuild the isolated closed-lorebook text into entries through Suvoj's own
 * lorebook-generation plumbing (the same config/profile/gateway call the
 * /api/lorebooks/generate-entry route uses). Never throws: an unconfigured or
 * failing LLM degrades to a warning so the card import still succeeds.
 */
async function rebuildClosedLorebook(
  lorebookText: string,
  context: RebuildContext,
  deps: RouteDeps,
): Promise<RebuildOutcome> {
  const config = lorebookGeneration.getLorebookGenerationConfig(deps.repos);
  if (!config.enabled) {
    return {
      entries: [],
      warning: "Lorebook generation is disabled; closed entries were not rebuilt",
    };
  }
  const profile = resolveLorebookGenerationProfile(deps.repos, config.profile_id);
  if (profile === null) {
    return {
      entries: [],
      warning: "No connection profile configured; closed entries were not rebuilt",
    };
  }
  let endpoint: Endpoint;
  try {
    endpoint = await resolveEndpoint(deps.repos, profile);
  } catch (err) {
    // A profile with an empty `base_url` is the same "no usable LLM" class as
    // a missing profile — the rebuild is optional, so degrade to a warning
    // rather than failing the whole card import (the "never throws" contract
    // above). A non-GatewayError is unexpected and still propagates.
    if (err instanceof GatewayError) {
      return {
        entries: [],
        warning: `${err.message}; closed entries were not rebuilt`,
      };
    }
    throw err;
  }
  // JAR pins temperature 0.2 for faithful reconstruction; the profile's other
  // samplers ride along, minus `stream` (the gateway re-adds it).
  const sampling: Record<string, unknown> = { ...profile.sampling, temperature: 0.2 };
  delete sampling.stream;
  sampling.max_tokens = config.max_response_tokens;
  try {
    const result = await deps.gateway.chatCompletion(
      buildClosedLorebookMessages(lorebookText, context),
      sampling,
      { model: profile.model, endpoint },
    );
    const entries = parseLorebookEntries(result.content);
    if (entries.length === 0) {
      return { entries: [], warning: "The model returned no lorebook entries for the closed text" };
    }
    return { entries, warning: null };
  } catch (err) {
    return { entries: [], warning: `Closed-lorebook rebuild failed: ${messageOf(err)}` };
  }
}

// --- reconstructed card -------------------------------------------------------

function mappedDataOf(
  mapped: ReturnType<typeof st.janitorCardFromMetadata>,
): Record<string, unknown> {
  return asRecord((mapped?.card as { data?: unknown } | undefined)?.data);
}

function greetingsOf(data: Record<string, unknown>, capturedFirst: string): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    const text = String(value ?? "").trim();
    if (text !== "" && !out.includes(text)) out.push(text);
  };
  push(data.first_mes);
  if (Array.isArray(data.alternate_greetings)) {
    for (const greeting of data.alternate_greetings) push(greeting);
  }
  if (out.length === 0) push(capturedFirst);
  return out;
}

/**
 * Build a TavernCardV2 from the captured prompt (JAR's `assembleResult`). The
 * card text is the genuine leaked persona block; the scenario/example come from
 * the prompt when present, falling back to whatever the catalog exposed.
 */
function reconstructCard(
  meta: unknown,
  mapped: ReturnType<typeof st.janitorCardFromMetadata>,
  payload: unknown,
): Record<string, unknown> {
  const data = mappedDataOf(mapped);
  const metaRecord = asRecord(meta);
  const greetings = greetingsOf(data, st.extractFirstMessage(payload));
  const name = st.extractCharName(payload) || asString(data.name) || asString(metaRecord.name);
  if (name === "") {
    throw new JanitorError("the captured prompt carried no character name", 400);
  }
  const cardData: Record<string, unknown> = {
    name,
    description: st.extractCard(payload) || asString(data.description),
    personality: "",
    scenario: st.extractScenario(payload) || asString(data.scenario),
    first_mes: greetings[0] ?? "",
    alternate_greetings: greetings.slice(1),
    mes_example: st.extractExample(payload),
    creator_notes: asString(data.creator_notes),
    system_prompt: "",
    post_history_instructions: "",
    tags: Array.isArray(data.tags)
      ? data.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    creator: asString(data.creator),
    character_version: "",
    extensions: {},
  };
  return { spec: "chara_card_v2", spec_version: "2.0", data: cardData };
}

// --- orchestration ------------------------------------------------------------

/** What POST /api/janitor/capture accepts. */
export interface JanitorCaptureInput {
  url: string;
  onConflict?: "error" | "rename" | "replace";
  includeLorebooks?: boolean;
}

function characterPageUrl(id: string): string {
  return `${JANITOR_ORIGIN}/characters/${id}`;
}

function chatPageUrl(chatId: string): string {
  return `${JANITOR_ORIGIN}/chats/${chatId}`;
}

/** Name for the rebuilt closed lorebook: the first closed ref's title, else a fallback. */
function rebuildTitle(scan: LorebookScan, characterName: string): string {
  const [first] = scan.closed;
  if (first !== undefined) {
    const title = first.ref.title.trim();
    if (title !== "") return title;
  }
  return `${characterName} (closed lorebook)`;
}

/**
 * Full-extraction import: capture the assembled prompt, reconstruct the card,
 * rebuild the closed lorebook, and import everything. Requires a logged-in
 * JanitorAI session (400 `not-logged-in` otherwise).
 */
export async function captureAndReconstruct(
  input: JanitorCaptureInput,
  deps: RouteDeps,
): Promise<JanitorImportResult> {
  const { id } = requireJanitorRef(input.url);
  const onConflict = input.onConflict ?? "error";
  const includeLorebooks = input.includeLorebooks !== false;
  const browser = getJanitorBrowser(deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const blobDir = blobDirFor(deps);

  return browser.withView(
    async (view) => {
      await view.navigate(JANITOR_ORIGIN);
      if (!(await probeLogin(view))) throw notLoggedInError();

      const meta = await fetchCharacterMetadata(view, id);
      if (meta === null) {
        throw new JanitorError(`could not read JanitorAI character ${id}`, 400);
      }
      const mapped = st.janitorCardFromMetadata(meta);
      const cardPublic = st.janitorIsCardPublic(meta);
      const warnings: string[] = [];

      // Read public books up front: their contents are needed to subtract the
      // public entries out of the captured closed-lorebook text.
      const read =
        includeLorebooks && mapped !== null
          ? await readLorebooks(view, mapped.lorebooks)
          : emptyLorebookRead();

      let snapshot: ExtractionSnapshot | null = null;
      try {
        snapshot = await enterExtractionMode(view);
      } catch (err) {
        warnings.push(`could not enter extraction mode: ${messageOf(err)}`);
      }

      let createdPersonaId: string | null = null;
      let chatId: string | null = null;
      try {
        await view.navigate(characterPageUrl(id)).catch(() => {});
        let persona: Persona | null = null;
        try {
          const ensured = await ensureUserMacroPersona(view);
          persona = ensured.persona;
          // Only a persona WE created is ours to delete; a user-owned
          // `{{user}}` persona must survive the run.
          if (ensured.created) createdPersonaId = ensured.persona.id;
        } catch (err) {
          warnings.push(`could not create the {{user}} persona: ${messageOf(err)}`);
        }

        chatId = await createChat(view, id);
        const chatUrl = chatPageUrl(chatId);
        await view.navigate(chatUrl);
        // JanitorAI caches the selected proxy preset client-side, so a single
        // load may still assemble the old prompt; reload once to force it.
        await view.navigate(chatUrl).catch(() => {});

        const firstMessage = asString(asRecord(meta).first_message);
        const { full } = await runAutoTrigger(view, firstMessage, persona);

        const sep = st.separate(full.payload, "", read.publicContents);
        const closedText = sep.lorebookText;

        const card =
          cardPublic && mapped !== null ? mapped.card : reconstructCard(meta, mapped, full.payload);
        assertNoNameConflict(deps.repos, cardNameOf(card), onConflict);

        const avatar =
          mapped !== null && mapped.avatarFile !== null
            ? await downloadAvatar(fetchImpl, mapped.avatarFile)
            : null;
        const imported = await st.importCardFromJson(card, deps.repos, {
          onConflict,
          blobDir,
          sourcePng: avatar ?? undefined,
        });

        const scan = persistLorebooks(read, deps.repos, imported.character);

        if (includeLorebooks && closedText.trim() !== "") {
          const mappedData = mappedDataOf(mapped);
          const rebuild = await rebuildClosedLorebook(
            closedText,
            {
              card: st.extractCard(full.payload),
              scenario: st.extractScenario(full.payload) || asString(mappedData.scenario),
              name: imported.character.name,
            },
            deps,
          );
          if (rebuild.warning !== null) {
            warnings.push(rebuild.warning);
          } else {
            const book = deps.repos.lorebooks.create({
              name: rebuildTitle(scan, imported.character.name),
              description: "Rebuilt from a closed JanitorAI lorebook via the captured prompt",
            });
            deps.repos.lorebooks.replaceEntries(book.id, rebuild.entries);
            deps.repos.lorebooks.attachToCharacter(imported.character.id, book.id);
            if (scan.first === null) scan.first = book;
            if (scan.closed.length > 0) {
              // Each closed ref now points at the one rebuilt book.
              for (const closed of scan.closed) {
                closed.outcome.id = book.id;
                closed.outcome.status = "imported";
                closed.outcome.entries = rebuild.entries.length;
              }
            } else {
              scan.outcomes.push({
                id: book.id,
                title: book.name,
                status: "imported",
                entries: rebuild.entries.length,
              });
            }
          }
        }
        warnings.push(...scan.warnings);

        return {
          character: imported.character,
          lorebook: scan.first,
          lorebooks: scan.outcomes,
          renamed: imported.renamed,
          source: "janitor",
          definitionSource: cardPublic ? "public" : "reconstructed",
          warnings,
        } satisfies JanitorImportResult;
      } finally {
        // Always undo the extraction-mode profile and anything we injected, even
        // when the capture or import threw: a live chat, stray persona or dummy
        // preset left behind is permanent clutter on the user's real account.
        if (chatId !== null) {
          try {
            await deleteChat(view, chatId);
          } catch (err) {
            console.warn("[janitor] delete chat failed:", messageOf(err));
          }
        }
        if (createdPersonaId !== null) {
          try {
            await deletePersona(view, createdPersonaId);
          } catch (err) {
            console.warn("[janitor] delete persona failed:", messageOf(err));
          }
        }
        try {
          await restoreProfile(view, snapshot);
        } catch (err) {
          console.warn("[janitor] restore profile failed:", messageOf(err));
        }
      }
    },
    { mode: "background" },
  );
}
