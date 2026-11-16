/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JanitorBrowserHandle } from "../routes-deps";
import type { JanitorBrowserStatus, JanitorView } from "./browser";

/**
 * Hermetic test doubles for the JanitorAI browser engine.
 *
 * A real import needs Chrome + a logged-in JanitorAI session, so the routes are
 * tested against a fake {@link JanitorBrowserHandle} whose `withView` hands back
 * a {@link FakeView}. The view answers in-page `fetch` calls from a canned route
 * table and, for the capture flow, replays queued `generateAlpha` payloads each
 * time the DOM-driving `evaluate` is called (i.e. once per sent message).
 */

export interface Canned {
  status: number;
  body: string;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type FetchHandler = (url: string, init: FetchInit | undefined) => Canned;

export type FetchRoute = Canned | FetchHandler;

/** The URL the capture flow's `generateAlpha` responses use in tests. */
export const GENERATE_ALPHA_URL = "https://janitorai.com/hampter/generateAlpha";

/** 1×1 PNG base64 — a valid avatar payload for the WebP pipeline. */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Fresh avatar bytes (a Response body can only be consumed once). */
export function tinyPng(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(TINY_PNG_BASE64, "base64"));
}

/** A canned-route `fetch` stub usable as `createApp({ fetchImpl })`. */
export function fetchStub(routes: Record<string, () => Response>): typeof fetch {
  return Object.assign(
    async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return (routes[url] ?? (() => new Response("not found", { status: 404 })))();
    },
    { preconnect: () => {} },
  );
}

interface ResponseHook {
  predicate: (url: string) => boolean;
  handler: (url: string, body: string) => void;
}

export class FakeView implements JanitorView {
  private currentUrl = "";
  readonly navigations: string[] = [];
  readonly fetches: string[] = [];
  /** Every in-page fetch with its method, so tests can assert DELETE/PATCH. */
  readonly requests: { url: string; method: string }[] = [];
  readonly evaluations: string[] = [];
  readonly responseHooks: ResponseHook[] = [];
  /** CDP patterns passed to `interceptRequest`. */
  readonly interceptPatterns: string[] = [];
  /** Queued `generateAlpha` payloads, replayed on each `evaluate`. */
  readonly payloads: unknown[] = [];
  private readonly routes: Record<string, FetchRoute>;

  constructor(routes: Record<string, FetchRoute> = {}) {
    this.routes = routes;
  }

  get url(): string {
    return this.currentUrl;
  }

  async navigate(url: string): Promise<void> {
    this.currentUrl = url;
    this.navigations.push(url);
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    this.evaluations.push(expression);
    // Simulate the browser receiving the next generateAlpha response after the
    // just-sent message.
    if (this.payloads.length > 0 && this.responseHooks.length > 0) {
      const body = JSON.stringify(this.payloads.shift());
      for (const hook of this.responseHooks) {
        if (hook.predicate(GENERATE_ALPHA_URL)) hook.handler(GENERATE_ALPHA_URL, body);
      }
    }
    return true as unknown as T;
  }

  async fetch(url: string, init?: FetchInit): Promise<Canned> {
    this.fetches.push(url);
    this.requests.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    const route = this.routes[url];
    if (route === undefined) return { status: 404, body: "not found" };
    return typeof route === "function" ? route(url, init) : route;
  }

  async waitFor(): Promise<boolean> {
    return true;
  }

  async onResponse(
    predicate: (url: string) => boolean,
    handler: (url: string, body: string) => void,
  ): Promise<void> {
    this.responseHooks.push({ predicate, handler });
  }

  async interceptRequest(
    _matches?: (url: string) => boolean,
    _rewrite?: (body: string) => string | null,
    cdpPattern?: string,
  ): Promise<void> {
    // The persona rewrite is not observable in a hermetic test, but the CDP
    // scope is recorded so a test can assert it stayed narrow.
    if (cdpPattern !== undefined) this.interceptPatterns.push(cdpPattern);
  }
}

export interface FakeBrowserOptions {
  supported?: boolean;
  chromePath?: string | null;
  running?: boolean;
  /** Model a NON-login operation in flight (an import/capture holding Chrome). */
  busy?: boolean;
}

/** A {@link JanitorBrowserHandle} facade over one {@link FakeView}. */
export function makeFakeBrowser(
  view: JanitorView,
  opts: FakeBrowserOptions = {},
): JanitorBrowserHandle {
  const supported = opts.supported ?? true;
  const status: JanitorBrowserStatus = {
    supported,
    chromePath: opts.chromePath ?? (supported ? "/usr/bin/chrome" : null),
    running: opts.running ?? false,
    mode: null,
    busy: opts.busy ?? false,
  };
  return {
    status: () => status,
    withView: (fn) => fn(view),
    dispose: async () => {},
    clearProfile: async () => {},
  };
}

/** Build the two capture payloads the auto-trigger consumes. */
export function capturePayloads(opts: {
  characterName: string;
  card: string;
  closedLore: string;
  firstMessage?: string;
}): unknown[] {
  const card = `<${opts.characterName}'s Persona>\n${opts.card}\n</${opts.characterName}'s Persona>\n<Scenario>SCENARIO</Scenario>`;
  const system = opts.closedLore === "" ? card : `${card}\n\n${opts.closedLore}`;
  return [
    {
      messages: [
        { role: "system", content: card },
        { role: "assistant", content: opts.firstMessage ?? "*greeting*" },
      ],
      model: "janitor-alpha",
    },
    {
      messages: [
        { role: "system", content: system },
        { role: "assistant", content: opts.firstMessage ?? "*greeting*" },
      ],
      model: "janitor-alpha",
    },
  ];
}
