/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/*
 * EntryEditor — the lorebook entry surface.
 *
 * SillyTavern's entry carries 23 flat fields; rendered as one undifferentiated
 * list they are unreadable. The editor groups them into three collapsible
 * taxonomy wells (Content / Activation / Placement) so the common keyword work
 * sits at the top and the placement-tuning tail folds away. The grouping is
 * presentational only — every field keeps its exact label, id and tooltip, the
 * `Draft` shape and the save payload are untouched.
 *
 * Structure follows the character editor's landed pattern: an xl Modal with a
 * pinned header carrying the status pill + Save/Cancel (the Save submits the
 * body form via `form=`), and Motion/Collapsible for the disclosures.
 */

import type { ReactElement, ReactNode } from "react";
import { useState } from "react";
import type { LorebookEntry, LorebookSection } from "../../lib/api-lorebooks";
import { addEntry, updateEntry } from "../../lib/api-lorebooks";
import { cx } from "../../lib/cx";
import { useLorebookGenerationConfig } from "../../stores/ai-generation";
import { FieldLabel } from "../FieldLabel";
import { Collapsible } from "../ui/collapsible";
import { ChevronDown, Info, Sparkles } from "../ui/icons";
import Modal, { useModalClose } from "../ui/Modal";
import GenerateEntryModal from "./GenerateEntryModal";
import "../../styles/lorebooks.css";

interface EntryEditorProps {
  lorebookId: string;
  /** Existing entry to edit, or null to create a new one. */
  entry: LorebookEntry | null;
  /** The book's sections, for the Section picker. */
  sections: readonly LorebookSection[];
  /** Section a NEW entry joins when the picker is left untouched; null =
   *  ungrouped. Ignored when editing an existing entry. */
  defaultSectionId: string | null;
  onSaved: (entry: LorebookEntry) => void;
  onClose: () => void;
}

/** Editable draft of an entry; all fields as plain form values. */
interface Draft {
  keys: string;
  secondary: string;
  content: string;
  comment: string;
  constant: boolean;
  selective: boolean;
  enabled: boolean;
  vectorized: boolean;
  logic: number;
  order: number;
  position: number;
  depth: number;
  probability: number;
  sticky: number;
  cooldown: number;
  delay: number;
  scan_depth: number | null;
  role: string;
  group: string;
  group_weight: number | null;
  case_sensitive: boolean;
  match_whole_words: boolean;
  /** Organizational section id; "" is the ungrouped option (sent as null). */
  section_id: string;
}

/**
 * The section a draft starts on, healed against the book's live sections: an
 * entry may still carry a `section_id` the book no longer has (deleted on
 * another tab before this store refreshed). The picker then has no matching
 * option, and PATCHing the dangling id back would 400 — so an unknown id
 * collapses to the ungrouped sentinel "", matching how the editor renders
 * such an entry. A saved entry always wins over `defaultSectionId`.
 */
const draftSectionId = (
  entry: LorebookEntry | null,
  defaultSectionId: string | null,
  sections: readonly LorebookSection[],
): string => {
  const wanted = entry !== null ? entry.section_id : defaultSectionId;
  return wanted !== null && sections.some((section) => section.id === wanted) ? wanted : "";
};

const draftFromEntry = (
  entry: LorebookEntry | null,
  defaultSectionId: string | null,
  sections: readonly LorebookSection[],
): Draft => ({
  keys: (entry?.keys ?? []).join(", "),
  secondary: (entry?.secondary ?? []).join(", "),
  content: entry?.content ?? "",
  comment: entry?.comment ?? "",
  constant: entry?.constant ?? false,
  selective: entry?.selective ?? false,
  enabled: entry?.enabled ?? true,
  vectorized: entry?.vectorized ?? false,
  logic: entry?.logic ?? 0,
  order: entry?.order ?? 100,
  position: entry?.position ?? 0,
  depth: entry?.depth ?? 4,
  probability: entry?.probability ?? 100,
  sticky: entry?.sticky ?? 0,
  cooldown: entry?.cooldown ?? 0,
  delay: entry?.delay ?? 0,
  scan_depth: entry?.scan_depth ?? null,
  role: entry?.role ?? "",
  group: entry?.group ?? "",
  group_weight: entry?.group_weight ?? null,
  case_sensitive: entry?.case_sensitive ?? false,
  match_whole_words: entry?.match_whole_words ?? true,
  // An existing entry keeps its own section; a new one starts in the section
  // whose header opened this editor (or ungrouped). Both are healed against
  // the live section list by `draftSectionId`.
  section_id: draftSectionId(entry, defaultSectionId, sections),
});

