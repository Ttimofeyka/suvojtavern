/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import type {
  JanitorErrorKind,
  JanitorImportResult,
  JanitorLorebook,
  JanitorStatus,
} from "../../lib/api-janitor";
import {
  cancelJanitorLogin,
  captureJanitorCharacter,
  getJanitorStatus,
  importJanitorCharacter,
  isJanitorCharacterUrl,
  janitorErrorKind,
  janitorLogout,
  startJanitorLogin,
} from "../../lib/api-janitor";
import type { CardImportSource, ImportConflict, UrlCardImportResult } from "../../lib/api-transfer";
import { importCardFromUrl } from "../../lib/api-transfer";
import { cx } from "../../lib/cx";
import { fadeVariants, useAppMotion } from "../../lib/motion";
import {
  Check,
  Download,
  ExternalLink,
  LogIn,
  LogOut,
  TriangleAlert,
  WandSparkles,
  X,
} from "../ui/icons";
import { Presence } from "../ui/presence";
import ConflictPicker from "./ConflictPicker";

/** How often sign-in is checked, and when we give up waiting. */
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 3 * 60 * 1000;

/** A URL import that failed, with the recoverable JanitorAI kind when it has one. */
interface JanitorFailure {
  message: string;
  kind: JanitorErrorKind | null;
}

export interface UrlImportSectionProps {
  /** Shared duplicate-name handling, also rendered by the card-file tab. */
  conflict: ImportConflict;
  /** Receives the shared duplicate-name choice. */
  onConflictChange: (value: ImportConflict) => void;
  /** Shared import lock; disables every import action while one is running. */
  busy: boolean;
  /** Shared runner: flips `busy`, clears the dialog error, and tracks the promise. */
  run: (action: () => Promise<void>) => void;
  /** Notifies the parent that the character list changed. */
  onChanged: () => void;
}

/** Human-readable outcome of one attached lorebook. */
const LOREBOOK_OUTCOME: Record<JanitorLorebook["status"], string> = {
  imported: "imported",
  closed: "closed — skipped",
  empty: "empty — skipped",
  js: "script-only — skipped",
};

function describeLorebook(book: JanitorLorebook): string {
  const count = book.entries === undefined ? "" : ` (${book.entries} entries)`;
  return `"${book.title}" ${LOREBOOK_OUTCOME[book.status]}${count}`;
}

/** One-line success summary: name, definition source, and every lorebook outcome. */
function describeResult(result: JanitorImportResult): string {
  const parts = [`Imported "${result.character.name}"${result.renamed ? " (renamed)" : ""}`];
  parts.push(
    result.definitionSource === "reconstructed" ? "definition reconstructed" : "definition exact",
  );
  // `result.lorebook` is the first imported book, already listed in `lorebooks`;
  // describing both would print it twice.
  for (const book of result.lorebooks) {
    parts.push(describeLorebook(book));
  }
  return parts.join(" — ");
}

/** Success-message suffix naming where a generic URL import fetched the card from. */
function urlImportSource(source: CardImportSource): string {
  if (source === "chub") {
    return " from chub.ai";
  }
  if (source === "janitor") {
    return " from JanitorAI";
  }
  return source === "png" ? " from PNG link" : " from JSON link";
}

/** One-line success summary for a generic (non-JanitorAI) URL import. */
function describeUrlResult(result: UrlCardImportResult): string {
  const lorebook = result.lorebook === null ? "" : ` with lorebook "${result.lorebook.name}"`;
  return (
    `Imported "${result.character.name}"${result.renamed ? " (renamed)" : ""}` +
    `${lorebook}${urlImportSource(result.source)}`
  );
}

/**
 * Link tab: one URL field that routes JanitorAI character links through the
 * browser-based importer (sign-in status pill, login/logout, attached-lorebook
 * toggle, and the full-extraction fallback) and every other link through the
 * generic chub / direct-card import.
 *
 * Auth actions are local (`authBusy`/`polling`) because they must not block the
 * other tabs; actual imports go through the parent's shared `run`/`busy` so
 * every import action locks together.
 */
