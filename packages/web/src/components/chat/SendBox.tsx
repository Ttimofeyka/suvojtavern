/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { useRef } from "react";
import { cx } from "../../lib/cx";
import { INSTANT, useAppMotion } from "../../lib/motion";
import { isTouchDevice } from "../../lib/touch";
import {
  chatGroupsLoadingAtom,
  chatIdAtom,
  chatSendPendingAtom,
  chatStreamingAtom,
  sendMessage,
  stop,
} from "../../stores/chat";
import { Send, Square } from "../ui/icons";
import { Presence } from "../ui/presence";

/** Message composer: Enter sends on a hardware keyboard, Shift+Enter inserts a
 *  newline. On a touch device (no modifier keys) Enter inserts a newline too
 *  and the Send button submits. An empty send (SillyTavern's shortcut) skips
 *  the user turn and generates directly, so the character speaks unprompted. */
export default function SendBox() {
  const streaming = useAtomValue(chatStreamingAtom);
  const pending = useAtomValue(chatSendPendingAtom);
  const loading = useAtomValue(chatGroupsLoadingAtom);
  const chatId = useAtomValue(chatIdAtom);
  const app = useAppMotion();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const drafts = useRef(new Map<string, string>());

  /** Grows the textarea with its content, capped by the CSS max-height. */
  const autoGrow = () => {
    const input = inputRef.current;
    if (input) {
      input.style.height = "";
      input.style.height = `${input.scrollHeight}px`;
    }
  };

  const send = () => {
    const input = inputRef.current;
    const draft = input?.value ?? "";
    // An empty text is deliberate: sendMessage turns it into a generate-only
    // run (the character speaks on its own) rather than a stored user turn.
    if (!input || chatId === null || pending || loading) {
      return;
    }
    void sendMessage(draft.trim(), () => {
      if ((drafts.current.get(chatId) ?? "") === draft) {
        drafts.current.delete(chatId);
      }
      const current = inputRef.current;
      if (current?.dataset.chatId === chatId && current.value === draft) {
        current.value = "";
        current.style.height = "";
      }
    });
  };

  return (
    <div className="send-box">
      <div className={cx("send-box-inner", streaming && "is-streaming")}>
        <textarea
          key={chatId}
          data-chat-id={chatId ?? undefined}
          ref={inputRef}
          className="send-input"
          rows={1}
          placeholder="Write a message…"
          aria-label="Message"
          defaultValue={chatId === null ? "" : drafts.current.get(chatId)}
          onChange={(event) => {
            if (chatId !== null) {
              const value = event.currentTarget.value;
              if (value) drafts.current.set(chatId, value);
              else drafts.current.delete(chatId);
            }
            autoGrow();
          }}
          onKeyDown={(event) => {
            // Shift+Enter — and a bare Enter on a phone/tablet, whose virtual
            // keyboard has no modifier keys — inserts a newline; only a hardware
            // keyboard's plain Enter sends. The Send button is the touch submit path.
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              !isTouchDevice()
            ) {
              event.preventDefault();
              send();
            }
          }}
        />
        {/* Press scale stays CSS (the .send-btn :hover/:active rules): a
            Motion gesture would leave an inline transform that permanently
            outranks the stylesheet's hover scale. */}
        <button
          type="button"
          className={cx("send-btn", streaming && "send-btn-stop")}
          aria-label={streaming ? "Stop generating" : "Send message"}
          disabled={!streaming && (pending || loading)}
          onClick={() => (streaming ? stop() : send())}
        >
          {/* Send and stop are the same control, so the icon crossfades in
              place (mode="wait": the outgoing glyph clears before the next
              lands) rather than the button replacing itself. */}
          <Presence mode="wait" initial={false}>
            <motion.span
              key={streaming ? "stop" : "send"}
              className="send-btn-icon"
              initial={app.reduce ? false : { opacity: 0, scale: 0.6, rotate: -30 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={app.reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6, rotate: 30 }}
              transition={app.reduce ? INSTANT : app.transition}
            >
              {streaming ? <Square size={14} /> : <Send size={15} />}
            </motion.span>
          </Presence>
        </button>
      </div>
    </div>
  );
}