const toKeys = (text: string): string[] =>
  text
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
const orNull = (text: string): string | null => {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
};
const toNum = (text: string): number => {
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
};
const toNullableNum = (text: string): number | null => (text.trim() === "" ? null : toNum(text));

/** Every key of the draft, for the dirty comparison below. Stable order. */
const DRAFT_KEYS: readonly (keyof Draft)[] = [
  "keys",
  "secondary",
  "content",
  "comment",
  "constant",
  "selective",
  "enabled",
  "vectorized",
  "logic",
  "order",
  "position",
  "depth",
  "probability",
  "sticky",
  "cooldown",
  "delay",
  "scan_depth",
  "role",
  "group",
  "group_weight",
  "case_sensitive",
  "match_whole_words",
  "section_id",
];

const draftsDiffer = (a: Draft, b: Draft): boolean => DRAFT_KEYS.some((key) => a[key] !== b[key]);

type StatusTone = "clean" | "dirty" | "danger";
interface Status {
  tone: StatusTone;
  text: string;
}

/**
 * Tooltips for every field, in SillyTavern terms. Kept in one table (rather
 * than inline next to each input) so the wording stays reviewable in one
 * place and the field tuples below stay single-line.
 *
 * Each tip must explain the *effect* of the field, not restate its label.
 */
const FIELD_TIPS: Record<string, string> = {
  keys: "Words or phrases scanned for in recent messages; a `/regex/flags` key is matched as a regular expression. Any one match activates the entry.",
  secondary:
    "Extra keys evaluated only when Selective is on; Logic decides how multiple secondary keys combine.",
  content: "The text injected into the prompt when the entry activates. Supports {{macros}}.",
  comment: "Your own note shown as the entry's title in the list; it is never sent to the model.",
  constant:
    "Fires on every generation without a keyword match. Delay and Cooldown still hold it back (Cooldown only while it is not sticky), it still rolls its Probability, and it still competes in its inclusion group and spends the token budget.",
  selective:
    "Gates activation on the secondary keys instead of firing on any primary key match alone.",
  enabled: "Master on/off for this entry. Disabled entries stay saved but never activate.",
  vectorized:
    "Imported SillyTavern flag for vector/embedding retrieval. SuvojTavern's keyword engine ignores it; kept so round-tripped exports stay faithful.",
  logic:
    "How secondary keys combine: 0 = at least one matches (AND_ANY), 1 = at least one does not match (NOT_ALL), 2 = none match (NOT_ANY), 3 = all match (AND_ALL).",
  order:
    "Priority within the token budget; higher-order entries are considered first and win when the world-info budget runs out.",
  position:
    "Where the text lands: 0 before the character, 1 after it, 2/3 directly after the character definitions, 4 injected into the chat history at Depth. v1 has no author's-note block, so SillyTavern's AN meaning for 2/3 does not apply — they render in worldInfoAfter order, before Depth injections.",
  depth:
    "For Position 4 only: how many messages back from the end of the chat the injection is placed (0 = right after the last message).",
  probability:
    "Percent chance the entry activates when matched; 100 always activates. Sticky carry-over skips this roll.",
  sticky:
    "After activating, the entry stays in the prompt for this many extra turns even without matching again.",
  cooldown: "Once the entry deactivates, this many turns must pass before it can activate again.",
  delay:
    "Asks the entry to wait this many turns after its first sighting before it may activate at all.",
  scan_depth:
    "How many recent messages this entry scans, overriding the preset's global scan depth. Blank = use the global value.",
  role: "Speaker role for a Position 4 injection: system, user, or assistant. Blank defaults to system.",
  group:
    "Inclusion-group name. Only one entry per group may activate per generation; the winner is weighted by Group weight.",
  group_weight: "Relative odds of this entry winning its group. Blank counts as 100.",
  case_sensitive:
    "Require the message to match the key's exact capitalisation instead of ignoring case.",
  match_whole_words:
    'Only match keys that stand alone as whole words, so "art" does not fire inside "start". Multi-word keys always match as substrings.',
  section:
    "Organizational only: which section this entry is grouped under in the lorebook editor. Sections never affect activation or injection. Ungrouped entries list after every section.",
};

