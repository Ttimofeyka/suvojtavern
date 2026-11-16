/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../lib/api";
import type { RegexImportSkipped, RegexPlacement, RegexRule } from "../../lib/api-regex";
import {
  importRegexRules,
  listRegexRules,
  putRegexRules,
  regexExportUrl,
} from "../../lib/api-regex";
import { cx } from "../../lib/cx";
import { riseVariants, useAppMotion } from "../../lib/motion";
import {
  detailIssues,
  draftFrom,
  draftToRule,
  hasRuleChanges,
  isRuleEqual,
  issueMessage,
  mapsToRow,
  PLACEMENT_OPTIONS,
  previewReplace,
  type RegexDraft,
  type RegexIssue,
  splitEditorDetails,
  validateDraft,
  validateRules,
} from "../../lib/regex-draft";
import { appStore } from "../../stores/store";
import "../../styles/settings.css";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import {
  Check,
  Copy,
  Download,
  Pencil,
  Plus,
  Regex,
  Trash2,
  TriangleAlert,
  Upload,
} from "../ui/icons";
import Modal, { useModalClose } from "../ui/Modal";
import { Presence } from "../ui/presence";
import type { SegmentedOption } from "../ui/segmented";
import { Segmented } from "../ui/segmented";
import { SettingsEmpty, SettingsError, SettingsLoading, SettingsSaved } from "./SettingsStates";

// --- module-level rules cache ---
// Settings remounts this panel on every section switch, and component-local
// state meant a "Loading rules…" flash while GET /api/regex/rules ran again.
// Following the module-scope atom pattern of ConnectionProfiles (and the ported
// stores), the list survives mounts: a remount renders the cached rows
// instantly while the mount effect's refresh() revalidates in the background.
// `rulesLoaded` records that some fetch has ever succeeded, so the first-load
// spinner (and its loadError fallback) only applies when none has; a failed
// background revalidate over the cache surfaces through the panel's `error`
// banner with the stale rows kept visible.
const rulesAtom = atom<RegexRule[] | null>(null);
/** Server truth of the last successful read/write — the Save button's baseline. */
const savedRulesAtom = atom<RegexRule[]>([]);
const rulesLoadedAtom = atom(false);

/** Fresh ids for created/duplicated rules; UUIDs, like the server's. */
function newRuleId(): string {
  return crypto.randomUUID();
}

/** "Name (copy)", "Name (copy 2)", … — the first free variant of a rule name. */
function uniqueCopyName(base: string, taken: Set<string>): string {
  let candidate = `${base} (copy)`;
  for (let suffix = 2; taken.has(candidate.toLowerCase()); suffix += 1) {
    candidate = `${base} (copy ${suffix})`;
  }
  return candidate;
}

/**
 * Any difference between a local list and the last server truth. Only the
 * staged structural actions (delete / duplicate) live here longer than one
 * action: the enable toggle and the editor's modal Save write straight
 * through, so they never leave a phantom dirty state behind.
 */
function rulesDirty(current: RegexRule[] | null, saved: RegexRule[]): boolean {
  const list = current ?? [];
  return (
    list.length !== saved.length ||
    list.some((rule, index) => {
      const other = saved[index];
      return other === undefined || !isRuleEqual(rule, other);
    })
  );
}

/** JSON import policy: append is the safe default (replace drops rules). */
const IMPORT_MODE_OPTIONS: readonly SegmentedOption<"append" | "replace">[] = [
  { value: "append", label: "Append" },
  { value: "replace", label: "Replace" },
];

/** File picker styled as a button; reports the chosen file, then resets so re-picks fire. */
function FileInput(props: { disabled: boolean; onFile: (file: File) => void }) {
  return (
    <label className={cx("btn file-button", props.disabled && "disabled")}>
      <Upload size={16} />
      <span>Import</span>
      <input
        type="file"
        accept=".json,application/json"
        className="file-hidden"
        disabled={props.disabled}
        aria-label="Choose a regex rules file to import"
        onChange={(event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          if (file) {
            props.onFile(file);
          }
          input.value = "";
        }}
      />
    </label>
  );
}

