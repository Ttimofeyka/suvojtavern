/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue } from "jotai";
import { motion } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import MobileNavButton from "../components/MobileNavButton";
import ImportPreset from "../components/presets/ImportPreset";
import PresetEditor from "../components/presets/PresetEditor";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import {
  Check,
  ChevronDown,
  Download,
  Info,
  Pencil,
  Plus,
  SlidersHorizontal,
  Star,
  Trash2,
  TriangleAlert,
  Upload,
} from "../components/ui/icons";
import { StaggerItem } from "../components/ui/stagger";
import { getSettings, putSettings } from "../lib/api";
import type { ControlOption, Preset, PresetControl } from "../lib/api-presets";
import { deletePreset, exportPresetUrl, listPresets, putPresetControls } from "../lib/api-presets";
import { cx } from "../lib/cx";
import { scaleVariants, staggerContainer, useAppMotion } from "../lib/motion";
import { resolveChoices, settingsControls } from "../lib/preset-controls";
import { mergeRowsById } from "../lib/row-merge";
import { appStore } from "../stores/store";

/**
 * What a preset is, in one tooltip; also the accessible text for the info
 * button beside the page title. Explains the two facts a newcomer cannot see
 * from the list: presets shape every generation, and the starred one is what
 * new chats start from.
 */
const PRESETS_TIP =
  "A preset is the prompt pipeline every generation uses — the ordered list of instructions and data the model reads. Star one to make it the default new chats start from.";

// Module scope — the router unmounts this view on every navigation, which
// would otherwise drop the fetched list and replay the skeleton on each
// revisit. These Jotai atoms live in the shared module store, so they survive
// the unmount: a revisit renders instantly from cache while a background
// refresh revalidates (stale-while-revalidate). The list is reconciled by id,
// not swapped wholesale: `listPresets()` returns fresh row objects, and
// replacing the array would make every card a new element (replaying its
// entrance animation and dropping the `<select>`'s focus) even though only one
// row may have moved. Both write paths therefore go through `mergeRowsById`
// from lib/row-merge, the shared id-keyed reconciler: it diffs by id AND content
// and reuses each unchanged row's object instance, returning the previous
// array itself when nothing changed.
const presetsAtom = atom<Preset[]>([]);
// True only after a *successful* fetch — a failed first load leaves it false
// so the next mount retries the full skeleton flow instead of trusting
// nothing as cache.
const presetsLoadedAtom = atom(false);
// The preset new chats start from, persisted server-side. Cached
// module-level so the "Default" badge doesn't flash in late on revisits;
// settings are still re-fetched silently on every mount.
const defaultIdAtom = atom<string | null>(null);
// Which cards have their controls block open. Module-level like `presets`:
// `refresh()` replaces the whole list on every save/delete/import, and a
// per-card signal would be reset by that re-render. A Set is always replaced,
// never mutated, so subscribers see the change.
const controlsOpenAtom = atom<ReadonlySet<string>>(new Set<string>());

/** Static keys for the loading skeleton rows (a real array, not indexes). */
const SKELETON_ROWS = ["skeleton-1", "skeleton-2", "skeleton-3", "skeleton-4"];

/** Card caption: how many prompts the pipeline has and how many are on. */
const promptCaption = (preset: Preset): string => {
  const enabled = preset.prompts.filter((prompt) => prompt.enabled).length;
  return `${preset.prompts.length} prompt${preset.prompts.length === 1 ? "" : "s"} · ${enabled} enabled`;
};

/** The label a control's option shows in the switcher — never blank. */
const optionLabel = (option: ControlOption): string =>
  option.label.trim() === "" ? option.id : option.label.trim();

/** The label a control shows in the card — never blank. */
const controlLabel = (control: PresetControl): string =>
  control.label.trim() === "" ? control.id : control.label.trim();

/**
 * Staggered container that can suppress its entrance. The shared <Stagger>
 * always animates on mount; this view renders from a module-level cache on a
 * revisit, and replaying the cascade on every navigation reads as noise. So the
 * container takes an explicit `initial` (false = render settled) and otherwise
 * reuses the same variant machinery as the shared primitive (mirrors the
 * Characters / Lorebooks / Personas lists).
 */