type TextKey = "keys" | "secondary" | "comment" | "role" | "group";
type NumKey =
  | "logic"
  | "order"
  | "position"
  | "depth"
  | "probability"
  | "sticky"
  | "cooldown"
  | "delay";
type NullableNumKey = "scan_depth" | "group_weight";
type CheckKey =
  | "constant"
  | "selective"
  | "enabled"
  | "vectorized"
  | "case_sensitive"
  | "match_whole_words";

/**
 * Field taxonomy: every Draft key appears exactly once across the three wells.
 * Activation leads with the state switches (the flags the cards surface), then
 * the numeric knobs they gate. Placement is the injection-tuning tail, folded
 * by default because it is the least-touched surface.
 */
const ACTIVATION_CHECK_FIELDS: readonly (readonly [CheckKey, string])[] = [
  ["enabled", "Enabled"],
  ["constant", "Constant"],
  ["selective", "Selective"],
  ["vectorized", "Vectorized"],
  ["case_sensitive", "Case sensitive"],
  ["match_whole_words", "Match whole words"],
];
const ACTIVATION_NUM_FIELDS: readonly (readonly [NumKey, string])[] = [
  ["probability", "Probability %"],
  ["logic", "Logic"],
];
const PLACEMENT_NUM_FIELDS: readonly (readonly [NumKey, string])[] = [
  ["position", "Position"],
  ["order", "Order"],
  ["depth", "Depth"],
  ["sticky", "Sticky"],
  ["cooldown", "Cooldown"],
  ["delay", "Delay"],
];
const PLACEMENT_NULLABLE_NUM_FIELDS: readonly (readonly [NullableNumKey, string])[] = [
  ["scan_depth", "Scan depth (blank = global)"],
  ["group_weight", "Group weight (blank = none)"],
];
const PLACEMENT_TEXT_FIELDS: readonly (readonly [TextKey, string])[] = [
  ["role", "Role (system / user / assistant)"],
  ["group", "Group"],
];

/**
 * A `<label>` (or `<span>`) plus a sibling Info button carrying the field's
 * tooltip, via the shared `FieldLabel`. The tip text comes from FIELD_TIPS
 * keyed by the field id; `action` is an optional trailing affordance (e.g. the
 * AI-generate button) rendered after the Info button.
 */
function fieldLabel(id: string, label: string, action?: ReactNode): ReactNode {
  return (
    <FieldLabel
      htmlFor={`entry-field-${id}`}
      text={label}
      tip={FIELD_TIPS[id] ?? ""}
      action={action}
    />
  );
}