/** Status of the last import: how many landed, and what the parser skipped. */
interface ImportNotice {
  imported: number;
  skipped: RegexImportSkipped[];
}

/**
 * The regex editor modal's footer. Extracted so Cancel can call
 * `useModalClose()` — the hook must run in a child of <Modal>, never in the
 * component that renders it (RegexRulesPanel sits above the provider). The
 * Save button stays `type="submit"`, so it still drives the enclosing form.
 */
function RegexEditorFooter(props: { saving: boolean; dirty: boolean; error: string | null }) {
  const close = useModalClose();
  return (
    <div className="row">
      <button type="submit" className="btn btn-primary" disabled={props.saving || !props.dirty}>
        {props.saving ? "Saving…" : "Save"}
      </button>
      <button type="button" className="btn" onClick={close}>
        Cancel
      </button>
      {props.error && <span className="field-error">{props.error}</span>}
    </div>
  );
}

/**
 * Regex rules manager (Settings → Regex): the ordered find/replace rule list,
 * its inline editor, and the JSON import/export pair.
 *
 * Writes go through PUT /api/regex/rules — never /api/settings, which
 * deliberately excludes the `regex_rules` key.
 *
 * Two write paths, split by natural save point:
 *  - The per-row enable switch and the editor's own modal Save are immediate —
 *    each is a complete, deliberate action with its own affordance, so neither
 *    should need a second confirmation.
 *  - Delete and duplicate only stage in the local list; the bottom "Save"
 *    button (the TrackerSettings idiom) flushes them, and is disabled while a
 *    write is in flight or when the list already matches the server.
 *
 * Every path PUTs the WHOLE list and writes the server's response back into
 * both the view and the `savedRules` baseline, so the two paths compose: a
 * staged delete rides along with the next immediate toggle, and the dirty flag
 * never lights up for a change the server already holds.
 */
