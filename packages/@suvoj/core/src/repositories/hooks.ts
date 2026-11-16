/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Message } from "../schema/messages";

/**
 * Message lifecycle events (the tracker surface). `before*` events fire
 * before the write lands, `after*` events once it is persisted.
 */
export const CHAT_HOOK_EVENTS = [
  "beforeInsert",
  "afterInsert",
  "beforeEdit",
  "afterEdit",
  "beforeDelete",
  "afterDelete",
] as const;

export type ChatHookEvent = (typeof CHAT_HOOK_EVENTS)[number];

/**
 * Hook payload. `chatId` always identifies the affected chat and `message`
 * carries the full message row (id, seq, metadata, ...) so listeners can
 * relate hooks to exact messages. For edit events, `previous` holds the row
 * as it was before the change.
 */
export interface ChatHookPayload {
  chatId: string;
  message?: Message;
  previous?: Message;
}

export type ChatHook = (payload: ChatHookPayload) => void;

/** Handlers for a subset of the lifecycle events. */
export type ChatHookHandlers = Partial<Record<ChatHookEvent, ChatHook>>;

/**
 * Minimal typed event bus for message lifecycle hooks. `emit` is
 * synchronous; a throwing listener aborts the repository operation that
 * triggered it (before* events therefore run before anything is written).
 */
export class ChatHookBus {
  private readonly handlers = new Map<ChatHookEvent, Set<ChatHook>>();

  /** Registers handlers and returns a function that unregisters them. */
  register(handlers: ChatHookHandlers): () => void {
    const registered: Array<[ChatHookEvent, ChatHook]> = [];
    const entries = Object.entries(handlers) as Array<[ChatHookEvent, ChatHook | undefined]>;
    for (const [event, handler] of entries) {
      if (!handler) {
        continue;
      }
      this.handlersFor(event).add(handler);
      registered.push([event, handler]);
    }
    return () => {
      for (const [event, handler] of registered) {
        this.handlersFor(event).delete(handler);
      }
    };
  }

  /** Invokes every listener registered for `event`. */
  emit(event: ChatHookEvent, payload: ChatHookPayload): void {
    for (const handler of this.handlersFor(event)) {
      handler(payload);
    }
  }

  /** Removes every listener (tests only). */
  removeAll(): void {
    this.handlers.clear();
  }

  private handlersFor(event: ChatHookEvent): Set<ChatHook> {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    return set;
  }
}

/** Default process-wide bus, used by repositories unless one is injected. */
export const chatHooks = new ChatHookBus();

/**
 * Registers message lifecycle hooks on the default bus and returns an
 * unregister function. This is the tracker-ready surface from PLAN.md —
 * no plugin loading, just a typed in-process event surface.
 */
export function registerChatHooks(handlers: ChatHookHandlers): () => void {
  return chatHooks.register(handlers);
}