interface FieldGroupProps {
  id: string;
  title: string;
  /** Info tooltip: what the whole group governs. */
  tip: string;
  /** Compact one-line digest of the group's current values. */
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/**
 * One collapsible taxonomy well. The header is a real <button> (so the whole
 * title row toggles and the chevron rotation is a transform), with the Info
 * affordance as a sibling so its label never folds into the toggle's name.
 * `Collapsible` keeps the body mounted but `inert` while closed, so no hidden
 * field can be tabbed into or read by AT. The open state rides the toggle's
 * own `aria-expanded` (the one disclosure mechanism shared by every trigger),
 * so the chevron needs no separate data attribute.
 */
function FieldGroup(props: FieldGroupProps): ReactElement {
  const bodyId = `entry-group-${props.id}`;
  return (
    <section className="entry-group">
      <h3 className="entry-group-head">
        <button
          type="button"
          className="entry-group-toggle"
          aria-expanded={props.open}
          aria-controls={bodyId}
          onClick={props.onToggle}
        >
          <span className="entry-group-chevron" aria-hidden="true">
            <ChevronDown size={14} />
          </span>
          <span className="entry-group-title">{props.title}</span>
          <span className="entry-group-summary tnum">{props.summary}</span>
        </button>
        <button type="button" className="info-tip" aria-label={props.tip} data-tip={props.tip}>
          <Info size={13} aria-hidden="true" />
        </button>
      </h3>
      <Collapsible open={props.open} id={bodyId} className="entry-group-body">
        <div className="entry-group-fields">{props.children}</div>
      </Collapsible>
    </section>
  );
}

/**
 * The entry editor's pinned header actions. Extracted so Cancel can call
 * `useModalClose()` — the hook must run in a child of <Modal>, never in the
 * component that renders it — so the panel's exit animation plays before the
 * parent unmounts it. Save stays in the sticky header but submits the body form
 * through `form=`, so the primary action never scrolls out of reach.
 */
function EntryEditorActions(props: { status: Status; saving: boolean }): ReactElement {
  const close = useModalClose();
  return (
    <>
      <span className={cx("entry-status", `entry-status-${props.status.tone}`)} role="status">
        <span className="entry-status-dot" aria-hidden="true" />
        {props.status.text}
      </span>
      <button type="button" className="btn" onClick={close}>
        Cancel
      </button>
      <button
        type="submit"
        form="entry-editor-form"
        className="btn btn-primary"
        disabled={props.saving}
      >
        {props.saving && <span className="spinner btn-spinner" aria-hidden="true" />}
        {props.saving ? "Saving…" : "Save entry"}
      </button>
    </>
  );
}

/** Modal editor for a single lorebook entry — the full field surface. */
export default function EntryEditor(props: EntryEditorProps) {
  // One state object for the whole draft, seeded lazily from the entry this
  // editor was opened on (props are read once, at setup). `baseline` is the
  // same seed, kept to derive the dirty status; field writes replace the
  // draft object immutably, so a keystroke re-renders the controlled inputs
  // in place and never remounts the form.
  const [baseline] = useState<Draft>(() =>
    draftFromEntry(props.entry, props.defaultSectionId, props.sections),
  );
  const [draft, setDraft] = useState<Draft>(baseline);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Whether the nested AI generator dialog is open. The generator config gates
  // the Content field's generate action; when the feature is off the modal is
  // never reachable but stays mounted (mirroring the character editor).
  const gen = useLorebookGenerationConfig();
  const [generateOpen, setGenerateOpen] = useState(false);
  // Content and Activation are the working surface and start open; Placement
  // holds the rarely-touched injection tuning and starts folded.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(
    () => new Set(["content", "activation"]),
  );