export default function RegexRulesPanel() {
  const app = useAppMotion();
  const { confirm, dialog } = useConfirmDialog();
  const rules = useAtomValue(rulesAtom);
  const savedRules = useAtomValue(savedRulesAtom);

  /** Fetch failure with nothing cached — replaces the spinner until a retry succeeds. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Errors of list actions, imports, and background revalidates over the cache. */
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Rule id with an in-flight immediate action (toggle / delete / duplicate). */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  /** Policy for the NEXT import; append is the safe default (replace drops rules). */
  const [importMode, setImportMode] = useState<"append" | "replace">("append");
  const [importNotice, setImportNotice] = useState<ImportNotice | null>(null);
  /** Client-side/server-side issues of the whole-list Save, keyed by real index. */
  const [saveIssues, setSaveIssues] = useState<RegexIssue[]>([]);

  // --- editor state ---
  const [editorOpen, setEditorOpen] = useState(false);
  /** null while creating; otherwise the id of the edited rule. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RegexDraft>(() => draftFrom(null));
  /** Shown only after a failed save attempt, so a blank new rule starts quiet. */
  const [editorIssues, setEditorIssues] = useState<RegexIssue[]>([]);
  const [editorError, setEditorError] = useState<string | null>(null);
  /** Sample text the preview transform runs on; cleared whenever the editor opens. */
  const [previewInput, setPreviewInput] = useState("");

  /** Applies a server-authoritative list to both the view and the save baseline. */
  const applyRules = useCallback((next: RegexRule[]): void => {
    appStore.set(rulesAtom, next);
    appStore.set(savedRulesAtom, next);
    appStore.set(rulesLoadedAtom, true);
    setLoadError(null);
    setError(null);
    setSaveIssues([]);
  }, []);

  const refresh = useCallback((): Promise<void> => {
    return listRegexRules()
      .then(applyRules)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Failed to load regex rules";
        if (appStore.get(rulesLoadedAtom)) {
          // The cached rows are on screen: keep them and surface the failure
          // next to them rather than replacing the list with an error.
          setError(message);
        } else {
          setLoadError(message);
        }
      });
  }, [applyRules]);

  useEffect(() => {
    // A section switch remounts this panel, and the background revalidate must
    // never discard edits staged but not yet saved (a delete, a duplicate, an
    // editor that closed without saving) — so it only runs when the local list
    // already matches the last server truth. The first mount (and a retry after
    // a failed load) is clean by definition, so it always refreshes.
    if (!rulesDirty(appStore.get(rulesAtom), appStore.get(savedRulesAtom))) {
      void refresh();
    }
  }, [refresh]);

  /** Local list vs. the last server truth, re-derived on every atom change. */
  const dirty = (): boolean => rulesDirty(rules, savedRules);

  /** True while an immediate action or a whole-list save is in flight. */
  const busy = (): boolean => busyId !== null || saving || importing;

  const resetFeedback = (): void => {
    setError(null);
    setNote(null);
    setSaveIssues([]);
  };

  const editDraft = (patch: Partial<RegexDraft>): void => {
    setEditorIssues([]);
    setEditorError(null);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const togglePlacement = (id: RegexPlacement): void => {
    setEditorIssues([]);
    setEditorError(null);
    setDraft((current) => ({
      ...current,
      placement: current.placement.includes(id)
        ? current.placement.filter((entry) => entry !== id)
        : [...current.placement, id],
    }));
  };

  const editorIssue = (field: string): string | undefined => issueMessage(editorIssues, 0, field);

  /** The preview output, or the literal marker when `find` does not compile. */
  const previewOutput = (): string =>
    previewReplace(draft.find, draft.replace, previewInput) ?? "invalid regex";

  /** The edited rule as stored, or undefined when creating. */
  const editedRule = (): RegexRule | undefined => {
    const id = editingId;
    return id === null ? undefined : (rules ?? []).find((rule) => rule.id === id);
  };

  /** A new rule is always saveable; an existing one only once it actually changed. */
  const editorDirty = (): boolean => {
    const rule = editedRule();
    return rule === undefined || hasRuleChanges(draft, rule);
  };

  const startCreate = (): void => {
    setEditingId(null);
    setDraft(draftFrom(null));
    setEditorIssues([]);
    setEditorError(null);
    setPreviewInput("");
    setEditorOpen(true);
  };

  const startEdit = (rule: RegexRule): void => {
    setEditingId(rule.id);
    setDraft(draftFrom(rule));
    setEditorIssues([]);
    setEditorError(null);
    setPreviewInput("");
    setEditorOpen(true);
  };

  const closeEditor = (): void => {
    setEditorOpen(false);
  };

  /**
   * Optimistic enable/disable — the highest-frequency action, so it persists on
   * the spot instead of waiting for the Save button. Both the view list and the
   * save baseline flip together (the optimistic payload is exactly what the
   * server receives, staged deletes and all), so Save never flickers a "dirty"
   * state during the round-trip; on failure both revert (the LorebookList
   * global-toggle pattern).
   */
  const toggle = (rule: RegexRule, enabled: boolean): void => {
    if (busy()) {
      return;
    }
    const base = rules ?? [];
    const next = base.map((entry) => (entry.id === rule.id ? { ...entry, enabled } : entry));
    appStore.set(rulesAtom, next);
    appStore.set(savedRulesAtom, next);
    setNote(null);
    setError(null);
    setSaveIssues([]);
    setBusyId(rule.id);
    putRegexRules(next)
      .then(applyRules)
      .catch(() => {
        appStore.set(rulesAtom, base);
        appStore.set(savedRulesAtom, base);
        setError(`Failed to ${enabled ? "enable" : "disable"} "${rule.name}"`);
      })
      .finally(() => setBusyId(null));
  };

  /**
   * Deletes a rule from the local list only. Placement-insensitive structural
   * edits batch behind the one Save button (the TrackerSettings idiom) — and
   * because every immediate write PUTs the WHOLE list, a later toggle or edit
   * flushes a staged delete along with it, so nothing is stranded.
   */
  const remove = (rule: RegexRule): void => {
    if (busy()) {
      return;
    }
    confirm({
      title: "Delete regex rule?",
      description: (
        <>
          <strong>{rule.name}</strong> will be removed from the list. Save the panel afterwards to
          keep the deletion.
        </>
      ),
      confirmLabel: "Delete rule",
      tone: "danger",
      onConfirm: () => {
        resetFeedback();
        appStore.set(rulesAtom, (current) =>
          (current ?? []).filter((entry) => entry.id !== rule.id),
        );
        if (editingId === rule.id) {
          closeEditor();
        }
      },
    });
  };

  /** Adds a "(copy)" sibling to the local list, staged until Save. */
  const duplicate = (rule: RegexRule): void => {
    if (busy()) {
      return;
    }
    resetFeedback();
    appStore.set(rulesAtom, (current) => {
      const list = current ?? [];
      const taken = new Set(list.map((entry) => entry.name.toLowerCase()));
      return [
        ...list,
        {
          ...rule,
          id: newRuleId(),
          name: uniqueCopyName(rule.name, taken),
          placement: [...rule.placement],
        },
      ];
    });
  };

  const saveAll = async (): Promise<void> => {
    if (busy()) {
      return;
    }
    const current = appStore.get(rulesAtom) ?? [];
    // Mirror the server's checks before the round-trip so a rejected save
    // shows on the offending row instead of costing a request.
    const issues = validateRules(current);
    if (issues.length > 0) {
      setSaveIssues(issues);
      setError("Fix the highlighted rules before saving.");
      setNote(null);
      return;
    }
    setSaving(true);
    setError(null);
    setNote(null);
    setSaveIssues([]);
    try {
      const saved = await putRegexRules(current);
      applyRules(saved);
      setNote("Saved");
    } catch (err) {
      if (err instanceof ApiError) {
        const issues = detailIssues(err.details);
        setSaveIssues(issues.filter((issue) => mapsToRow(issue.path)));
      }
      setError(err instanceof Error ? err.message : "Failed to save regex rules");
    } finally {
      setSaving(false);
    }
  };

  /** Editor save: patches the list locally, then PUTs the whole set. */
  const saveEditor = async (): Promise<void> => {
    // busy(), not just saving(): an in-flight enable toggle also PUTs the whole
    // list, and two concurrent whole-list writes could land out of order.
    if (busy()) {
      return;
    }
    const current = draft;
    const issues = validateDraft(current);
    if (issues.length > 0) {
      setEditorIssues(issues);
      setEditorError(null);
      return;
    }
    const editing = editingId;
    const id = editing ?? newRuleId();
    const rule = draftToRule(current, id);
    const list = appStore.get(rulesAtom) ?? [];
    const next =
      editing === null
        ? [...list, rule]
        : list.map((entry) => (entry.id === editing ? rule : entry));
    const index = next.findIndex((entry) => entry.id === id);
    setSaving(true);
    setEditorIssues([]);
    setEditorError(null);
    setError(null);
    setSaveIssues([]);
    try {
      const saved = await putRegexRules(next);
      applyRules(saved);
      setNote("Saved");
      closeEditor();
    } catch (err) {
      if (err instanceof ApiError) {
        const issues = detailIssues(err.details);
        const { mine, others } = splitEditorDetails(issues, index);
        setEditorIssues(mine);
        // Sibling-rule issues land on their own rows; a shape error that maps
        // nowhere leaves the editor showing the server's message.
        setSaveIssues(others.filter((issue) => mapsToRow(issue.path)));
        setEditorError(mine.length > 0 ? null : err.message);
      } else {
        setEditorError(err instanceof Error ? err.message : "Failed to save rule");
      }
    } finally {
      setSaving(false);
    }
  };

  /**
   * Imports a picked file. A staged-but-unsaved edit (a delete/duplicate
   * waiting on Save) is flushed FIRST: the server's append base is its stored
   * set, so importing over staged changes would silently discard them. The
   * flush is what makes "import never loses your edits" true regardless of the
   * mode chosen.
   */
  const importFile = async (file: File): Promise<void> => {
    if (busy()) {
      return;
    }
    const mode = importMode;
    // The response reports the FINAL stored set, not the imported subset, so
    // the count is derived against the baseline immediately before the import.
    setImporting(true);
    setImportNotice(null);
    setError(null);
    setNote(null);
    setSaveIssues([]);
    try {
      if (rulesDirty(appStore.get(rulesAtom), appStore.get(savedRulesAtom))) {
        // Throws on rejection and lands in the catch below with its message.
        applyRules(await putRegexRules(appStore.get(rulesAtom) ?? []));
      }
      const before = (appStore.get(rulesAtom) ?? []).length;
      let doc: unknown;
      try {
        doc = JSON.parse(await file.text());
      } catch {
        throw new Error("Import file is not valid JSON");
      }
      const result = await importRegexRules(doc, mode);
      applyRules(result.rules);
      setImportNotice({
        imported: mode === "replace" ? result.rules.length : result.rules.length - before,
        skipped: result.skipped,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const nameIssue = editorIssue("name");
  const findIssue = editorIssue("find");
  const placementIssue = editorIssue("placement");

  return (
    <div className="set-stack">
      <p className="caption muted set-intro">
        Rules find and replace text at generation time, like SillyTavern's regex scripts. Each rule
        is global and picks which message classes it touches, and the replacement supports
        JavaScript’s <code>$1</code>-style capture groups.
      </p>
      <ul className="regex-placement-help">
        {PLACEMENT_OPTIONS.map((option) => (
          <li className="caption muted" key={option.id}>
            <strong>{option.label}</strong> — {option.hint}
          </li>
        ))}
      </ul>

      {rules !== null ? (
        <>
          <div className="row regex-actions">
            {/* The empty state carries its own "Add rule" action, so the
                toolbar button only appears once a list exists — never both. */}
            {(rules ?? []).length > 0 && (
              <button type="button" className="btn btn-primary" onClick={startCreate}>
                <Plus size={16} />
                Add rule
              </button>
            )}
            <FileInput disabled={busy()} onFile={importFile} />
            <a className="btn" href={regexExportUrl()} download="">
              <Download size={16} />
              Export
            </a>
            <div className="regex-import-mode">
              <Segmented
                options={IMPORT_MODE_OPTIONS}
                value={importMode}
                onChange={setImportMode}
                ariaLabel="Import mode"
              />
              <span className="set-row-hint">
                Append keeps the current rules and renames name collisions; replace swaps the whole
                set for the file's.
              </span>
            </div>
          </div>

          {importNotice && (
            <div className="regex-import-notice">
              <p className="transfer-msg">
                <Check size={14} />
                Imported {importNotice.imported} rule{importNotice.imported === 1 ? "" : "s"}.
              </p>
              {importNotice.skipped.length > 0 && (
                <>
                  <p className="caption muted regex-skipped-head">
                    <TriangleAlert size={14} aria-hidden="true" />
                    {importNotice.skipped.length}{" "}
                    {importNotice.skipped.length === 1 ? "entry" : "entries"} skipped:
                  </p>
                  <ul className="regex-skipped-list">
                    {importNotice.skipped.map((entry) => (
                      // The importer's skipped entries carry no id; name+reason
                      // is the stable pair it reports, and it is unique in practice.
                      <li key={`${entry.name}:${entry.reason}`}>
                        <strong>{entry.name}</strong> — {entry.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {(rules ?? []).length > 0 ? (
            <div className="regex-list">
              {/* Presence animates a rule card in on add/duplicate and out on
                  delete; keys are rule ids, so an immediate toggle that
                  replaces the array with fresh objects animates nothing. */}
              <Presence>
                {rules.map((rule, index) => {
                  const rowFindIssue = issueMessage(saveIssues, index, "find");
                  const rowIdIssue = issueMessage(saveIssues, index, "id");
                  const rowNameIssue = issueMessage(saveIssues, index, "name");
                  const rowPlacementIssue = issueMessage(saveIssues, index, "placement");
                  return (
                    <motion.article
                      className={cx("card regex-card", !rule.enabled && "is-off")}
                      key={rule.id}
                      variants={riseVariants(app)}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                    >
                      <div className="regex-card-head">
                        <div className="regex-card-title">
                          <span className="regex-card-name">{rule.name}</span>
                          <code className="regex-card-source">
                            <span className="regex-card-find">{rule.find}</span>
                            <span aria-hidden="true">→</span>
                            <span className="regex-card-replace">
                              {rule.replace === "" ? "(removed)" : rule.replace}
                            </span>
                          </code>
                        </div>
                        {/* A bare label forwarding clicks to the checkbox keeps the
                            .switch primitive; the input's aria-label names the rule. */}
                        <label
                          className="switch regex-card-switch"
                          htmlFor={`regex-enabled-${rule.id}`}
                        >
                          <input
                            id={`regex-enabled-${rule.id}`}
                            type="checkbox"
                            className="switch-input"
                            checked={rule.enabled}
                            disabled={busy()}
                            aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
                            onChange={(event) => toggle(rule, event.currentTarget.checked)}
                          />
                          <span className="switch-track">
                            <span className="switch-thumb" />
                          </span>
                        </label>
                      </div>
                      <div className="regex-card-foot">
                        <div className="regex-placements">
                          {PLACEMENT_OPTIONS.map((option) =>
                            rule.placement.includes(option.id) ? (
                              <span className="pill" key={option.id}>
                                {option.label}
                              </span>
                            ) : null,
                          )}
                        </div>
                        <div className="row regex-card-actions">
                          <button
                            type="button"
                            className="btn btn-icon"
                            aria-label={`Edit ${rule.name}`}
                            data-tip="Edit"
                            disabled={busy()}
                            onClick={() => startEdit(rule)}
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            type="button"
                            className="btn btn-icon"
                            aria-label={`Duplicate ${rule.name}`}
                            data-tip="Duplicate"
                            disabled={busy()}
                            onClick={() => duplicate(rule)}
                          >
                            <Copy size={16} />
                          </button>
                          <button
                            type="button"
                            className="btn btn-icon btn-danger"
                            aria-label={`Delete ${rule.name}`}
                            data-tip="Delete"
                            disabled={busy()}
                            onClick={() => remove(rule)}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                      {rowFindIssue && <p className="field-error">Regex value: {rowFindIssue}</p>}
                      {rowIdIssue && <p className="field-error">Rule id: {rowIdIssue}</p>}
                      {rowNameIssue && <p className="field-error">Name: {rowNameIssue}</p>}
                      {rowPlacementIssue && (
                        <p className="field-error">Targets: {rowPlacementIssue}</p>
                      )}
                    </motion.article>
                  );
                })}
              </Presence>
            </div>
          ) : (
            <SettingsEmpty
              icon={<Regex size={36} />}
              title="No regex rules yet"
              hint="Add a rule to find and replace text in prompts and replies."
              action={
                <button type="button" className="btn btn-primary" onClick={startCreate}>
                  <Plus size={16} />
                  Add rule
                </button>
              }
            />
          )}

          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy() || !dirty()}
              onClick={() => void saveAll()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <SettingsSaved note={note} />
            {error && <span className="field-error">{error}</span>}
          </div>
        </>
      ) : loadError === null ? (
        <SettingsLoading label="Loading regex rules…" rows={3} />
      ) : (
        <SettingsError
          title="Couldn't load regex rules"
          details={loadError}
          onRetry={() => void refresh()}
        />
      )}

      {editorOpen && (
        <Modal
          title={editingId === null ? "New regex rule" : "Edit regex rule"}
          onClose={closeEditor}
          wide
        >
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void saveEditor();
            }}
          >
            <div className="field">
              <label className="field-label" htmlFor="regex-name-input">
                Name
              </label>
              <input
                id="regex-name-input"
                className="input"
                value={draft.name}
                onChange={(event) => editDraft({ name: event.currentTarget.value })}
              />
              {nameIssue && <span className="field-error">{nameIssue}</span>}
            </div>

            <div className="field">
              <label className="field-label" htmlFor="regex-find-input">
                Regex value
              </label>
              <input
                id="regex-find-input"
                className="input regex-mono"
                placeholder={"/[“”„″‟❝❞«»]/ig"}
                spellCheck={false}
                autoComplete="off"
                value={draft.find}
                onChange={(event) => editDraft({ find: event.currentTarget.value })}
              />
              <span className="field-hint">
                A <code>/pattern/flags</code> literal or a bare pattern — either is accepted, and
                the flags default to <code>g</code> (replace all).
              </span>
              {findIssue && <span className="field-error">{findIssue}</span>}
            </div>

            <div className="field">
              <label className="field-label" htmlFor="regex-replace-input">
                Replace with
              </label>
              <input
                id="regex-replace-input"
                className="input regex-mono"
                placeholder="Replacement text"
                spellCheck={false}
                autoComplete="off"
                value={draft.replace}
                onChange={(event) => editDraft({ replace: event.currentTarget.value })}
              />
              <span className="field-hint">
                Empty removes the match. <code>$1</code>-style capture groups from the pattern are
                supported.
              </span>
            </div>

            <div className="field">
              <span className="field-label">For</span>
              <div className="set-rows">
                {PLACEMENT_OPTIONS.map((option) => (
                  <label
                    className="switch-row"
                    htmlFor={`regex-placement-${option.id}`}
                    key={option.id}
                  >
                    <span className="set-row-main">
                      <span className="set-row-label">{option.label}</span>
                      <span className="set-row-hint">{option.hint}</span>
                    </span>
                    <span className="switch">
                      <input
                        id={`regex-placement-${option.id}`}
                        type="checkbox"
                        className="switch-input"
                        checked={draft.placement.includes(option.id)}
                        onChange={() => togglePlacement(option.id)}
                      />
                      <span className="switch-track">
                        <span className="switch-thumb" />
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {placementIssue && <span className="field-error">{placementIssue}</span>}
            </div>

            <label className="switch-row" htmlFor="regex-enabled-input">
              <span className="set-row-main">
                <span className="set-row-label">Enabled</span>
                <span className="set-row-hint">
                  Off keeps the rule saved but skips it at generation.
                </span>
              </span>
              <span className="switch">
                <input
                  id="regex-enabled-input"
                  type="checkbox"
                  className="switch-input"
                  checked={draft.enabled}
                  onChange={(event) => editDraft({ enabled: event.currentTarget.checked })}
                />
                <span className="switch-track">
                  <span className="switch-thumb" />
                </span>
              </span>
            </label>

            <div className="field">
              <label className="field-label" htmlFor="regex-preview-input">
                Preview
              </label>
              <textarea
                id="regex-preview-input"
                className="textarea"
                rows={2}
                placeholder="Type sample text to see this rule applied"
                aria-label="Preview input"
                value={previewInput}
                onChange={(event) => setPreviewInput(event.currentTarget.value)}
              />
              {/* Read-only output; it re-derives on every find/replace/input
                  change, so the editor always shows the rule as it stands.
                  Self-inflicted only: the sample text is typed by the user and
                  the pattern is the rule being edited, so the known
                  catastrophic-backtracking risk (see core's engine/regex) can
                  at worst stall this preview, never a generation. */}
              <textarea
                className="textarea regex-mono"
                rows={2}
                readOnly
                aria-label="Preview output"
                value={previewOutput()}
              />
              <span className="field-hint">Preview only — nothing here is saved.</span>
            </div>

            <RegexEditorFooter saving={saving} dirty={editorDirty()} error={editorError} />
          </form>
        </Modal>
      )}
      {dialog}
    </div>
  );
}
