/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import type { PromptPreviewResponse } from "../../lib/api-generate";
import { previewPrompt } from "../../lib/api-generate";
import { copyText } from "../../lib/clipboard";
import { INSTANT, riseVariants, useAppMotion } from "../../lib/motion";
import {
  EMPTY_CONTENT_PLACEHOLDER,
  formatPromptText,
  pluginNotice,
  promptTotals,
  summarizeBudget,
  summaryNotice,
  toMessageViews,
} from "../../lib/prompt-preview";
import { Check, Copy, Info, RotateCcw, TriangleAlert } from "../ui/icons";
import Modal from "../ui/Modal";
import { Presence } from "../ui/presence";
import "../../styles/chat.css";

/** Readable message for a failed preview — the `ApiError` convention from
 *  lib/api.ts, with the network failure (status 0) spelled out. */
function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.status === 0 ? "Network error — could not reach the server." : err.message;
  }
  if (err instanceof Error && err.message !== "") {
    return err.message;
  }
  return "Failed to load the prompt preview";
}

/** A single stat in the summary strip. */
function Stat(props: { label: string; value: string }) {
  return (
    <span className="prompt-stat">
      <span className="prompt-stat-value tnum">{props.value}</span>
      <span className="prompt-stat-label">{props.label}</span>
    </span>
  );
}

/**
 * The prompt inspector: the FULL assembled prompt a generation would send,
 * straight from the read-only `prompt-preview` dry run. Content is the
 * server's — model output, user text, lorebook prose — so it is rendered as
 * text only (React escapes by default; nothing here uses innerHTML).
 */
export default function PromptPreview(props: { chatId: string; onClose: () => void }) {
  const [preview, setPreview] = useState<PromptPreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const app = useAppMotion();

  // The parent remounts us keyed on the chat id, so `props.chatId` is stable
  // for a mount; the guard still ignores a response that arrives after the
  // inspector moved on.
  const load = useCallback(
    async (chatId: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const result = await previewPrompt(chatId);
        // Ignore a response that arrives after the inspector moved to another
        // chat (the parent remounts us keyed on the id, but a late rejection
        // still must not paint onto the new one).
        if (props.chatId === chatId) {
          setPreview(result);
        }
      } catch (err: unknown) {
        if (props.chatId === chatId) {
          setError(errorMessage(err));
        }
      } finally {
        if (props.chatId === chatId) {
          setLoading(false);
        }
      }
    },
    [props.chatId],
  );

  // Mount-time load (the Solid `onMount`): one dry run per mounted chat.
  useEffect(() => {
    void load(props.chatId);
  }, [load, props.chatId]);

  // The response is typed, but a malformed payload must degrade to "no
  // messages" rather than throw in the renderer.
  const messages = (() => {
    const value = preview?.messages;
    return Array.isArray(value) ? value : [];
  })();

  // The context the per-message shares are measured against. A missing
  // budget (a malformed payload) degrades to 0, which usagePercent reads as
  // "no share" rather than a crash.
  const context = preview?.budget?.context ?? 0;

  const totals = promptTotals(messages, context);

  const views = toMessageViews(messages, context);

  // Copy feedback: the check shows for a moment after a successful write.
  // `copyText` falls back to `execCommand` in an insecure context (LAN HTTP),
  // so a `false` result is a real failure — MessageBubble's pattern.
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  // Solid's onCleanup — cancel a pending "Copied" reset on unmount.
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const copyAll = async (): Promise<void> => {
    const list = messages;
    if (list.length === 0) {
      return;
    }
    if (!(await copyText(formatPromptText(list)))) {
      return;
    }
    setCopied(true);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  const budget = (() => {
    const value = preview?.budget;
    return value === undefined || value === null
      ? null
      : summarizeBudget({ used: value.used, context: value.context, remaining: value.remaining });
  })();

  const rewrittenNotice = pluginNotice(preview?.plugin_rewritten === true);
  const injectedNotice = summaryNotice(preview?.summary);

  return (
    <Modal title="Prompt preview" wide onClose={props.onClose}>
      <Presence mode="wait">
        {error !== null ? (
          <motion.div
            key="error"
            className="drawer-panel-error"
            role="alert"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <TriangleAlert size={14} />
            <span>{error}</span>
            <button
              type="button"
              className="btn drawer-panel-retry"
              onClick={() => void load(props.chatId)}
            >
              <RotateCcw size={13} />
              Retry
            </button>
          </motion.div>
        ) : !loading ? (
          <motion.div
            key="preview"
            className="prompt-preview"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {budget !== null ? (
              <div className="prompt-preview-summary">
                <p className="prompt-preview-line">{budget.line}</p>
                <div className="prompt-preview-stats">
                  <Stat label="messages" value={String(totals.count)} />
                  <Stat label="prompt tokens" value={totals.total.toLocaleString()} />
                  <Stat label="context" value={budget.context.toLocaleString()} />
                </div>
              </div>
            ) : null}
            {/* Notices: a plugin's rewrite and an injected summary block both
              change what the model sees, so the dry run says so up front. */}
            {rewrittenNotice !== null ? (
              <p className="prompt-preview-notice">
                <Info size={13} />
                {rewrittenNotice}
              </p>
            ) : null}
            {injectedNotice !== null ? (
              <p className="prompt-preview-notice">
                <Info size={13} />
                {injectedNotice}
              </p>
            ) : null}
            <div className="prompt-preview-actions">
              <span className="caption muted">
                {totals.count} message{totals.count === 1 ? "" : "s"} in send order
              </span>
              <span className="chat-header-spacer" />
              <button
                type="button"
                className="btn prompt-copy"
                disabled={totals.count === 0}
                onClick={() => void copyAll()}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "Copied" : "Copy prompt"}
              </button>
            </div>
            {views.length > 0 ? (
              <ol className="prompt-preview-list">
                {views.map((view, index) => (
                  <motion.li
                    key={view.index}
                    className={`prompt-msg prompt-msg-${view.tone}`}
                    initial={app.reduce ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={
                      app.reduce ? INSTANT : { ...app.transition, delay: Math.min(index, 9) * 0.04 }
                    }
                  >
                    <div className="prompt-msg-head">
                      <span className="prompt-msg-index tnum">{view.index}</span>
                      <span className="prompt-msg-role">{view.label}</span>
                      {view.name !== null ? (
                        <span className="prompt-msg-name">{view.name}</span>
                      ) : null}
                      <span className="chat-header-spacer" />
                      <span className="prompt-msg-tokens caption tnum">
                        {view.tokens.toLocaleString()} tok · {view.share}%
                      </span>
                    </div>
                    {!view.empty ? (
                      <pre className="prompt-msg-content">{view.content}</pre>
                    ) : (
                      <p className="prompt-msg-content prompt-msg-empty">
                        {EMPTY_CONTENT_PLACEHOLDER}
                      </p>
                    )}
                  </motion.li>
                ))}
              </ol>
            ) : (
              <p className="prompt-preview-empty">This prompt has no messages.</p>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="loading"
            className="prompt-preview-loading"
            aria-hidden="true"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <span className="spinner" />
          </motion.div>
        )}
      </Presence>
    </Modal>
  );
}
