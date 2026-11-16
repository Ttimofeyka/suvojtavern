/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SummaryImportInput, SummaryInfo } from "../../lib/api-generate";
import {
  clearSummaries,
  exportSummaries,
  importSummaries,
  listSummaries,
  summarizeChat,
  updateSummary,
} from "../../lib/api-generate";
import { INSTANT, riseVariants, useAppMotion } from "../../lib/motion";
import { chatActions, chatIdAtom, chatSummariesAtom, chatsAtom } from "../../stores/chat";
import { appStore } from "../../stores/store";
import { Collapsible } from "../ui/collapsible";
import {
  Check,
  ChevronDown,
  Download,
  Pencil,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
  WandSparkles,
  X,
} from "../ui/icons";
import { Presence } from "../ui/presence";

/** "May 12" style caption for a summary's creation time. */
const formatCreatedAt = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
};

/** Collapses `title` into a filename-safe slug (fallback "chat" when it
 *  empties out — titles like "???" or "——" would otherwise vanish). */
const slug = (title: string): string =>
  title
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "chat";

/** Export filename: summaries-<title-or-id>-<YYYYMMDD>.json. */
function exportFileName(title: string | null | undefined, chatId: string): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  return `summaries-${slug(title ?? chatId)}-${stamp}.json`;
}

/**
 * Import files above this size are rejected before they are ever read — a
 * runaway "json" file must not be slurped into memory just to fail
 * parsing later.
 */
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/**
 * Lenient import-row check: the object must carry the keys the import route
 * needs (level/seq_from/seq_to/summary; tokens optional, defaulting null) —
 * extra fields are dropped server-side anyway. Anything else fails the
 * whole file: a half-valid import would still REPLACE the chat's real
 * summaries, so no partial mercy.
 */
function toImportRow(value: unknown): SummaryImportInput | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const level = record.level;
  const seqFrom = record.seq_from;
  const seqTo = record.seq_to;
  const summary = record.summary;
  const tokens = record.tokens;
  if (
    typeof level !== "number" ||
    !Number.isInteger(level) ||
    typeof seqFrom !== "number" ||
    !Number.isInteger(seqFrom) ||
    typeof seqTo !== "number" ||
    !Number.isInteger(seqTo) ||
    typeof summary !== "string"
  ) {
    return null;
  }
  return {
    level,
    seq_from: seqFrom,
    seq_to: seqTo,
    summary,
    tokens: typeof tokens === "number" && Number.isInteger(tokens) ? tokens : null,
  };
}

/**
 * Parses an import payload — either the export envelope
 * (`{ summaries: [...] }`) or a bare summary array — into import rows.
 * Null when the shape (or any single row) is invalid.
 */
function parseImportFile(text: string): SummaryImportInput[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).summaries)
      ? ((parsed as Record<string, unknown>).summaries as unknown[])
      : null;
  if (list === null) {
    return null;
  }
  const rows: SummaryImportInput[] = [];
  for (const item of list) {
    const row = toImportRow(item);
    if (row === null) {
      return null;
    }
    rows.push(row);
  }
  return rows;
}

interface SummariesPanelProps {
  /** Closes the drawer; the header toggle's aria-pressed state follows it. */
  onClose?: () => void;
}

/**
 * Summaries drawer shown over the conversation when the header's toggle is
 * on. It slides in from the right edge of the chat panel.
 *
 * Wiring note: the store's summaries() signal is only refreshed as a side
 * effect of openChat(), and re-opening the chat mid-session would also reload
 * the whole message list. This panel therefore keeps its own copy instead: it
 * loads listSummaries(chatId) whenever the open chat changes, and
 * "Summarize now" calls summarizeChat(chatId) then reloads that local signal.
 * Import and "Summarize now" also nudge the store (refreshSummaries) so the
 * transcript's ghost marks track the new coverage.
 */