  const setField = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((current) => {
      const next: Draft = { ...current };
      next[key] = value;
      return next;
    });
  };

  const toggleGroup = (id: string): void => {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const save = (): void => {
    if (saving) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    const payload = {
      ...draft,
      keys: toKeys(draft.keys),
      secondary: toKeys(draft.secondary),
      role: orNull(draft.role),
      group: orNull(draft.group),
      // The picker's "" sentinel is the ungrouped option, which the contract
      // spells null.
      section_id: draft.section_id === "" ? null : draft.section_id,
    };
    (props.entry === null
      ? addEntry(props.lorebookId, payload)
      : updateEntry(props.lorebookId, props.entry.id, payload)
    )
      .then((result) => {
        setSaving(false);
        props.onSaved(result);
      })
      .catch((err: unknown) => {
        setSaving(false);
        setSaveError(err instanceof Error ? err.message : "Failed to save entry");
      });
  };

  /** Boolean fields rendered as labeled switches. */
  const switchGrid = (fields: readonly (readonly [CheckKey, string])[]): ReactNode => (
    <div className="switch-grid">
      {fields.map(([key, label]) => (
        <div className="switch-option" key={key}>
          {/* The label wraps only the text + track so its accessible name
              stays e.g. "Constant"; the Info button is a sibling, not content
              that would be folded into that name. */}
          <label className="switch-option-main">
            <span className="switch-option-label">{label}</span>
            <span className="switch">
              <input
                type="checkbox"
                className="switch-input"
                checked={draft[key]}
                onChange={(event) => setField(key, event.currentTarget.checked)}
              />
              <span className="switch-track">
                <span className="switch-thumb" />
              </span>
            </span>
          </label>
          <button
            type="button"
            className="info-tip"
            aria-label={FIELD_TIPS[key] ?? ""}
            data-tip={FIELD_TIPS[key] ?? ""}
          >
            <Info size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );

  // --- Compact summaries -----------------------------------------------------

  const keyCount = toKeys(draft.keys).length;
  const secondaryCount = toKeys(draft.secondary).length;
  const contentSummary =
    keyCount === 0
      ? "No keys"
      : `${keyCount} key${keyCount === 1 ? "" : "s"}${
          secondaryCount > 0 ? ` · ${secondaryCount} secondary` : ""
        }`;

  // The flag digest shown both at the top of the form and on the Activation
  // header, so a collapsed group still tells you what the entry will do.
  const activationFlags: string[] = [];
  if (draft.constant) {
    activationFlags.push("Constant");
  }
  if (draft.selective) {
    activationFlags.push("Selective");
  }
  if (draft.vectorized) {
    activationFlags.push("Vectorized");
  }
  if (draft.case_sensitive) {
    activationFlags.push("Case-sensitive");
  }
  const activationSummary =
    activationFlags.length > 0 ? activationFlags.join(" · ") : "Keyword match";

  const sectionName =
    draft.section_id === ""
      ? "Ungrouped"
      : (props.sections.find((section) => section.id === draft.section_id)?.name ?? "Ungrouped");
  const placementSummary = `pos ${draft.position} · depth ${draft.depth} · order ${draft.order} · ${sectionName}`;

  const status: Status = saving
    ? { tone: "clean", text: "Saving…" }
    : saveError !== null
      ? { tone: "danger", text: "Save failed" }
      : draftsDiffer(draft, baseline)
        ? { tone: "dirty", text: "Unsaved changes" }
        : props.entry === null
          ? { tone: "clean", text: "New entry" }
          : { tone: "clean", text: "All changes saved" };

  return (
    <Modal
      title={props.entry === null ? "Add lorebook entry" : "Edit lorebook entry"}
      xl
      onClose={props.onClose}
      actions={<EntryEditorActions status={status} saving={saving} />}
    >
      <form
        id="entry-editor-form"
        className="stack entry-editor"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="entry-flag-row">
          <span className={cx("entry-flag", !draft.enabled && "entry-flag-off")}>
            {draft.enabled ? "Enabled" : "Disabled"}
          </span>
          {activationFlags.map((flag) => (
            <span className="entry-flag" key={flag}>
              {flag}
            </span>
          ))}
          <span className="entry-flag entry-flag-quiet tnum">{contentSummary}</span>
        </div>

        <FieldGroup
          id="content"
          title="Content"
          tip="What the entry watches for and what it injects: its primary keys, the gated secondary keys, the injected text, and your own note."
          summary={contentSummary}
          open={openGroups.has("content")}
          onToggle={() => toggleGroup("content")}
        >
          <div className="field">
            {fieldLabel("keys", "Keys (comma-separated)")}
            <input
              id="entry-field-keys"
              className="input"
              value={draft.keys}
              onChange={(event) => setField("keys", event.currentTarget.value)}
            />
          </div>
          <div className="field">
            {fieldLabel("secondary", "Secondary keys (comma-separated)")}
            <input
              id="entry-field-secondary"
              className="input"
              value={draft.secondary}
              onChange={(event) => setField("secondary", event.currentTarget.value)}
            />
          </div>
          <div className="field">
            {fieldLabel(
              "content",
              "Content",
              gen.enabled ? (
                <button
                  type="button"
                  className="btn btn-icon entry-generate-btn"
                  aria-label="Generate content with AI"
                  data-tip="Generate with AI"
                  onClick={() => setGenerateOpen(true)}
                >
                  <Sparkles size={14} />
                </button>
              ) : undefined,
            )}
            <textarea
              id="entry-field-content"
              className="textarea"
              rows={5}
              value={draft.content}
              onChange={(event) => setField("content", event.currentTarget.value)}
            />
          </div>
          <div className="field">
            {fieldLabel("comment", "Comment")}
            <input
              id="entry-field-comment"
              className="input"
              value={draft.comment}
              onChange={(event) => setField("comment", event.currentTarget.value)}
            />
          </div>
        </FieldGroup>

        <FieldGroup
          id="activation"
          title="Activation"
          tip="When and how often the entry activates once its keys match: always-on, gated by secondary keys, or left disabled entirely."
          summary={activationSummary}
          open={openGroups.has("activation")}
          onToggle={() => toggleGroup("activation")}
        >
          {switchGrid(ACTIVATION_CHECK_FIELDS)}
          <div className="field-grid">
            {ACTIVATION_NUM_FIELDS.map(([key, label]) => (
              <div className="field" key={key}>
                {fieldLabel(key, label)}
                <input
                  id={`entry-field-${key}`}
                  className="input"
                  type="number"
                  value={draft[key]}
                  onChange={(event) => setField(key, toNum(event.currentTarget.value))}
                />
              </div>
            ))}
          </div>
        </FieldGroup>

        <FieldGroup
          id="placement"
          title="Placement"
          tip="Where the injected text lands, how entries compete for the token budget, and how they are grouped. These are the rarely-changed knobs."
          summary={placementSummary}
          open={openGroups.has("placement")}
          onToggle={() => toggleGroup("placement")}
        >
          <div className="field">
            {fieldLabel("section", "Section")}
            <select
              id="entry-field-section"
              className="select"
              value={draft.section_id}
              onChange={(event) => setField("section_id", event.currentTarget.value)}
            >
              <option value="">Ungrouped</option>
              {props.sections.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field-grid">
            {PLACEMENT_NUM_FIELDS.map(([key, label]) => (
              <div className="field" key={key}>
                {fieldLabel(key, label)}
                <input
                  id={`entry-field-${key}`}
                  className="input"
                  type="number"
                  value={draft[key]}
                  onChange={(event) => setField(key, toNum(event.currentTarget.value))}
                />
              </div>
            ))}
            {PLACEMENT_NULLABLE_NUM_FIELDS.map(([key, label]) => (
              <div className="field" key={key}>
                {fieldLabel(key, label)}
                <input
                  id={`entry-field-${key}`}
                  className="input"
                  type="number"
                  value={draft[key] ?? ""}
                  onChange={(event) => setField(key, toNullableNum(event.currentTarget.value))}
                />
              </div>
            ))}
          </div>
          <div className="field-grid">
            {PLACEMENT_TEXT_FIELDS.map(([key, label]) => (
              <div className="field" key={key}>
                {fieldLabel(key, label)}
                <input
                  id={`entry-field-${key}`}
                  className="input"
                  value={draft[key]}
                  onChange={(event) => setField(key, event.currentTarget.value)}
                />
              </div>
            ))}
          </div>
        </FieldGroup>

        {saveError !== null && (
          <p className="error-banner" role="alert">
            {saveError}
          </p>
        )}
      </form>
      {/* Nested, but portaled into <body>; Modal's closers stack hands Escape
          to the top modal, so closing the generator returns to this editor.
          Mounted only while open (the shared Modal pattern) so its own exit
          animation plays on Apply/Cancel; its Cancel/Apply route through
          useModalClose, and remounting per open resets its transient fields.
          Reads the live content draft on Apply, so the accepted text lands in
          the editor (the dirty indicator then lights up as usual). */}
      {generateOpen && (
        <GenerateEntryModal
          currentContent={draft.content}
          onApply={(text) => setField("content", text)}
          onClose={() => setGenerateOpen(false)}
        />
      )}
    </Modal>
  );
}
