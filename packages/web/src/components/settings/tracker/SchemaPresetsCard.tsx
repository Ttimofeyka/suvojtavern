/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../../lib/cx";
import { fadeVariants, INSTANT, useAppMotion } from "../../../lib/motion";
import { schemaSample } from "../../../lib/schema-sample";
import {
  DEFAULT_TRACKER_SCHEMA_PRESETS,
  effectivePartCount,
  groupFieldsByPart,
  MAX_TRACKER_PARTS,
  normalizeParts,
  presetFieldNames,
  TRACKER_PRESET_KEY_RE,
  type TrackerConfig,
  type TrackerPartsConfig,
  type TrackerSchemaPreset,
} from "../../../lib/tracker-config";
import { capitalizeSnapshot } from "../../../lib/tracker-display";
import { renderTemplate } from "../../../lib/tracker-template";
import { useConfirmDialog } from "../../ui/ConfirmDialog";
import { Collapsible } from "../../ui/collapsible";
import {
  Check,
  ChevronDown,
  ChevronUp,
  FileJson,
  Layers,
  List,
  Plus,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  Tag,
  TriangleAlert,
  X,
} from "../../ui/icons";
import Modal from "../../ui/Modal";
import { Presence } from "../../ui/presence";
import { ReorderableList } from "../../ui/reorder";
import { Segmented } from "../../ui/segmented";
import { Stagger, StaggerItem } from "../../ui/stagger";
import { NumberStepper } from "../Stepper";
import { JsonEditor } from "./JsonEditor";
import { PresetRail } from "./PresetRail";
import {
  addChild,
  addField,
  type FormField,
  type FormSubField,
  formIssues,
  formToSchema,
  moveField,
  moveSubField,
  removeChild,
  removeField,
  type SchemaForm,
  schemasEqual,
  schemaToForm,
  updateChild,
  updateField,
} from "./schema-form";
import { ensureRowIds, rowIds, singleMove } from "./schema-rows";
import { TemplatePane } from "./TemplatePane";
import { generateTemplateFromSchema } from "./template-generate";

/** Type choices for top-level fields. */
const FIELD_TYPES: Array<{ id: FormField["type"]; name: string }> = [
  { id: "string", name: "Text" },
  { id: "number", name: "Number" },
  { id: "boolean", name: "Boolean" },
  { id: "object", name: "Object" },
  { id: "array", name: "List of objects" },
  { id: "string-array", name: "List of strings" },
];

/** Type choices for sub-fields (one nesting level — no groups inside groups). */
const SUB_FIELD_TYPES: Array<{ id: FormSubField["type"]; name: string }> = [
  { id: "string", name: "Text" },
  { id: "number", name: "Number" },
  { id: "boolean", name: "Boolean" },
];

/** True for plain JSON objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Group field types carry sub-fields; the rest are leaves. */
function isGroupType(type: FormField["type"]): boolean {
  return type === "object" || type === "array";
}

/** The house icon for a field/sub-field type — a compact glyph that makes a
 *  dense row scannable at a glance (the select still spells the type out). */
function TypeIcon({ type }: { type: FormField["type"] | FormSubField["type"] }) {
  switch (type) {
    case "number":
      return <SlidersHorizontal size={14} />;
    case "boolean":
      return <Check size={14} />;
    case "object":
      return <Layers size={14} />;
    case "array":
    case "string-array":
      return <List size={14} />;
    default:
      return <Tag size={14} />;
  }
}

/** Stable identity for "no schema", so the debounce keyed on it never churns. */
const EMPTY_SCHEMA: Record<string, unknown> = {};

/** A read-only value mirroring `source` with a delay (preview throttling). */
function useDebounced<T>(source: T, ms = 300): T {
  const [value, setValue] = useState(source);
  useEffect(() => {
    const timer = window.setTimeout(() => setValue(() => source), ms);
    return () => window.clearTimeout(timer);
  }, [source, ms]);
  return value;
}

/**
 * Wraps one reordered row in its entrance animation. Motion's `Reorder.Item`
 * already animates the *other* rows out of the way as a row is added/removed;
 * this adds the incoming row's own reveal, delayed by position so a fresh
 * preset's rows cascade instead of landing as one block. Under reduced motion
 * the row simply appears.
 */