export default function UrlImportSection(props: UrlImportSectionProps) {
  const app = useAppMotion();
  const [status, setStatus] = useState<JanitorStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const [url, setUrl] = useState("");
  const [includeLorebooks, setIncludeLorebooks] = useState(true);
  const [result, setResult] = useState<JanitorImportResult | null>(null);
  const [genericMsg, setGenericMsg] = useState<string | null>(null);
  const [failure, setFailure] = useState<JanitorFailure | null>(null);

  const refreshStatus = useCallback((): Promise<void> => {
    return getJanitorStatus()
      .then((next) => {
        setStatus(next);
        setStatusError(null);
        // A page reloaded mid-login starts with `polling` off but the server
        // still polling: adopt its report so we reattach and offer Cancel. This
        // only ever flips false→true, so it cannot loop with the poll effect.
        if (next.loginInProgress) {
          setPolling(true);
        }
      })
      .catch((err: unknown) => {
        setStatusError(err instanceof Error ? err.message : "Failed to load JanitorAI status");
      });
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Sign-in polling: waits for the user to finish in the browser window the
  // server opened. The effect owns the interval, so flipping `polling` off (or
  // unmounting the section) clears it with no timer bookkeeping.
  useEffect(() => {
    if (!polling) {
      return;
    }
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    const timer = setInterval(() => {
      void getJanitorStatus()
        .then((next) => {
          setStatus(next);
          setStatusError(null);
          if (next.loggedIn) {
            setPolling(false);
            setNotice("Signed in.");
          } else if (Date.now() >= deadline) {
            setPolling(false);
            setNotice("Sign-in timed out — press Log in to try again, or press Cancel to stop.");
          }
        })
        .catch(() => {
          // Transient failure: keep polling until the deadline, then report it.
          if (Date.now() >= deadline) {
            setPolling(false);
            setStatusError("Lost contact with the server while waiting for sign-in.");
          }
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [polling]);

  const logIn = async (): Promise<void> => {
    setAuthBusy(true);
    setStatusError(null);
    setFailure(null);
    setNotice(null);
    try {
      await startJanitorLogin();
      setNotice("Waiting for sign-in in the browser window on the server machine…");
      setPolling(true);
    } catch (err) {
      // A 409 means a login is already running (another tab, or a double
      // start). Attach to it and keep polling instead of treating the section
      // as unavailable — that used to disable Log in and wedge the dialog.
      if (err instanceof ApiError && err.status === 409) {
        setNotice("A JanitorAI login is already running — waiting for it.");
        setPolling(true);
        await refreshStatus();
      } else {
        setStatusError(err instanceof Error ? err.message : "Failed to start JanitorAI login");
      }
    } finally {
      setAuthBusy(false);
    }
  };

  const cancelLogin = async (): Promise<void> => {
    // Snapshot whether a poll was live so the notice names the right outcome.
    const wasPolling = polling || status?.loginInProgress === true;
    setCancelBusy(true);
    setStatusError(null);
    try {
      await cancelJanitorLogin();
      setPolling(false);
      setNotice(wasPolling ? "Sign-in cancelled." : "Login window closed.");
      await refreshStatus();
    } catch (err) {
      // Surface it as the section's hint rather than wedging the status pill.
      setStatusError(err instanceof Error ? err.message : "Failed to cancel JanitorAI sign-in");
    } finally {
      setCancelBusy(false);
    }
  };

  const logOut = async (): Promise<void> => {
    setAuthBusy(true);
    setStatusError(null);
    setPolling(false);
    setNotice(null);
    try {
      await janitorLogout();
      setNotice("Signed out.");
      await refreshStatus();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Failed to sign out of JanitorAI");
    } finally {
      setAuthBusy(false);
    }
  };

  const handleFailure = (err: unknown): void => {
    const kind = janitorErrorKind(err);
    setFailure({
      message: err instanceof Error ? err.message : "Import failed",
      kind,
    });
    // The server just told us the session is gone; don't keep showing "Signed in".
    if (kind === "not-logged-in") {
      void refreshStatus();
    }
  };

  const applyResult = (next: JanitorImportResult): void => {
    setResult(next);
    setFailure(null);
    props.onChanged();
  };

  /** Clears the section's result states, then runs one import under the shared lock. */
  const startUrlImport = (action: () => Promise<void>): void => {
    const target = url.trim();
    if (target === "" || props.busy) {
      return;
    }
    setResult(null);
    setGenericMsg(null);
    setFailure(null);
    props.run(async () => {
      try {
        await action();
      } catch (err) {
        // Caught here (not by the parent runner) so the private-definition
        // fallback can render next to the failure it belongs to.
        handleFailure(err);
      }
    });
  };

  /** Unified URL import: JanitorAI links use the browser importer, everything else the generic path. */
  const runUrlImport = (): void => {
    const target = url.trim();
    startUrlImport(async () => {
      if (isJanitorCharacterUrl(target)) {
        applyResult(
          await importJanitorCharacter(target, { onConflict: props.conflict, includeLorebooks }),
        );
        setUrl("");
        return;
      }
      const generic = await importCardFromUrl(target, props.conflict);
      setGenericMsg(describeUrlResult(generic));
      props.onChanged();
      setUrl("");
    });
  };

  /** The `definition-private` fallback: full extraction of a JanitorAI character. */
  const runCapture = (): void => {
    const target = url.trim();
    startUrlImport(async () => {
      applyResult(
        await captureJanitorCharacter(target, { onConflict: props.conflict, includeLorebooks }),
      );
      setUrl("");
    });
  };

  // Support is a property of the server, never of a transient action error:
  // folding `statusError` in here used to disable Log in for good.
  const supported = status?.supported === true;
  const loginActive =
    polling || status?.loginInProgress === true || status?.loginWindowOpen === true;
  const canAct = supported && !props.busy && !authBusy;
  // Only gate Import on JanitorAI availability when the target IS a JanitorAI
  // URL — generic direct-link imports must keep working when the JanitorAI
  // browser is unsupported or busy.
  const isJanitor = isJanitorCharacterUrl(url.trim());
  const canImport =
    !props.busy && url.trim() !== "" && (!isJanitor || (supported && !polling && !authBusy));

  let label: string;
  let tone = "";
  if (status === null) {
    label = statusError === null ? "Checking…" : "Status unavailable";
    tone = statusError === null ? "" : "char-status-danger";
  } else if (!status.supported) {
    label = "Unavailable";
    tone = "char-status-danger";
  } else if (status.loggedIn) {
    label = "Signed in";
    tone = "char-status-success";
  } else if (!status.checked) {
    // A fresh process answers from cache without probing, so don't claim the
    // user is signed out when the session was simply never checked.
    label = "Sign-in not checked";
    tone = "char-status-clean";
  } else {
    label = "Not signed in";
    tone = "char-status-clean";
  }

  const success = result !== null ? describeResult(result) : genericMsg;

  return (
    <div className="char-transfer-panel">
      <header className="char-transfer-panel-head">
        <span className="char-transfer-panel-icon" aria-hidden="true">
          <ExternalLink size={20} />
        </span>
        <div className="char-transfer-panel-copy">
          <h4 className="char-transfer-panel-title">Import from a link</h4>
          <p className="char-transfer-panel-desc">
            Paste a chub.ai page, a JanitorAI character, or a direct link to a card PNG or JSON.
          </p>
        </div>
      </header>

      <div className="char-transfer-field">
        <label className="char-transfer-field-label" htmlFor="char-transfer-url">
          Card link
        </label>
        <div className="char-transfer-url">
          <input
            id="char-transfer-url"
            className="input"
            type="text"
            placeholder="https://chub.ai/characters/…"
            value={url}
            disabled={props.busy}
            onChange={(event) => setUrl(event.currentTarget.value)}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === "Enter") {
                runUrlImport();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canImport}
            onClick={runUrlImport}
          >
            <Download size={16} />
            Import
          </button>
        </div>
        <span className="field-hint">
          chub.ai character pages, bare creator/name ids, JanitorAI characters, or direct PNG and
          JSON links.
        </span>
      </div>

      <Presence>
        {success !== null && (
          <motion.p
            className="transfer-msg"
            variants={fadeVariants(app)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <Check size={14} />
            {success}
          </motion.p>
        )}
      </Presence>

      {result !== null && result.warnings.length > 0 && (
        <div className="warn-banner">
          <TriangleAlert size={16} aria-hidden="true" />
          <div className="char-janitor-callout-body">
            {result.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        </div>
      )}

      {failure !== null && (
        <p className="error-banner" role="alert">
          <TriangleAlert size={16} />
          {failure.message}
        </p>
      )}

      {failure?.kind === "definition-private" && (
        <div className="warn-banner">
          <TriangleAlert size={16} />
          <div className="char-janitor-callout-body">
            <p>
              This definition isn't visible to an anonymous visitor. Full extraction drives the
              JanitorAI site directly and may rebuild attached lorebooks with the configured model —
              slower, and it can use tokens.
            </p>
            <button type="button" className="btn" disabled={!canImport} onClick={runCapture}>
              <WandSparkles size={16} />
              Extract anyway (slower)
            </button>
          </div>
        </div>
      )}

      <div className="char-group">
        <div className="char-group-head">
          <h5 className="char-group-title">Card options</h5>
        </div>
        <ConflictPicker
          value={props.conflict}
          disabled={props.busy}
          onChange={props.onConflictChange}
        />
        <label className={cx("switch-row", "char-transfer-switch", props.busy && "is-disabled")}>
          <span className="switch-row-main">
            <span className="switch-row-label">Import attached lorebooks</span>
            <span className="switch-row-hint">
              JanitorAI books attached to the character. Closed or script-only books are skipped.
            </span>
          </span>
          <span className="switch">
            <input
              type="checkbox"
              className="switch-input"
              checked={includeLorebooks}
              disabled={props.busy}
              onChange={(event) => setIncludeLorebooks(event.currentTarget.checked)}
            />
            <span className="switch-track">
              <span className="switch-thumb" />
            </span>
          </span>
        </label>
      </div>

      <div className="char-group">
        <div className="char-group-head char-transfer-auth-head">
          <h5 className="char-group-title">JanitorAI</h5>
          <span className={cx("char-status", tone)} role="status" aria-live="polite">
            <span className="char-status-dot" aria-hidden="true" />
            {label}
          </span>
          <span className="char-janitor-actions">
            {status?.loggedIn === true ? (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={authBusy || props.busy}
                onClick={() => void logOut()}
              >
                <LogOut size={16} />
                Log out
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={!canAct || polling}
                onClick={() => void logIn()}
              >
                {authBusy || polling ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <LogIn size={16} />
                )}
                Log in
              </button>
            )}
            {loginActive && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={cancelBusy}
                onClick={() => void cancelLogin()}
              >
                {cancelBusy ? <span className="spinner" aria-hidden="true" /> : <X size={16} />}
                Cancel
              </button>
            )}
          </span>
        </div>

        {statusError !== null && (
          <p className="field-hint">
            {statusError}{" "}
            <button
              type="button"
              className="btn btn-ghost char-janitor-hint-link"
              onClick={() => void refreshStatus()}
            >
              Retry
            </button>
          </p>
        )}
        {status?.loggedIn !== true && (
          <p className="field-hint">
            Only needed for JanitorAI links. Signing in opens a browser window on the machine
            running the server.
          </p>
        )}
        {status?.message != null && <p className="field-hint">{status.message}</p>}
        {status !== null && !status.supported && status.message === null && (
          <p className="field-hint">JanitorAI import is unavailable on this server.</p>
        )}
        {status?.busy === true && (
          <p className="field-hint">The server browser is busy — try again shortly.</p>
        )}
        {notice !== null && (
          <p className="char-janitor-note" role="status" aria-live="polite">
            {polling && <span className="spinner" aria-hidden="true" />}
            <span className="caption muted">{notice}</span>
          </p>
        )}
      </div>
    </div>
  );
}