function ListStagger(props: {
  animate: boolean;
  className: string;
  children: ReactNode;
}): ReactElement {
  const app = useAppMotion();
  return (
    <motion.div
      className={cx("stagger", props.className)}
      variants={staggerContainer(app)}
      initial={props.animate ? "hidden" : false}
      animate="visible"
    >
      {props.children}
    </motion.div>
  );
}

interface PresetCardProps {
  preset: Preset;
  /** True when this preset is the starred default new chats start from. */
  isDefault: boolean;
  /** True when this card's controls block is expanded. */
  isOpen: boolean;
  onSetDefault: (preset: Preset) => void;
  onEdit: (preset: Preset) => void;
  onRemove: (preset: Preset) => void;
  onToggleControls: (preset: Preset) => void;
  onChooseControl: (preset: Preset, controlId: string, optionId: string) => void;
}

/**
 * One preset card. Extracted from the view so the controls/choices derivations
 * are `useMemo`s of a component that owns them: Solid declared those two
 * `createMemo`s inside the list callback, but React hooks cannot live in a
 * loop — the card is now a real component, keyed by the preset id.
 *
 * The icon + name/description block is one button that opens the editor,
 * matching the lorebook card's `.lore-main` ("click the card body to open
 * it"); the icon actions on the right stay discrete controls.
 */