function RowReveal(props: { index: number; children: ReactNode }) {
  const app = useAppMotion();
  const delay = app.reduce ? 0 : Math.min(props.index, 8) * 0.03;
  return (
    <motion.div
      initial={app.reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={app.reduce ? INSTANT : { ...app.transition, delay }}
    >
      {props.children}
    </motion.div>
  );
}

/** One sub-field row's content (the ReorderableList supplies grip + buttons). */
function SubFieldRow(props: {
  sub: FormSubField;
  onPatch: (patch: Partial<FormSubField>) => void;
  onRemove: () => void;
}) {
  const label = props.sub.name === "" ? "(unnamed)" : props.sub.name;
  return (
    <div className="tracker-subfield">
      <div className="tracker-field-head">
        <span className="tracker-type-badge" data-type={props.sub.type} aria-hidden="true">
          <TypeIcon type={props.sub.type} />
        </span>
        <input
          className="input tracker-field-name"
          type="text"
          placeholder="Name"
          aria-label="Sub-field name"
          value={props.sub.name}
          onChange={(event) => props.onPatch({ name: event.currentTarget.value })}
        />
        <select
          className="select tracker-field-type"
          aria-label="Sub-field type"
          value={props.sub.type}
          onChange={(event) =>
            props.onPatch({ type: event.currentTarget.value as FormSubField["type"] })
          }
        >
          {SUB_FIELD_TYPES.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
        <label className="tracker-field-required">
          <span className="switch">
            <input
              type="checkbox"
              className="switch-input"
              checked={props.sub.required}
              onChange={(event) => props.onPatch({ required: event.currentTarget.checked })}
            />
            <span className="switch-track">
              <span className="switch-thumb" />
            </span>
          </span>
          <span className="tracker-field-required-text">Required</span>
        </label>
        <button
          type="button"
          className="btn btn-icon"
          aria-label={`Remove sub-field ${label}`}
          onClick={() => props.onRemove()}
        >
          <X size={14} />
        </button>
      </div>
      <input
        className="input tracker-field-desc"
        type="text"
        placeholder="Description (optional)"
        aria-label="Sub-field description"
        value={props.sub.description}
        onChange={(event) => props.onPatch({ description: event.currentTarget.value })}
      />
    </div>
  );
}

/**
 * One top-level field's content: type badge + name/type/required/remove head,
 * description, and (for group types) the foldable sub-field list — itself a
 * `ReorderableList`, so both levels reorder identically.
 */
function FieldRow(props: {
  field: FormField;
  groupOpen: boolean;
  onToggleGroup: () => void;
  onPatch: (patch: Partial<Omit<FormField, "children">>) => void;
  onRemove: () => void;
  onReorderChildren: (ids: string[]) => void;
  onAddChild: () => void;
  onPatchChild: (childIndex: number, patch: Partial<FormSubField>) => void;
  onRemoveChild: (childIndex: number) => void;
}) {
  const label = props.field.name === "" ? "(unnamed)" : props.field.name;
  const group = isGroupType(props.field.type);
  // Stable id linking the group toggle to its disclosed panel (a11y).
  const panelId =
    props.field.id !== undefined ? `tracker-group-panel-${props.field.id}` : undefined;
  return (
    <div className="tracker-field">
      <div className="tracker-field-head">
        <span className="tracker-type-badge" data-type={props.field.type} aria-hidden="true">
          <TypeIcon type={props.field.type} />
        </span>
        <input
          className="input tracker-field-name"
          type="text"
          placeholder="Field name"
          aria-label="Field name"
          value={props.field.name}
          onChange={(event) => props.onPatch({ name: event.currentTarget.value })}
        />
        <select
          className="select tracker-field-type"
          aria-label="Field type"
          value={props.field.type}
          onChange={(event) =>
            props.onPatch({ type: event.currentTarget.value as FormField["type"] })
          }
        >
          {FIELD_TYPES.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
        <label className="tracker-field-required">
          <span className="switch">
            <input
              type="checkbox"
              className="switch-input"
              checked={props.field.required}
              onChange={(event) => props.onPatch({ required: event.currentTarget.checked })}
            />
            <span className="switch-track">
              <span className="switch-thumb" />
            </span>
          </span>
          <span className="tracker-field-required-text">Required</span>
        </label>
        <button
          type="button"
          className="btn btn-icon"
          aria-label={`Remove field ${label}`}
          onClick={() => props.onRemove()}
        >
          <X size={14} />
        </button>
      </div>
      <input
        className="input tracker-field-desc"
        type="text"
        placeholder="Description (optional)"
        aria-label="Field description"
        value={props.field.description}
        onChange={(event) => props.onPatch({ description: event.currentTarget.value })}
      />

      {group && (
        <div className="tracker-group">
          <button
            type="button"
            className="tracker-group-toggle"
            aria-expanded={props.groupOpen}
            aria-controls={panelId}
            onClick={() => props.onToggleGroup()}
          >
            {props.groupOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            <span>{props.field.type === "object" ? "Fields" : "Item fields"}</span>
            <span className="tracker-group-count tnum">{props.field.children.length}</span>
          </button>
          <Collapsible open={props.groupOpen} id={panelId}>
            <div className="tracker-subfields-inner">
              {props.field.children.length === 0 ? (
                <p className="caption muted tracker-subfields-empty">No fields yet.</p>
              ) : (
                <ReorderableList
                  items={rowIds(props.field.children)}
                  getKey={(id) => id}
                  onReorder={props.onReorderChildren}
                  ariaLabel={`Sub-fields of ${label}`}
                  className="tracker-subfields-list"
                >
                  {(_id, index) => {
                    const sub = props.field.children[index];
                    if (sub === undefined) {
                      return null;
                    }
                    return (
                      <RowReveal index={index}>
                        <SubFieldRow
                          sub={sub}
                          onPatch={(patch) => props.onPatchChild(index, patch)}
                          onRemove={() => props.onRemoveChild(index)}
                        />
                      </RowReveal>
                    );
                  }}
                </ReorderableList>
              )}
              <button
                type="button"
                className="btn tracker-add-subfield"
                onClick={() => props.onAddChild()}
              >
                <Plus size={14} />
                Add field
              </button>
            </div>
          </Collapsible>
        </div>
      )}
    </div>
  );
}

/**
 * The multi-request split block: a request stepper plus, when split, one
 * assignment row per top-level field and a grouped preview.
 *
 * All of the resolution logic stays in the caller (`normalizeParts`,
 * `effectivePartCount`, `groupFieldsByPart`); this component only presents the
 * numbers it is handed, so the "empty requests are skipped and the survivors
 * re-numbered" truth stays exactly as before.
 */
function GenerationParts(props: {
  fieldNames: string[];
  parts: TrackerPartsConfig;
  count: number;
  maxCount: number;
  effectiveCount: number;
  preview: Array<{ configured: number; fields: string[]; effective: number | null }>;
  onEditParts: (next: TrackerPartsConfig) => void;
}) {
  const app = useAppMotion();
  const setCount = (next: number): void => {
    props.onEditParts({ count: next, fields: props.parts.fields });
  };

  return (
    <section className="tracker-parts">
      <div className="tracker-parts-head">
        <div className="tracker-parts-title">
          <h4 className="tracker-pane-title">Generation requests</h4>
          <span className="set-row-hint">
            {props.count === 1
              ? "One request generates every field."
              : props.effectiveCount === 1
                ? "Only one request has fields — the rest are skipped."
                : `${props.effectiveCount} requests run in parallel.`}
          </span>
        </div>
        <NumberStepper
          className="set-stepper"
          label="Requests"
          value={props.count}
          min={1}
          max={props.maxCount}
          onChange={setCount}
        />
      </div>

      {props.fieldNames.length === 0 ? (
        <p className="caption muted">
          This schema has no top-level fields to split — splitting needs a plain object schema with
          properties.
        </p>
      ) : (
        <Presence>
          {props.count > 1 && (
            <motion.div
              key="assign"
              className="tracker-parts-body"
              variants={fadeVariants(app)}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <Stagger>
                {props.fieldNames.map((name) => (
                  <StaggerItem key={name}>
                    <div className="row tracker-part-field">
                      <span className="tracker-part-field-name">{name}</span>
                      <select
                        className="select tracker-part-select"
                        aria-label={`Request for field ${name}`}
                        value={String(props.parts.fields[name] ?? 1)}
                        onChange={(event) =>
                          props.onEditParts({
                            count: props.count,
                            fields: {
                              ...props.parts.fields,
                              [name]: Number(event.currentTarget.value),
                            },
                          })
                        }
                      >
                        {Array.from({ length: props.count }, (_, i) => i + 1).map((part) => (
                          <option key={part} value={String(part)}>
                            Request {part}
                          </option>
                        ))}
                      </select>
                    </div>
                  </StaggerItem>
                ))}
              </Stagger>

              <div className="stack tracker-parts-preview">
                {props.preview.map((group) => (
                  <div
                    className={cx(
                      "row tracker-part-group",
                      group.fields.length === 0 && "is-empty",
                    )}
                    key={group.configured}
                  >
                    <span className="tracker-part-group-label">Request {group.configured}:</span>
                    {group.fields.length > 0 ? (
                      <>
                        {/* Empty configured requests are dropped and survivors
                            re-numbered, so show the part the prompt will
                            actually call it. */}
                        {group.effective !== group.configured && (
                          <span className="muted">
                            becomes part {group.effective} of {props.effectiveCount} ·
                          </span>
                        )}
                        <span className="tracker-part-group-fields">{group.fields.join(", ")}</span>
                      </>
                    ) : (
                      <span className="muted">no fields — this request is skipped</span>
                    )}
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </Presence>
      )}

      <span className="field-hint">
        Split a large schema across parallel requests so each one stays accurate. Assign each field
        to a request; a request with no fields is skipped.
      </span>
    </section>
  );
}

/**
 * The schema-preset editor: a compact card in Settings → Tracker (active
 * preset, a shape summary, and the "Visual editor" button) that opens the
 * full editor in a big modal — a preset rail, the schema (form builder or raw
 * JSON), the HTML/CSS templates, and a live preview rendered from a sample of
 * the edited schema.
 */
export default function SchemaPresetsCard(props: {
  presets: Record<string, TrackerSchemaPreset>;
  activeKey: string;
  onEdit: (patch: Partial<TrackerConfig>) => void;
  onIssues: (issues: string | null) => void;
}) {
  const app = useAppMotion();
  const { confirm, dialog } = useConfirmDialog();

  // --- editor state ---
  const [mode, setMode] = useState<"form" | "raw">("form");
  /** The raw editor's live text (only meaningful while mode is "raw"). */
  const [rawText, setRawText] = useState("");
  /** Parse failure of the raw text; blocks saving and mode/preset switches. */
  const [rawError, setRawError] = useState<string | null>(null);
  /**
   * The form model. Derived from the preset's schema, but kept as state so
   * blank/in-progress rows survive their own commits (formToSchema skips
   * blank names — a purely derived form would drop the row being typed).
   */
  const [formState, setFormState] = useState<SchemaForm | null>(null);
  /** Synchronous mirror of `formState`: React state is not readable right
   *  after a setter returns, but `withForm` and the reseed effect both must. */
  const formStateRef = useRef<SchemaForm | null>(null);
  const setForm = useCallback((next: SchemaForm | null): void => {
    formStateRef.current = next;
    setFormState(next);
  }, []);

  /** Groups the user folded shut, by row id. Everything starts open. */
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(new Set());

  // --- modal ---
  /** The visual editor modal; the state below outlives it, so closing the
   *  modal keeps unsaved-to-server edits (and blocking issues) in place. */
  const [editorOpen, setEditorOpen] = useState(false);

  /** Preset keys in stored order; the edited preset is the active one. */
  const keys = (): string[] => Object.keys(props.presets);
  /** The preset being edited: the active key when it exists, else the first. */
  const selectedKey = (): string | null => {
    const list = keys();
    return list.includes(props.activeKey) ? props.activeKey : (list[0] ?? null);
  };
  const selectedPreset = (): TrackerSchemaPreset | undefined => {
    const key = selectedKey();
    return key !== null ? props.presets[key] : undefined;
  };

  // The form model is reseeded from the edited preset's schema ONLY when
  // that schema object's identity changes from the outside — a preset
  // switch, a config (re)load, or a raw-mode JSON commit. Form edits
  // update the form state directly (see withForm) and mark their commit
  // so it is never mistaken for an external change; in particular, blank
  // in-progress rows survive their own commits (formToSchema skips blank
  // names, so the committed schema cannot carry them).
  const lastFormCommit = useRef<Record<string, unknown> | null>(null);
  const selectedSchema = selectedPreset()?.schema ?? null;

  useEffect(() => {
    if (selectedSchema === null) {
      lastFormCommit.current = null;
      if (formStateRef.current !== null) {
        setForm(null);
      }
      return;
    }
    if (selectedSchema === lastFormCommit.current) {
      return; // our own form commit — the form already holds the edit
    }
    // Content-equal schema under a new identity (a save that
    // re-normalized the config, a cosmetic raw-mode edit): the form is
    // still in sync, so keep it — and its in-progress blank rows.
    const current = formStateRef.current;
    if (current !== null && schemasEqual(formToSchema(current), selectedSchema)) {
      return;
    }
    lastFormCommit.current = null;
    // Fresh rows get fresh ids; fold state keyed on the old ids is dropped.
    // An advanced schema has no form model — raw JSON is its editor.
    const parsed = schemaToForm(selectedSchema);
    setClosedGroups(new Set());
    setForm(parsed === null ? null : ensureRowIds(parsed));
  }, [selectedSchema, setForm]);

  /** Blocking editor issues, reported to the panel's Save button. */
  const editorIssues = useCallback((): string | null => {
    if (mode === "raw") {
      return rawError;
    }
    if (formState === null) {
      return null; // advanced schema: raw JSON is the way out, not an error
    }
    const issues = formIssues(formState);
    return issues.length > 0 ? issues.join(" ") : null;
  }, [mode, rawError, formState]);

  useEffect(() => {
    props.onIssues(editorIssues());
  }, [editorIssues, props.onIssues]);

  // --- live preview (debounced) ---

  const previewHtml = useDebounced(selectedPreset()?.html ?? "");
  const previewCss = useDebounced(selectedPreset()?.css ?? "");
  const previewSchema = useDebounced(selectedPreset()?.schema ?? EMPTY_SCHEMA);

  // --- commits into the panel's config ---

  const commitSchema = (schema: Record<string, unknown>): void => {
    const key = selectedKey();
    const preset = key !== null ? props.presets[key] : undefined;
    if (key === null || preset === undefined) {
      return;
    }
    // Re-normalize the split against the new schema: form edits and raw JSON
    // can add/remove/rename fields, which must never leave assignments
    // pointing at a field that no longer exists.
    props.onEdit({
      schema_presets: {
        ...props.presets,
        [key]: { ...preset, schema, parts: normalizeParts(preset.parts, presetFieldNames(schema)) },
      },
    });
  };

  /** Applies a form edit: the form state is the edit state, the schema
   *  commit mirrors it (blank rows included in the form, skipped in the
   *  rebuilt schema) so the sync effect above never reseeds on it. */
  const withForm = (apply: (form: SchemaForm) => SchemaForm): void => {
    const current = formStateRef.current;
    if (current === null) {
      return;
    }
    // Stamp ids on any row an edit just created, then keep the whole model
    // as the edit state so blank in-progress rows survive.
    const next = ensureRowIds(apply(current));
    setForm(next);
    const committed = formToSchema(next);
    lastFormCommit.current = committed;
    commitSchema(committed);
  };

  const editPreset = (patch: Partial<TrackerSchemaPreset>): void => {
    const key = selectedKey();
    const preset = key !== null ? props.presets[key] : undefined;
    if (key === null || preset === undefined) {
      return;
    }
    props.onEdit({ schema_presets: { ...props.presets, [key]: { ...preset, ...patch } } });
  };

  /** Commits a split edit, normalized against the preset's CURRENT schema so
   *  the count/indices stay legal if the schema changed since it was stored. */
  const editParts = (next: TrackerPartsConfig): void => {
    const preset = selectedPreset();
    if (preset === undefined) {
      return;
    }
    editPreset({
      parts: normalizeParts(next, presetFieldNames(preset.schema)),
    });
  };

  /** Replaces the HTML template with one generated from the current
   *  schema. Works in either mode: the committed schema (which form edits
   *  and valid raw edits keep up to date) is the source either way. */
  const regenerateHtml = (): void => {
    const preset = selectedPreset();
    if (preset === undefined) {
      return;
    }
    editPreset({ html: generateTemplateFromSchema(preset.schema) });
  };

  // --- raw mode ---

  const enterRaw = (): void => {
    if (rawError !== null) {
      return;
    }
    setRawText(JSON.stringify(selectedPreset()?.schema ?? {}, null, 2));
    setMode("raw");
  };

  const enterForm = (): void => {
    // Blocked while the raw text does not parse — the form needs a schema.
    if (rawError !== null) {
      return;
    }
    setMode("form");
  };

  /** Live validation: every keystroke parses; a valid parse commits the
   *  schema immediately (the preview and Save see the latest good value). */
  const editRaw = (text: string): void => {
    setRawText(text);
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) {
        throw new Error("The schema must be a JSON object.");
      }
      setRawError(null);
      commitSchema(parsed);
    } catch (err) {
      setRawError(err instanceof Error ? err.message : "Invalid JSON");
    }
  };

  /** Pretty-print the current text. Only reachable while it parses, so the
   *  re-commit is whitespace-only and cannot change the schema. */
  const formatRaw = (): void => {
    if (rawError !== null) {
      return;
    }
    try {
      editRaw(JSON.stringify(JSON.parse(rawText), null, 2));
    } catch {
      // Unreachable while rawError is null; a no-op keeps the action safe.
    }
  };

  // --- preset management ---

  /** Creates a preset, or returns the message explaining why it cannot be. */
  const createPreset = (key: string, name: string): string | null => {
    if (!TRACKER_PRESET_KEY_RE.test(key)) {
      return "Key must be lowercase kebab-case (a-z, 0-9, hyphens).";
    }
    if (key in props.presets) {
      return `A preset with key "${key}" already exists.`;
    }
    props.onEdit({
      schema_presets: {
        ...props.presets,
        [key]: {
          name,
          schema: {},
          html: "",
          css: "",
          parts: { count: 1, fields: {} },
        },
      },
      active_schema_key: key,
    });
    return null;
  };

  const renameSelected = (name: string): void => {
    editPreset({ name });
  };

  const selectPreset = (key: string): void => {
    if (rawError !== null) {
      return;
    }
    props.onEdit({ active_schema_key: key });
    // The raw editor follows the newly selected preset.
    if (mode === "raw") {
      setRawText(JSON.stringify(props.presets[key]?.schema ?? {}, null, 2));
    }
  };

  const removePreset = (): void => {
    const key = selectedKey();
    const preset = key !== null ? props.presets[key] : undefined;
    if (key === null || preset === undefined) {
      return;
    }
    const label = preset.name === "" ? key : preset.name;
    const wasActive = key === props.activeKey;
    confirm({
      title: "Delete schema preset?",
      description: (
        <>
          <strong>{label}</strong> will be removed.
          {wasActive ? " The first remaining preset becomes active." : ""}
        </>
      ),
      confirmLabel: "Delete preset",
      tone: "danger",
      onConfirm: () => {
        const remaining: Record<string, TrackerSchemaPreset> = { ...props.presets };
        delete remaining[key];
        props.onEdit({
          schema_presets: remaining,
          // Deleting the active preset switches to the first remaining one
          // ("" once none are left — the seed button brings the default back).
          active_schema_key: wasActive
            ? (keys().filter((k) => k !== key)[0] ?? "")
            : props.activeKey,
        });
      },
    });
  };

  const seedDefault = (): void => {
    // Deep copy: the module constants must never share objects with the
    // panel's (and the saved) config.
    props.onEdit({
      schema_presets: structuredClone(DEFAULT_TRACKER_SCHEMA_PRESETS),
      active_schema_key: "default",
    });
  };

  // Memoized on the debounced schema: `schemaSample` is pure, so this keeps a
  // stable identity across the keystrokes in the HTML/CSS textareas (which
  // share the debounce but not the schema) and avoids re-sampling per render.
  // Normalized exactly like the live chat card (capitalizeSnapshot), so the
  // author sees the same casing a template that reads a value structurally
  // (e.g. class="status-{{status}}") will actually render.
  const previewData = useMemo(() => {
    try {
      return capitalizeSnapshot(schemaSample(previewSchema) as Record<string, unknown>);
    } catch {
      return {};
    }
  }, [previewSchema]);

  /** renderTemplate pre-check: a syntax error surfaces under the preview
   *  instead of throwing inside TemplateFrame's render. */
  const previewError = (): string | null => {
    try {
      renderTemplate(previewHtml, previewData);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Template error";
    }
  };

  const fields = (): FormField[] => formState?.fields ?? [];
  const fieldIssues = (field: FormField): boolean =>
    field.name === "" ||
    (formState?.fields ?? []).some((other) => other !== field && other.name === field.name);

  /** Display name of the preset the editor would edit (key when unnamed). */
  const presetLabel = (): string => {
    const preset = selectedPreset();
    if (preset === undefined) {
      return "";
    }
    return preset.name !== "" ? preset.name : (selectedKey() ?? "");
  };

  /** One-line shape summary of the edited preset's schema. */
  const summary = (): string => {
    const preset = selectedPreset();
    if (preset === undefined) {
      return "";
    }
    const parsed = schemaToForm(preset.schema);
    if (parsed === null) {
      return "Advanced schema — edit it as raw JSON";
    }
    const count = parsed.fields.length;
    const parts = [`${count} ${count === 1 ? "field" : "fields"}`];
    const required = parsed.fields.filter((field) => field.required).length;
    if (required > 0) {
      parts.push(`${required} required`);
    }
    const groups = parsed.fields.filter((field) => field.children.length > 0).length;
    if (groups > 0) {
      parts.push(`${groups} ${groups === 1 ? "group" : "groups"}`);
    }
    if (preset.parts.count > 1) {
      parts.push(`${preset.parts.count} requests`);
    }
    return parts.join(" · ");
  };

  // --- multi-request split ("Generation requests") ---

  /** The edited preset's splittable top-level fields ([] = unsplittable). */
  const fieldNames = (): string[] => presetFieldNames(selectedPreset()?.schema ?? {});
  const parts = (): TrackerPartsConfig => selectedPreset()?.parts ?? { count: 1, fields: {} };
  const count = (): number => parts().count;
  /** The largest legal request count: never more requests than fields. */
  const maxCount = (): number => Math.max(1, Math.min(fieldNames().length, MAX_TRACKER_PARTS));
  /**
   * The requests the generation will ACTUALLY run: empty groups are dropped
   * and survivors re-numbered by core, so `count` can exceed this. Used for
   * the stepper hint and the preview's effective-part notes.
   */
  const effectiveCount = (): number => effectivePartCount(fieldNames(), parts());

  /**
   * Preview rows for every CONFIGURED request: its configured number, its
   * fields, and the effective part it becomes among the non-empty groups
   * (null for an empty group). Keeps the configured numbering visible while
   * telling the truth about what the prompt headers will say.
   */
  const partPreview = (): Array<{
    configured: number;
    fields: string[];
    effective: number | null;
  }> => {
    let effective = 0;
    return groupFieldsByPart(fieldNames(), parts()).map((group) => {
      if (group.fields.length === 0) {
        return { configured: group.part, fields: group.fields, effective: null };
      }
      effective += 1;
      return { configured: group.part, fields: group.fields, effective };
    });
  };

  // --- reordering (Motion Reorder → the form ops' single move) ---

  /** The row ids of the current top-level fields, in order. */
  const fieldRowIds = (): string[] => rowIds(fields());

  /** Reorder from a full permutation back into moveField's one-row move. */
  const reorderFields = (ids: string[]): void => {
    const move = singleMove(fieldRowIds(), ids);
    if (move !== null) {
      withForm((current) => moveField(current, move.from, move.to));
    }
  };

  /** Same for a group's sub-fields, scoped to that group's index. */
  const reorderChildren = (fieldIndex: number, ids: string[]): void => {
    const form = formStateRef.current;
    const field = form?.fields[fieldIndex];
    if (form === null || field === undefined) {
      return;
    }
    const move = singleMove(rowIds(field.children), ids);
    if (move !== null) {
      withForm((current) => moveSubField(current, fieldIndex, move.from, move.to));
    }
  };

  const toggleGroup = (id: string): void => {
    setClosedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const activeKeyMissing = (): boolean => keys().length > 0 && !(props.activeKey in props.presets);

  /** Opens/closes the modal. Closing keeps every edit in the config signal. */
  const openEditor = (): void => setEditorOpen(true);
  const closeEditor = (): void => setEditorOpen(false);

  const editorIssue = editorIssues();
  const previewErr = previewError();
  const formIssueList = formState !== null ? formIssues(formState) : [];

  return (
    <div className="stack">
      {selectedPreset() !== undefined ? (
        <>
          {/* The compact launcher — the editor itself lives behind the button. */}
          <div className="row tracker-editor-launch">
            <span className="tracker-editor-launch-main">
              <span className="tracker-editor-launch-name">{presetLabel()}</span>
              <span className="tracker-editor-launch-summary">{summary()}</span>
            </span>
            <button type="button" className="btn btn-primary" onClick={() => openEditor()}>
              <SquarePen size={14} />
              Visual editor
            </button>
          </div>

          {/* Blocking issues stay visible on the launcher — the panel's Save
              waits for them even with the editor closed. */}
          {editorIssue !== null && (
            <p className="field-error" role="alert">
              {editorIssue} — open the visual editor to resolve.
            </p>
          )}

          {activeKeyMissing() && (
            <p className="field-error" role="alert">
              The active preset "{props.activeKey}" no longer exists — open the visual editor and
              pick a preset to save.
            </p>
          )}

          {/* The full editor. All state (mode, raw text, in-progress form
              rows) lives in this component, so closing the modal keeps
              unsaved-to-server edits in the config signal exactly as the
              old inline editor did. */}
          {editorOpen && (
            <Modal title="Schema preset editor" xl onClose={() => closeEditor()}>
              <div className="tracker-editor-shell">
                <PresetRail
                  presets={props.presets}
                  selectedKey={selectedKey()}
                  activeKey={props.activeKey}
                  disabled={rawError !== null}
                  onCreate={createPreset}
                  onRename={renameSelected}
                  onDelete={removePreset}
                  onSelect={selectPreset}
                />

                <div className="tracker-main">
                  <div className="tracker-pane-head">
                    <div className="tracker-pane-title-block">
                      <h4 className="tracker-pane-title">{presetLabel()}</h4>
                      <span className="tracker-pane-summary">{summary()}</span>
                    </div>
                    <div className="row tracker-mode-row">
                      <Segmented
                        ariaLabel="Schema editor mode"
                        options={[
                          { value: "form", label: "Form", disabled: rawError !== null },
                          { value: "raw", label: "Raw JSON" },
                        ]}
                        value={mode}
                        onChange={(next) => {
                          if (next === "raw") {
                            enterRaw();
                          } else {
                            enterForm();
                          }
                        }}
                      />
                      <span
                        className={cx(
                          "badge",
                          editorIssue === null ? "badge-success" : "badge-danger",
                        )}
                      >
                        {editorIssue === null ? (
                          <>
                            <Check size={12} /> Valid
                          </>
                        ) : (
                          <>
                            <TriangleAlert size={12} /> Issues
                          </>
                        )}
                      </span>
                    </div>
                  </div>

                  {/* An externally-rewritten active key (or one left pointing at a
                      deleted preset): explicit here, and the panel's Save also waits
                      until a real preset is picked. */}
                  {activeKeyMissing() && (
                    <p className="field-error" role="alert">
                      The active preset "{props.activeKey}" no longer exists — pick a preset to
                      save.
                    </p>
                  )}

                  {/* Inline validation: the same issues the Save gate sees, so a
                      blocked save always points at the offending row. */}
                  {formIssueList.length > 0 && (
                    <ul className="tracker-issues" aria-live="polite">
                      {formIssueList.map((issue, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: two groups can emit byte-identical issue strings, so the position is the only unique key.
                        <li className="field-error" key={`${index}-${issue}`}>
                          {issue}
                        </li>
                      ))}
                    </ul>
                  )}

                  <GenerationParts
                    fieldNames={fieldNames()}
                    parts={parts()}
                    count={count()}
                    maxCount={maxCount()}
                    effectiveCount={effectiveCount()}
                    preview={partPreview()}
                    onEditParts={editParts}
                  />

                  <Presence mode="wait">
                    {mode === "form" ? (
                      <motion.div
                        key="form"
                        className="tracker-form-pane"
                        variants={fadeVariants(app)}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                      >
                        {formState === null && (
                          <p className="tracker-advanced-note">
                            This schema uses advanced features — switch to Raw JSON to edit.
                          </p>
                        )}
                        <fieldset
                          className="tracker-fields tracker-form"
                          disabled={formState === null}
                        >
                          {formState !== null && (
                            <>
                              <div className="row">
                                <label className="field tracker-meta-title">
                                  <span className="field-label">Title</span>
                                  <input
                                    className="input"
                                    type="text"
                                    placeholder="Schema title (optional)"
                                    value={formState.title}
                                    onChange={(event) =>
                                      withForm((current) => ({
                                        ...current,
                                        title: event.currentTarget.value,
                                      }))
                                    }
                                  />
                                </label>
                                <label className="field tracker-meta-desc">
                                  <span className="field-label">Description</span>
                                  <input
                                    className="input"
                                    type="text"
                                    placeholder="What this schema tracks (optional)"
                                    value={formState.description}
                                    onChange={(event) =>
                                      withForm((current) => ({
                                        ...current,
                                        description: event.currentTarget.value,
                                      }))
                                    }
                                  />
                                </label>
                              </div>

                              <ReorderableList
                                items={fieldRowIds()}
                                getKey={(id) => id}
                                onReorder={(ids) => reorderFields(ids)}
                                ariaLabel="Schema fields"
                                className="tracker-fields-list"
                              >
                                {(_id, index) => {
                                  const field = fields()[index];
                                  if (field === undefined) {
                                    return null;
                                  }
                                  const id = field.id ?? "";
                                  return (
                                    <RowReveal index={index}>
                                      <div
                                        className={cx(
                                          "tracker-field-wrap",
                                          fieldIssues(field) && "is-invalid",
                                        )}
                                      >
                                        <FieldRow
                                          field={field}
                                          groupOpen={!closedGroups.has(id)}
                                          onToggleGroup={() => toggleGroup(id)}
                                          onPatch={(patch) =>
                                            withForm((current) =>
                                              updateField(current, index, patch),
                                            )
                                          }
                                          onRemove={() =>
                                            withForm((current) => removeField(current, index))
                                          }
                                          onReorderChildren={(ids) => reorderChildren(index, ids)}
                                          onAddChild={() =>
                                            withForm((current) => addChild(current, index))
                                          }
                                          onPatchChild={(childIndex, patch) =>
                                            withForm((current) =>
                                              updateChild(current, index, childIndex, patch),
                                            )
                                          }
                                          onRemoveChild={(childIndex) =>
                                            withForm((current) =>
                                              removeChild(current, index, childIndex),
                                            )
                                          }
                                        />
                                      </div>
                                    </RowReveal>
                                  );
                                }}
                              </ReorderableList>

                              <Presence>
                                {fields().length === 0 && (
                                  <motion.p
                                    key="empty"
                                    className="caption muted tracker-fields-empty"
                                    variants={fadeVariants(app)}
                                    initial="hidden"
                                    animate="visible"
                                    exit="exit"
                                  >
                                    No fields yet — add one to describe what the model tracks.
                                  </motion.p>
                                )}
                              </Presence>

                              <button
                                type="button"
                                className="btn tracker-add-field"
                                onClick={() => withForm((current) => addField(current))}
                              >
                                <Plus size={14} />
                                Add field
                              </button>
                            </>
                          )}
                        </fieldset>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="raw"
                        className="tracker-raw"
                        variants={fadeVariants(app)}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                      >
                        <div className="tracker-raw-toolbar">
                          <span className="field-label">
                            <FileJson size={14} /> Schema (JSON)
                          </span>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={rawError !== null}
                            onClick={() => formatRaw()}
                          >
                            <Sparkles size={12} />
                            Format
                          </button>
                        </div>
                        <JsonEditor
                          id="tracker-raw-schema"
                          value={rawText}
                          onChange={editRaw}
                          error={rawError}
                          ariaLabel="Schema JSON"
                        />
                        <div
                          className={cx(
                            "tracker-json-status",
                            rawError !== null ? "is-invalid" : "is-valid",
                          )}
                          role={rawError !== null ? "alert" : undefined}
                        >
                          {rawError !== null ? (
                            <>
                              <TriangleAlert size={14} />
                              <span>{rawError}</span>
                            </>
                          ) : (
                            <>
                              <Check size={14} />
                              <span className="tnum">
                                Valid JSON · {rawText.split("\n").length} lines
                              </span>
                            </>
                          )}
                        </div>
                        <span className="field-hint">
                          Must parse to a plain JSON object — saving and the form view stay blocked
                          until it does.
                        </span>
                      </motion.div>
                    )}
                  </Presence>
                </div>

                {/* The output side: templates + the live preview. */}
                <TemplatePane
                  html={selectedPreset()?.html ?? ""}
                  css={selectedPreset()?.css ?? ""}
                  onHtml={(value) => editPreset({ html: value })}
                  onCss={(value) => editPreset({ css: value })}
                  onRegenerate={regenerateHtml}
                  previewHtml={previewHtml}
                  previewCss={previewCss}
                  previewData={previewData}
                  previewError={previewErr}
                />
              </div>

              {/* Editing commits straight into the panel's config; the panel's
                  own Save is what persists it. Say so, so closing the modal
                  isn't mistaken for discarding. */}
              <p className="caption muted tracker-editor-note">
                Edits apply to the tracker settings immediately — press “Save” to persist them.
              </p>
            </Modal>
          )}
        </>
      ) : (
        <div className="empty-state">
          <span className="empty-state-icon" aria-hidden="true">
            <FileJson size={18} />
          </span>
          <p className="empty-state-hint">
            No schema presets yet — the tracker needs at least one to generate snapshots.
          </p>
          <button type="button" className="btn" onClick={() => seedDefault()}>
            <Plus size={14} />
            Create the default preset
          </button>
        </div>
      )}
      {dialog}
    </div>
  );
}