export default function SummariesPanel(props: SummariesPanelProps) {
  // Granular reads: this panel lives on the streaming path (the drawer stays
  // mounted through generation), so it must not subscribe to the per-token
  // stream slices through `useChatStore()`.
  const chatId = useAtomValue(chatIdAtom);
  const chats = useAtomValue(chatsAtom);
  // The store's coverage list. It is refreshed when a run settles (the
  // server's post-response summarization lands before `done`), so a change
  // here means the panel's local copy is behind; the effect below reloads it
  // while the drawer stays open.
  const storeSummaries = useAtomValue(chatSummariesAtom);
  const [summaries, setSummaries] = useState<SummaryInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Id of the row currently opened for inline editing (null = none), plus
  // its working draft. Draft is a plain string so a stray keystroke never
  // touches the loaded list until Save.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Rows whose body is open. Every summary starts collapsed — the drawer is a
  // scannable index of coverage ranges first, and one card's text is read on
  // demand — so this holds only the explicitly expanded ids.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // The hidden file picker behind the Import button.
  const importInput = useRef<HTMLInputElement | null>(null);
  // Deferred callbacks (the file read + confirm behind Import) fire after the
  // render that opened the picker, so they read "is a run in flight" through
  // a live ref rather than their render's closure — the Solid signal read was
  // always current.
  const busyRef = useRef(false);
  busyRef.current = busy;
  const app = useAppMotion();

  const load = useCallback(async (id: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const rows = await listSummaries(id);
      // Ignore a response that arrives after the user switched chats. Read
      // the open chat imperatively so the callback never closes over a
      // stale chat id.
      if (appStore.get(chatIdAtom) === id) {
        setSummaries(rows);
      }
    } catch (err: unknown) {
      if (appStore.get(chatIdAtom) === id) {
        setError(err instanceof Error ? err.message : "Failed to load summaries");
      }
    } finally {
      setBusy(false);
    }
  }, []);

  // Expansion belongs to the rows of one chat: a switch starts collapsed,
  // which is also the default for the freshly loaded history.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId is the trigger — the reset reads no value, but a chat switch must collapse every card.
  useEffect(() => {
    setExpanded(new Set());
  }, [chatId]);

  // Runs once on mount, again whenever the open chat changes, and whenever
  // the store's summary list is refreshed (a completed generation's automatic
  // summaries; this panel keeps its own copy, so it must reload to show them
  // without the drawer being closed and reopened).
  // biome-ignore lint/correctness/useExhaustiveDependencies: storeSummaries is the trigger — a coverage refresh must reload the local copy; the body reads only chatId.
  useEffect(() => {
    if (chatId !== null) {
      void load(chatId);
    }
  }, [chatId, storeSummaries, load]);

  const summarizeNow = async (): Promise<void> => {
    const id = chatId;
    if (id === null || busy) {
      return;
    }
    // Flips the same shared flag the SSE "summarizing" stage drives, so the
    // top-of-chat Summarizing pill covers this manual run too — not just
    // automatic generation.
    chatActions.setSummarizing(true);
    setBusy(true);
    setError(null);
    try {
      await summarizeChat(id);
      // Reload the local list; the store refresh keeps the ghost marks
      // in step with the rows just created.
      await load(id);
      void chatActions.refreshSummaries();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Summarization failed");
    } finally {
      chatActions.setSummarizing(false);
      setBusy(false);
    }
  };

  const exportNow = async (): Promise<void> => {
    const id = chatId;
    if (id === null || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = await exportSummaries(id);
      // The chats list knows the title; a chat it hasn't seen yet (a fresh
      // fork) exports under its id instead.
      const title = chats.find((row) => row.id === id)?.title ?? null;
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFileName(title, id);
      // Attached for the click — detached anchors still work in modern
      // browsers, but keeping it in the document is the safe pattern.
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };

  const runImport = async (rows: SummaryImportInput[]): Promise<void> => {
    // Live reads: this runs from the deferred file-read callback, not a click.
    const id = appStore.get(chatIdAtom);
    if (id === null) {
      return;
    }
    if (busyRef.current) {
      // A summarize/export run started while the file picker (or its
      // confirm dialog) was open — say so instead of silently dropping
      // the confirmed import.
      setError("Summarization still in progress — try again");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await importSummaries(id, rows);
      await load(id);
      void chatActions.refreshSummaries();
    } catch (err: unknown) {
      if (appStore.get(chatIdAtom) === id) {
        setError(err instanceof Error ? err.message : "Import failed");
      }
    } finally {
      setBusy(false);
    }
  };

  /** File picker change: parse, confirm, then POST the replacement rows. */
  const onImportFile = (input: HTMLInputElement): void => {
    const file = input.files?.[0];
    // Reset so picking the same file again still fires a change event.
    input.value = "";
    if (!file) {
      return;
    }
    // Guard before the read: an oversized file is rejected without ever
    // entering memory.
    if (file.size > MAX_IMPORT_BYTES) {
      setError("File too large — summaries imports are capped at 50 MB.");
      return;
    }
    void file
      .text()
      .then((text) => {
        const rows = parseImportFile(text);
        if (rows === null) {
          setError(
            'Not a summaries export — expected a JSON array of rows with level, seq_from, seq_to and summary (bare, or inside a { "summaries": [...] } envelope).',
          );
          return;
        }
        // The route REPLACES every existing summary of the chat.
        if (window.confirm("This replaces all existing summaries of this chat. Continue?")) {
          return runImport(rows);
        }
      })
      .catch(() => setError("Could not read the file"));
  };

  /** Removes every summary of the chat, returning covered messages to the
   *  live transcript (the store refresh clears the ghost marks). */
  const clearAll = async (): Promise<void> => {
    const id = chatId;
    if (id === null || busy) {
      return;
    }
    if (
      !window.confirm("Remove all summaries of this chat? Covered messages become visible again.")
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await clearSummaries(id);
      // The list is empty now, so drop local rows without a refetch;
      // the store refresh is what un-ghosts the transcript.
      if (appStore.get(chatIdAtom) === id) {
        setSummaries([]);
        // A row may have been open for editing; it no longer exists.
        setEditingId(null);
      }
      void chatActions.refreshSummaries();
    } catch (err: unknown) {
      if (appStore.get(chatIdAtom) === id) {
        setError(err instanceof Error ? err.message : "Failed to clear summaries");
      }
    } finally {
      setBusy(false);
    }
  };

  /** Toggles one card's disclosure body. */
  const toggleExpanded = (summaryId: string): void => {
    setExpanded((ids) => {
      const next = new Set(ids);
      if (next.has(summaryId)) {
        next.delete(summaryId);
      } else {
        next.add(summaryId);
      }
      return next;
    });
  };

  /** Opens inline editing for one row, seeding the draft with its text. */
  const startEdit = (summary: SummaryInfo): void => {
    // The editor lives in the card's body, so asking to edit also opens the
    // disclosure — a collapsed card must never hide the field it just opened.
    setExpanded((ids) => new Set(ids).add(summary.id));
    setEditingId(summary.id);
    setDraft(summary.summary);
  };

  const cancelEdit = (): void => {
    setEditingId(null);
  };

  /** Saves one edited row; coverage/ranges never change, so the returned
   *  row (tokens recomputed) replaces the local copy — no store refresh. */
  const saveEdit = async (summaryId: string): Promise<void> => {
    const id = chatId;
    if (id === null || busy || editingId !== summaryId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateSummary(id, summaryId, draft);
      if (appStore.get(chatIdAtom) === id) {
        setSummaries((rows) => rows.map((row) => (row.id === summaryId ? updated : row)));
        setEditingId(null);
      }
    } catch (err: unknown) {
      if (appStore.get(chatIdAtom) === id) {
        setError(err instanceof Error ? err.message : "Failed to update summary");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="summaries-panel" aria-label="Chat summaries">
      <header className="summaries-head">
        <span className="summaries-head-icon" aria-hidden="true">
          <Sparkles size={15} />
        </span>
        <strong>Summaries</strong>
        {summaries.length > 0 ? <span className="pill">{summaries.length}</span> : null}
        <span className="chat-header-spacer" />
        {/* Action controls grouped so they wrap as one unit on narrow
            drawers instead of overflowing the header. */}
        <div className="summaries-actions">
          <button
            type="button"
            className="btn summaries-run"
            disabled={busy}
            onClick={() => void summarizeNow()}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : <WandSparkles size={13} />}
            {busy ? "Working…" : "Summarize now"}
          </button>
          <button
            type="button"
            className="btn btn-icon summaries-tool"
            aria-label="Clear all summaries"
            data-tip="Clear all summaries"
            disabled={busy || summaries.length === 0}
            onClick={() => void clearAll()}
          >
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            className="btn btn-icon summaries-tool"
            aria-label="Export summaries"
            data-tip="Export summaries"
            disabled={busy}
            onClick={() => void exportNow()}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : <Download size={14} />}
          </button>
          <button
            type="button"
            className="btn btn-icon summaries-tool"
            aria-label="Import summaries"
            data-tip="Import summaries"
            disabled={busy}
            onClick={() => importInput.current?.click()}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : <Upload size={14} />}
          </button>
          {/* Hidden file picker — Import opens it; display:none keeps it out
              of the layout and the tab order. */}
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => onImportFile(event.currentTarget)}
          />
          {props.onClose ? (
            <button
              type="button"
              className="btn btn-icon"
              aria-label="Close summaries"
              onClick={() => props.onClose?.()}
            >
              <X size={15} />
            </button>
          ) : null}
        </div>
      </header>
      <Presence>
        {error !== null ? (
          <motion.p
            key="summaries-error"
            className="summaries-error"
            variants={riseVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <TriangleAlert size={13} />
            {error}
          </motion.p>
        ) : null}
      </Presence>
      {summaries.length > 0 ? (
        <ul className="summaries-list">
          {summaries.map((summary, index) => {
            const bodyId = `summary-body-${summary.id}`;
            const isExpanded = expanded.has(summary.id);
            return (
              // The list is replaced wholesale on load/import, so a keyed row
              // mounts once per identity; the stagger is capped at 10 like the
              // transcript's (chat.css documents the cap).
              <motion.li
                key={summary.id}
                className="summary-card"
                initial={app.reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={
                  app.reduce ? INSTANT : { ...app.transition, delay: Math.min(index, 9) * 0.06 }
                }
              >
                <div className="summary-card-meta">
                  {/* The identifying line is the disclosure trigger: cards start
                      collapsed, so the drawer reads as a scannable index of
                      levels and coverage ranges, and the text opens on demand. */}
                  <button
                    type="button"
                    className="summary-toggle"
                    aria-expanded={isExpanded}
                    aria-controls={bodyId}
                    aria-label={`${
                      isExpanded ? "Collapse" : "Expand"
                    } summary for messages ${summary.seq_from}–${summary.seq_to}`}
                    onClick={() => toggleExpanded(summary.id)}
                  >
                    <span className="summary-chevron" aria-hidden="true">
                      <ChevronDown size={13} />
                    </span>
                    <span className="badge tnum">Level {summary.level}</span>
                    <span className="caption tnum">
                      messages {summary.seq_from}–{summary.seq_to}
                    </span>
                    <span
                      className="caption tnum"
                      data-tip="Tokens in the covered messages → tokens in the summary"
                    >
                      {summary.source_tokens} → {summary.tokens} tokens
                    </span>
                  </button>
                  {editingId !== summary.id ? (
                    <button
                      type="button"
                      className="btn-icon-mini summary-edit-btn"
                      aria-label="Edit summary"
                      data-tip="Edit summary"
                      disabled={busy}
                      onClick={() => startEdit(summary)}
                    >
                      <Pencil size={13} />
                    </button>
                  ) : null}
                  <span className="caption">{formatCreatedAt(summary.created_at)}</span>
                </div>
                {/* Lazy disclosure: a collapsed card costs only its meta line.
                    The Collapsible clips the body while shut and inerts it, so
                    the hidden editor leaves the tab order and a11y tree. */}
                <Collapsible open={isExpanded} id={bodyId} lazy>
                  <div className="summary-body">
                    {/* Text and editor crossfade in place; the editor is the
                        card's "expand" state, so it fades/rises rather than
                        teleporting. */}
                    <Presence mode="wait" initial={false}>
                      {editingId === summary.id ? (
                        <motion.div
                          key="editor"
                          className="summary-edit"
                          variants={riseVariants(app)}
                          initial="hidden"
                          animate="visible"
                          exit="exit"
                        >
                          <textarea
                            className="summary-edit-input"
                            value={draft}
                            onChange={(event) => setDraft(event.currentTarget.value)}
                            onKeyDown={(event) => {
                              // Escape abandons the draft; the API is never called.
                              // Ignore it mid-save so a cancel cannot race the update.
                              if (event.key === "Escape" && !busy) {
                                event.preventDefault();
                                cancelEdit();
                              }
                            }}
                          />
                          <div className="summary-edit-actions">
                            <button
                              type="button"
                              className="btn btn-icon summaries-tool"
                              aria-label="Save summary"
                              data-tip="Save summary"
                              disabled={busy}
                              onClick={() => void saveEdit(summary.id)}
                            >
                              {busy ? (
                                <span className="spinner" aria-hidden="true" />
                              ) : (
                                <Check size={14} />
                              )}
                            </button>
                            <button
                              type="button"
                              className="btn btn-icon summaries-tool"
                              aria-label="Cancel editing"
                              data-tip="Cancel"
                              disabled={busy}
                              onClick={cancelEdit}
                            >
                              <X size={14} />
                            </button>
                          </div>
                        </motion.div>
                      ) : (
                        <motion.p
                          key="text"
                          className="summary-text"
                          variants={riseVariants(app)}
                          initial="hidden"
                          animate="visible"
                          exit="exit"
                        >
                          {summary.summary}
                        </motion.p>
                      )}
                    </Presence>
                  </div>
                </Collapsible>
              </motion.li>
            );
          })}
        </ul>
      ) : (
        <p className="summaries-empty">
          No summaries yet — "Summarize now" condenses uncovered ranges.
        </p>
      )}
    </section>
  );
}