function PresetCard(props: PresetCardProps) {
  const { preset } = props;
  // Re-derived per card from the cached row: these read a nested property off
  // the list row, so a memo keeps the parse off the render path AND recomputes
  // when `chooseControl` merges a new `control_values` into this row.
  const controls = useMemo(() => settingsControls(preset.settings), [preset.settings]);
  const choices = useMemo(
    () => resolveChoices(controls, preset.settings.control_values),
    [controls, preset.settings],
  );
  const bodyId = `preset-controls-${preset.id}`;

  return (
    <article className="card card-hover preset-card">
      <button type="button" className="preset-card-open" onClick={() => props.onEdit(preset)}>
        <span className="preset-icon" aria-hidden="true">
          <SlidersHorizontal size={18} />
        </span>
        <span className="preset-main">
          <span className="row persona-title-row">
            <span className="preset-name">{preset.name}</span>
            {props.isDefault && (
              <span className="badge badge-success">
                <Check size={12} />
                Default
              </span>
            )}
          </span>
          <span className="caption preset-desc">
            {preset.description.trim() === "" ? "No description" : preset.description}
          </span>
          <span className="caption preset-desc tnum">{promptCaption(preset)}</span>
        </span>
      </button>
      <div className="preset-actions">
        <button
          type="button"
          className="btn btn-icon persona-star"
          aria-pressed={props.isDefault}
          aria-label={
            props.isDefault
              ? `Clear default preset (${preset.name})`
              : `Set ${preset.name} as default preset`
          }
          data-tip={
            props.isDefault
              ? "Default — new chats start from this preset. Click to unset."
              : "Set as default — new chats will start from this preset"
          }
          onClick={() => props.onSetDefault(preset)}
        >
          <Star size={16} />
        </button>
        {/* A real download: the URL carries the attachment
            Content-Disposition, and the empty download attribute
            keeps the browser from navigating away. */}
        <a
          className="btn btn-icon"
          href={exportPresetUrl(preset.id)}
          download=""
          aria-label={`Export ${preset.name}`}
          data-tip="Export as JSON"
        >
          <Download size={16} />
        </a>
        <button
          type="button"
          className="btn btn-icon"
          aria-label={`Edit ${preset.name}`}
          data-tip="Edit"
          onClick={() => props.onEdit(preset)}
        >
          <Pencil size={16} />
        </button>
        <button
          type="button"
          className="btn btn-icon btn-danger"
          aria-label={`Delete ${preset.name}`}
          data-tip="Delete"
          onClick={() => props.onRemove(preset)}
        >
          <Trash2 size={16} />
        </button>
      </div>
      {/* Controls the preset declares. Its own wrapped row so
          expanding it grows the card downward and never
          reflows the name / caption / action row above. */}
      {controls.length > 0 && (
        <div className="preset-card-controls">
          <button
            type="button"
            className="preset-controls-toggle"
            aria-expanded={props.isOpen}
            aria-controls={bodyId}
            onClick={() => props.onToggleControls(preset)}
          >
            <span className="preset-controls-chevron" aria-hidden="true">
              <ChevronDown size={14} />
            </span>
            {controls.length} control{controls.length === 1 ? "" : "s"}
          </button>
          {props.isOpen && (
            <div className="preset-controls-body" id={bodyId}>
              {controls.map((control) => {
                const chosen = choices[control.id] ?? "";
                const labelId = `preset-controls-label-${preset.id}-${control.id}`;
                const label = controlLabel(control);
                // A toggle's TWO options map onto the switch:
                // [on, off] per core's convention, so the first
                // is checked and the second unchecked. The
                // stored choice is never guessed.
                const onOption = control.options[0];
                const offOption = control.options[1];
                const checked = chosen === onOption?.id;
                // The resolved choice always names a real
                // option (resolveChoices guarantees one entry
                // per control); fall back to the raw id only to
                // keep the label honest if that ever changes.
                const chosenOption = control.options.find((candidate) => candidate.id === chosen);
                const chosenLabel = chosenOption === undefined ? chosen : optionLabel(chosenOption);
                return (
                  <div className="preset-controls-row" key={control.id}>
                    <span className="preset-controls-row-main">
                      <span className="preset-controls-label" id={labelId}>
                        {label}
                      </span>
                      {control.description.trim() !== "" && (
                        <span className="caption muted preset-controls-desc">
                          {control.description}
                        </span>
                      )}
                    </span>
                    {control.type === "select" ? (
                      <select
                        className="select preset-controls-select"
                        aria-labelledby={labelId}
                        value={chosen}
                        onChange={(event) =>
                          props.onChooseControl(preset, control.id, event.currentTarget.value)
                        }
                      >
                        {control.options.map((option) => (
                          <option key={option.id} value={option.id}>
                            {optionLabel(option)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <label className="switch preset-controls-switch">
                        <input
                          type="checkbox"
                          className="switch-input"
                          checked={checked}
                          aria-labelledby={labelId}
                          onChange={(event) => {
                            const target = event.currentTarget.checked ? onOption : offOption;
                            if (target) {
                              props.onChooseControl(preset, control.id, target.id);
                            }
                          }}
                        />
                        <span className="switch-track">
                          <span className="switch-thumb" />
                        </span>
                      </label>
                    )}
                    {/* The switch itself cannot say what "on"
                        means, so name the option in effect. */}
                    {control.type === "toggle" && (
                      <span className="caption muted preset-controls-state">{chosenLabel}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/** Presets management: prompt pipelines that shape every generation. */
export default function Presets() {
  const app = useAppMotion();
  const presets = useAtomValue(presetsAtom);
  const presetsLoaded = useAtomValue(presetsLoadedAtom);
  const defaultId = useAtomValue(defaultIdAtom);
  const controlsOpen = useAtomValue(controlsOpenAtom);

  // Per-mount loading: a cached mount starts loaded (no skeleton), a first
  // mount runs the skeleton flow. The background revalidate never flips this
  // back to true — that's what makes it silent. The lazy initializer captures
  // the settled flag once, at setup.
  const [loading, setLoading] = useState(() => !presetsLoaded);
  const [error, setError] = useState<string | null>(null);
  /** Preset currently open in the editor; null while closed or drafting a new one. */
  const [editing, setEditing] = useState<Preset | null>(null);
  // Separate from `editing` because null means "new preset", not "closed":
  // a single nullable state could not tell the two apart. Mirrors Personas.
  const [editorOpen, setEditorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Preset | null>(null);
  // Rows rise in only when this mount fetched from scratch. On a cached
  // mount (and on the silent revalidate that follows it) the rows render
  // statically — no entrance-animation replay on tab switches.
  const [animate] = useState(() => !presetsLoaded);

  const fail = useCallback(
    (fallback: string) =>
      (err: unknown): void => {
        setError(err instanceof Error ? err.message : fallback);
      },
    [],
  );

  const refresh = useCallback((): void => {
    listPresets()
      .then((items) => {
        // merge by id, not a plain swap: listPresets() returns fresh row
        // objects, and replacing the array wholesale would remount every card
        // (replaying its entrance animation) even though only one row may have
        // moved.
        appStore.set(presetsAtom, (prev) => mergeRowsById(prev, items));
        appStore.set(presetsLoadedAtom, true);
        setError(null);
      })
      .catch(fail("Failed to load presets"))
      .finally(() => setLoading(false));
  }, [fail]);

  useEffect(() => {
    refresh();
    getSettings()
      .then((settings) => {
        const id = settings.default_preset_id;
        if (typeof id === "string") {
          appStore.set(defaultIdAtom, id);
        }
      })
      .catch(() => {}); // settings unreachable — no default highlighted
  }, [refresh]);

  /** Retries a failed first load: restore the skeleton while it is in flight,
   *  and clear the sticky error so the state does not double up. */
  const retry = useCallback((): void => {
    setLoading(true);
    setError(null);
    refresh();
  }, [refresh]);

  /** Toggles which preset is the default; clicking the star again clears it. */
  const setDefault = (preset: Preset): void => {
    const next = defaultId === preset.id ? null : preset.id;
    putSettings({ default_preset_id: next })
      .then(() => appStore.set(defaultIdAtom, next))
      .catch(fail("Failed to set default preset"));
  };

  /** Opens the editor on a blank in-memory draft; nothing is created until Save. */
  const create = (): void => {
    setEditing(null);
    setEditorOpen(true);
  };

  const openEditor = (preset: Preset): void => {
    setEditing(preset);
    setEditorOpen(true);
  };

  const confirmRemove = (): void => {
    const preset = pendingDelete;
    if (preset === null) {
      return;
    }
    setPendingDelete(null);
    deletePreset(preset.id).then(refresh).catch(fail("Failed to delete preset"));
  };

  const toggleControls = (preset: Preset): void => {
    appStore.set(controlsOpenAtom, (current) => {
      const next = new Set(current);
      if (next.has(preset.id)) {
        next.delete(preset.id);
      } else {
        next.add(preset.id);
      }
      return next;
    });
  };

  /**
   * Stores one control's choice and mirrors the server's echo back into the
   * cached list: both the stored map and the post-write `prompts` array, since
   * the route materialized the choice onto the governed rows' `enabled` flags.
   * Deliberately NOT optimistic: on failure the previous state stays and the
   * error banner reports it, so the card never shows a choice that was not
   * actually saved.
   */
  const chooseControl = (preset: Preset, controlId: string, optionId: string): void => {
    putPresetControls(preset.id, { [controlId]: optionId })
      .then((result) => {
        // merge by id, not a plain swap: the untouched cards keep their object
        // identity, so ONLY this card repaints — no entrance-animation replay
        // and no focus loss on the <select> that fired this. BOTH the echoed
        // map and the post-write `prompts` are mirrored: the choice was
        // materialized onto the governed rows' `enabled` flags, so
        // promptCaption's enabled count legitimately changed too.
        appStore.set(presetsAtom, (prev) =>
          mergeRowsById(
            prev,
            prev.map((item) =>
              item.id === preset.id
                ? {
                    ...item,
                    prompts: result.prompts,
                    settings: { ...item.settings, control_values: result.control_values },
                  }
                : item,
            ),
          ),
        );
        setError(null);
      })
      .catch(fail("Failed to save control choice"));
  };

  return (
    <section className="stack page">
      <div className="page-header">
        <MobileNavButton />
        <div className="page-heading">
          {/* The tip is a sibling of the <h1>, not inside it: a button's
              aria-label would otherwise fold into the heading's accessible
              name, which is a navigation landmark. Being a <button> it is
              natively focusable, so keyboard users get the tooltip too. */}
          <div className="row">
            <h1>Presets</h1>
            <button
              type="button"
              className="info-tip"
              aria-label={PRESETS_TIP}
              data-tip={PRESETS_TIP}
            >
              <Info size={14} aria-hidden="true" />
            </button>
          </div>
          <p className="caption page-desc">Prompt pipelines that shape every generation.</p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            data-tip="Import a preset file (Suvoj JSON or SillyTavern)"
            onClick={() => setImportOpen(true)}
          >
            <Upload size={16} />
            Import preset
          </button>
          <button type="button" className="btn btn-primary" onClick={create}>
            <Plus size={16} />
            New preset
          </button>
        </div>
      </div>

      {/* A failed first load is a first-class failure, not an empty library:
          show the danger-tinted error state with a retry INSTEAD of the list
          (which would otherwise render its "No presets yet" empty state
          underneath this banner). Once anything has loaded successfully, a
          later refresh/mutation error rides the banner over the live list. */}
      {error !== null && presetsLoaded && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {error !== null && !presetsLoaded ? (
        <div className="error-state" role="alert">
          <span className="empty-state-icon" aria-hidden="true">
            <TriangleAlert size={18} />
          </span>
          <span className="error-state-title">Couldn’t load presets</span>
          <span className="error-state-hint">{error}</span>
          <button type="button" className="btn" onClick={retry}>
            Try again
          </button>
        </div>
      ) : loading ? (
        <div className="preset-grid" aria-hidden="true">
          {SKELETON_ROWS.map((key) => (
            <div className="card preset-card skeleton-row" key={key}>
              <div className="skeleton preset-skeleton-icon" />
              <div className="skeleton-row-lines">
                <div className="skeleton skeleton-line" style={{ width: "45%" }} />
                <div className="skeleton skeleton-line" style={{ width: "70%" }} />
                <div className="skeleton skeleton-line" style={{ width: "40%" }} />
              </div>
              <div className="skeleton-row-actions">
                <div className="skeleton skeleton-action" />
                <div className="skeleton skeleton-action" />
                <div className="skeleton skeleton-action" />
                <div className="skeleton skeleton-action" />
              </div>
            </div>
          ))}
        </div>
      ) : presets.length > 0 ? (
        <ListStagger animate={animate} className="preset-grid">
          {presets.map((preset) => (
            <StaggerItem key={preset.id}>
              <PresetCard
                preset={preset}
                isDefault={defaultId === preset.id}
                isOpen={controlsOpen.has(preset.id)}
                onSetDefault={setDefault}
                onEdit={openEditor}
                onRemove={setPendingDelete}
                onToggleControls={toggleControls}
                onChooseControl={chooseControl}
              />
            </StaggerItem>
          ))}
        </ListStagger>
      ) : (
        <motion.div
          className="empty-card"
          variants={scaleVariants(app, 0.98)}
          initial="hidden"
          animate="visible"
        >
          <div className="empty-state">
            <span className="empty-state-icon" aria-hidden="true">
              <SlidersHorizontal size={36} />
            </span>
            <span className="empty-state-title">No presets yet</span>
            <span className="empty-state-hint">
              A preset is the prompt pipeline every generation reads — create one to shape your
              replies.
            </span>
            <div className="empty-state-actions">
              <button type="button" className="btn btn-primary" onClick={create}>
                <Plus size={16} />
                New preset
              </button>
            </div>
          </div>
        </motion.div>
      )}

      {/* editorOpen, not editing: editing === null is a valid "New preset"
          draft, so the open flag is what actually controls mounting. */}
      {editorOpen && (
        <PresetEditor
          preset={editing}
          onClose={() => setEditorOpen(false)}
          onSaved={() => {
            setEditorOpen(false);
            refresh();
          }}
        />
      )}

      {importOpen && <ImportPreset onClose={() => setImportOpen(false)} onImported={refresh} />}

      {pendingDelete !== null && (
        <ConfirmDialog
          title="Delete preset?"
          description={
            <>
              <strong>{pendingDelete.name}</strong> and its prompt pipeline will be deleted. Chats
              using it keep their existing messages.
            </>
          }
          confirmLabel="Delete preset"
          tone="danger"
          onClose={() => setPendingDelete(null)}
          onConfirm={confirmRemove}
        />
      )}
    </section>
  );
}
