/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import type {
  ControlOption,
  Preset,
  PresetControl,
  PresetControlType,
  PresetGenerationSettings,
  PresetPrompt,
  PresetPromptRole,
} from "../../lib/api-presets";
import { createPreset, PRESET_SETTINGS_DEFAULTS, updatePreset } from "../../lib/api-presets";
import { cx } from "../../lib/cx";
import type { MotionVariants } from "../../lib/motion";
import { INSTANT, riseVariants, useAppMotion } from "../../lib/motion";
import { prefixWarningText, volatilePrefixBlocks } from "../../lib/preset-cache";
import {
  controlIdProblem,
  governedPromptIds,
  settingsControls,
  withControlValues,
} from "../../lib/preset-controls";
import { effectiveRows, governanceOf, type RowGovernance } from "../../lib/preset-governance";
import {
  activeMemberId,
  applyGroupChoice,
  enabledMemberIds,
  findGroup,
  listGroups,
} from "../../lib/preset-groups";
import { MARKER_INFO, NEW_PRESET_PROMPTS } from "../../lib/preset-markers";
import {
  setTrigger,
  TRIGGER_OPTIONS,
  triggersAllTypes,
  unknownTriggers,
} from "../../lib/preset-triggers";
import { FieldLabel } from "../FieldLabel";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { Collapsible } from "../ui/collapsible";
import { Check, ChevronDown, ChevronUp, Info, Plus, Trash2, TriangleAlert, X } from "../ui/icons";
import Modal, { useModalClose } from "../ui/Modal";
import { Presence } from "../ui/presence";
import { ReorderableList } from "../ui/reorder";
import { PresetSection } from "./PresetSection";

interface PresetEditorProps {
  /** Existing preset to edit, or null to draft a brand-new one. */
  preset: Preset | null;
  onClose: () => void;
  /** The saved repository row — a create returns the freshly created preset. */
  onSaved: (preset: Preset) => void;
}

/**
 * Slug for prompt ids: lowercase, runs of non-alphanumerics become a single
 * hyphen, leading/trailing hyphens trimmed; `fallback` when nothing remains.
 */
const slugify = (text: string, fallback: string): string => {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? fallback : slug;
};

/** `base`, then `-2`, `-3`, … while `taken` already holds the id. */
const uniqueId = (base: string, taken: ReadonlySet<string>): string => {
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) {
    id = `${base}-${suffix}`;
  }
  return id;
};

/** Markers that carry their own editable content. */
const carriesContent = (prompt: PresetPrompt): boolean =>
  prompt.marker === "main" || prompt.marker === "jailbreak";

/** True for values that index `MARKER_INFO` — a known pipeline slot marker. */
const isMarkerSlot = (marker: PresetPrompt["marker"]): boolean =>
  marker !== undefined && MARKER_INFO[marker] !== undefined;

/**
 * Clones the pipeline as the editor's draft. Stored rows are only loosely
 * validated server-side, so undefined fields are healed to defaults here —
 * the editor never touches a missing field. Rows without a usable id get a
 * unique slug; marker slots with blank names are healed to their canonical
 * label — the user always sees a normal name, and the healed array is what
 * Save sends back.
 */
const draftPrompts = (source: PresetPrompt[]): PresetPrompt[] => {
  // Every well-formed id is reserved up front, so a generated replacement for
  // a missing/blank id never lands on one that appears later in the list.
  const taken = new Set(
    source.flatMap((p) => (typeof p.id === "string" && p.id !== "" ? [p.id] : [])),
  );
  // Ids this pass has already handed out. A hand-edited/API-written duplicate
  // id is re-slugged exactly like a missing one, so every returned id is
  // unique — React keys must be unique, and the healed array is what Save sends.
  const emitted = new Set<string>();
  return source.map((prompt) => {
    const raw = typeof prompt.id === "string" && prompt.id !== "" ? prompt.id : null;
    const id = raw !== null && !emitted.has(raw) ? raw : uniqueId(raw ?? "prompt", taken);
    taken.add(id);
    emitted.add(id);
    const name = prompt.name ?? "";
    const marker = isMarkerSlot(prompt.marker) ? prompt.marker : undefined;
    return {
      id,
      name: marker !== undefined && name.trim() === "" ? MARKER_INFO[marker].name : name,
      role: prompt.role ?? "system",
      content: prompt.content ?? "",
      enabled: prompt.enabled ?? true,
      marker,
      injection_position: prompt.injection_position ?? 0,
      injection_depth: prompt.injection_depth ?? 4,
      injection_order: prompt.injection_order ?? 100,
      // Carried through verbatim: the draft replaces the whole array on save,
      // so an imported ST trigger (including values Suvoj never matches, like
      // `impersonate`) survives an edit here.
      injection_trigger: prompt.injection_trigger ?? [],
      // Metadata-only group membership, carried verbatim (see lib/preset-groups).
      // Absent stays absent so an ungrouped preset round-trips byte-identically;
      // present is cloned like every other row field so the draft never shares
      // an object with the cached list.
      ...(prompt.group === undefined
        ? {}
        : { group: { id: prompt.group.id, label: prompt.group.label } }),
    };
  });
};

/**
 * Clones the controls as the editor's draft. Unlike prompts, controls are
 * already normalized by `settingsControls` (the same tolerant parse the
 * engine uses), so there is nothing to heal — only to deep-clone: the nested
 * `options` array and each option's `prompts` array must not be shared with
 * the cached preset row, or editing a row here would mutate the list behind
 * the open modal (and a Cancel could not roll it back).
 */
const draftControls = (source: readonly PresetControl[]): PresetControl[] =>
  source.map((control) => ({
    id: control.id,
    label: control.label,
    description: control.description,
    type: control.type,
    default: control.default,
    options: control.options.map((option) => ({ ...option, prompts: [...option.prompts] })),
  }));

/**
 * What stops a control from being usable, or `null`. Mirrors the rules core's
 * `parseControls` applies SILENTLY: fewer than two options, blank or
 * duplicate option ids (option ids ARE the stored choice values), and a
 * toggle's two-option cap. Without this the engine would drop a control the
 * user thought they had saved, so Save is blocked until it is fixed.
 */
function controlOptionProblem(control: PresetControl): string | null {
  if (control.options.length < 2) {
    return "A control needs at least two options.";
  }
  if (control.options.some((option) => option.id === "")) {
    return "Every option needs an id.";
  }
  if (new Set(control.options.map((option) => option.id)).size !== control.options.length) {
    return "Option ids must be unique — an id is what a saved choice stores.";
  }
  if (control.type === "toggle" && control.options.length > 2) {
    return "An on/off switch uses exactly two options — remove the extra ones.";
  }
  return null;
}

/**
 * The Generation section's editable draft. The two integer fields stay as
 * strings so an empty/partial value is representable — `invalid` blocks
 * saving it instead of silently coercing it into the row. The strings fall
 * back to the engine's own defaults (a stored preset usually carries them,
 * but a legacy/imported one may omit any of them).
 */
interface SettingsDraft {
  scan_depth: string;
  wi_budget: string;
  new_chat_prompt: string;
  new_example_chat_prompt: string;
  personality_format: string;
  scenario_format: string;
}

const settingsDraft = (source: PresetGenerationSettings | undefined): SettingsDraft => ({
  scan_depth: String(source?.scan_depth ?? PRESET_SETTINGS_DEFAULTS.scan_depth),
  wi_budget: String(source?.wi_budget ?? PRESET_SETTINGS_DEFAULTS.wi_budget),
  new_chat_prompt: source?.new_chat_prompt ?? PRESET_SETTINGS_DEFAULTS.new_chat_prompt,
  new_example_chat_prompt:
    source?.new_example_chat_prompt ?? PRESET_SETTINGS_DEFAULTS.new_example_chat_prompt,
  personality_format: source?.personality_format ?? PRESET_SETTINGS_DEFAULTS.personality_format,
  scenario_format: source?.scenario_format ?? PRESET_SETTINGS_DEFAULTS.scenario_format,
});

/** A base-10 integer, or null when the text is not one (`""`, `"1.5"`, …). */
const parseInteger = (raw: string): number | null =>
  /^-?\d+$/.test(raw.trim()) ? Number(raw) : null;

/**
 * A stable text fingerprint of the whole draft, used only to answer "is there
 * anything to save?". The editor's cloned rows are plain JSON-safe objects
 * with a fixed key order (see `draftPrompts`/`draftControls`/`settingsDraft`),
 * so `JSON.stringify` is a faithful, cheap comparison — no deep-equal walk and
 * no dependence on the cached row's object identity. The WeakMap render keys
 * are not own properties, so they never leak into the fingerprint.
 */
const draftSignature = (
  name: string,
  description: string,
  settings: SettingsDraft,
  prompts: readonly PresetPrompt[],
  controls: readonly PresetControl[],
): string => JSON.stringify({ name, description, settings, prompts, controls });

/**
 * Tooltips for the editor's fields and controls. Kept in one table (rather
 * than inline next to each control) so the wording stays reviewable in one
 * place, mirroring the lorebook entry editor.
 *
 * Each tip must explain the *effect* of the field, not restate its label.
 * The per-row icon buttons (move/delete/expand) keep their short inline
 * `data-tip`s; this table carries the longer explanations.
 */
const FIELD_TIPS: Record<string, string> = {
  name: "Shown only in the preset list — the model never sees it.",
  description: "A note for yourself about what this preset is for; it is never sent to the model.",
  generation:
    "Engine settings applied while the prompt is assembled — lorebook scanning, the lorebook token cap, and the wrappers around character data. They are not pipeline rows, so they have no position in the list below.",
  pipeline:
    "The generation flow, top to bottom: the model receives these rows in list order. Slot rows render character, chat and lorebook data at their fixed position; regular prompts send their own text. Reorder or switch rows off to change what the model sees.",
  slot: "A fixed pipeline position, not free text. The engine renders this slot's own data here (character card, lorebook, chat history); only the main prompt and post-history instructions carry editable text of their own.",
  role: "The label the block is sent under. System reads as authoritative instructions and context, User as text from you, Assistant as text from the character — useful for steering a reply's style with an example.",
  enabled:
    "Switch a row off to skip it entirely: it stays saved, but this generation leaves it out.",
  injection:
    'Where the prompt lands. "In place" renders it at its position in the list above. "In chat, depth" hides it from that position and inserts it inside the chat history instead, counting back from the newest message.',
  depth:
    "For an in-chat injection: how many messages back from the end of the chat it lands (0 = right after the newest message). Larger numbers push it further into the past.",
  injectionOrder:
    "Only for in-chat injections that share a depth, and only then does it matter: among injections at the SAME depth, the HIGHER order renders closer to the END of the history. Leave it at 100 unless two injections collide at one depth.",
  injectionTrigger:
    "Generation types this prompt joins. With none ticked it applies to every type (the default). A non-empty selection sends it only for those types — e.g. a 'Continue' prompt is skipped on a normal send. Imported values Suvoj never matches (impersonate, quiet) show as their own removable entries.",
  groups:
    "Options that are alternatives, not additions. A group is a set of prompts that must never be on at once (Point of view: Third / Second / First). Pick one here and the editor switches the others off; the pipeline rows still work exactly as before.",
  controls:
    "Switchers your preset's users flip from the Presets page without opening this editor. Each control's chosen option switches its prompt rows on and off when it is flipped, and prompt text can read the choice with {{ui:<control id>}}.",
  controlId:
    "The name prompt text uses in {{ui:<id>}} and the key a stored choice lives under. Lowercase letters, digits and hyphens, starting with a letter or digit.",
  controlLabel:
    "What users see beside the switcher on the Presets page. Falls back to the id when blank.",
  controlDescription:
    "A hint shown under the switcher on the Presets page, so users know what the choice changes.",
  controlType:
    "Dropdown for three or more choices; on/off switch for a flag. A switch is strictly binary — only its first two options are used, so keep exactly two.",
  controlDefault:
    "The option a preset falls back to while nobody has picked one (a new chat, a freshly imported preset). Leave it on the first option unless another is the safer default.",
  controlMacro:
    "What {{ui:<control id>}} is replaced with while this option is chosen. Blank expands to the option's label, or to its id when the label is blank too.",
  controlPrompts:
    "The pipeline rows this option switches on. Choosing the option switches these rows on and every other option's rows off, so a row named here has no switch of its own — the editor disables it. A row named here should not also sit in a group, where the group chooser would fight the control.",
  controlOptions:
    "The choices users pick between. Option ids ARE the stored choice values, so renaming one resets anyone's saved choice to the default.",
  controlLinkGroup:
    "Copy a group's members in as this control's options: one option per member, naming that member's own prompt row. The quick way to turn an existing group into a switcher on the Presets page.",
  controlAdd: "Append another choice to this control.",
  addControl: "Add a switcher users can flip from the Presets page.",
  addPrompt: "Append a new regular prompt at the end of the pipeline.",
  scanDepth:
    "How many of the newest chat messages the lorebook scans for its trigger keys. Higher depth lets entries keyed to older context fire, at a small per-message cost.",
  wiBudget:
    "The token cap for all lorebook entries activated in one prompt. Once the cap is reached, further activations are dropped, so raise it if detailed entries go missing.",
  newChatPrompt:
    "A system line inserted at the very start of the chat history, before the first live message. It marks where the conversation begins (an empty value sends nothing).",
  newExampleChatPrompt:
    "A system line inserted before each example-dialogue block, so the model can tell examples apart from the live chat. Empty sends no separator.",
  personalityFormat:
    "The template wrapping the character's personality field. {{personality}} is replaced with that field's text ({{char}} still works as the character's name), so you can label or phrase it your way.",
  scenarioFormat:
    "The template wrapping the character's scenario field. {{scenario}} is replaced with that field's text, so you can label or phrase the scene your way.",
};

/**
 * A `<label>` plus a sibling Info button carrying the field's tooltip, via the
 * shared `FieldLabel`. `id` is a short field key; the label points at
 * `preset-field-<id>`, and the caller passes the tip because prompt-row ids are
 * dynamic and cannot key a static table.
 */
function fieldLabel(id: string, label: string, tip: string): ReactNode {
  return <FieldLabel htmlFor={`preset-field-${id}`} text={label} tip={tip} />;
}

/**
 * A `<span>` label plus its Info button — the `fieldLabel` shape for controls
 * that are not a single labelled element (a chip group, a checkbox list), where
 * a `for`/`id` pair would have nothing to point at.
 */
function labelWithTip(label: string, tip: string): ReactNode {
  return <FieldLabel text={label} tip={tip} />;
}

/**
 * The preset editor's save actions. Extracted so Cancel can call
 * `useModalClose()` — the hook must run in a child of <Modal>, never in the
 * component that renders it — so the panel's exit animation plays before the
 * parent unmounts it. Save submits the body form through `form=` so the primary
 * action never scrolls out of reach at the bottom of a long pipeline.
 */
function PresetEditorActions(props: { saving: boolean; invalid: boolean }): ReactElement {
  const close = useModalClose();
  return (
    <div className="preset-editor-actions">
      <button type="button" className="btn" onClick={close}>
        Cancel
      </button>
      <button
        type="submit"
        className="btn btn-primary"
        disabled={props.saving || props.invalid}
        aria-busy={props.saving}
      >
        {props.saving && <span className="spinner btn-spinner" aria-hidden="true" />}
        {props.saving ? "Saving…" : "Save preset"}
      </button>
    </div>
  );
}

interface GroupRowProps {
  groupId: string;
  prompts: readonly PresetPrompt[];
  rowLabel: (prompt: PresetPrompt) => string;
  onChoose: (groupId: string, memberId: string) => void;
}

/**
 * One group's chooser. Extracted from the editor so the three derivations that
 * Solid declared inside the list callback are `useMemo`s here: React hooks
 * cannot live in a loop, and fragmenting them into the parent would recompute
 * every group on each keystroke anyway. Keyed by the stable group id, so a
 * prompt edit never remounts the row (and never drops focus from the select).
 *
 * The label, members, and current choice all follow `prompts`. `active ===
 * null` means zero or several members are enabled: neither is a decision, so
 * the control stays on its placeholder rather than picking one.
 */
function GroupRow(props: GroupRowProps) {
  const { groupId, prompts } = props;
  const group = useMemo(() => findGroup(prompts, groupId), [prompts, groupId]);
  const active = useMemo(() => activeMemberId(prompts, groupId), [prompts, groupId]);
  const onCount = useMemo(() => enabledMemberIds(prompts, groupId).length, [prompts, groupId]);

  return (
    <div className={cx("preset-group-row", active === null && "is-unset")}>
      <span className="preset-group-label" title={group?.label}>
        {group?.label}
      </span>
      {/* A controlled `value` (rather than a `selected` on each <option>):
          React warns about `selected` on options, and a controlled select
          applies the current choice even though the options render
          dynamically. The disabled `""` placeholder shows the invalid
          zero/many state without offering it as a choice. */}
      <select
        className="select preset-group-select"
        aria-label={`${group?.label ?? groupId} option`}
        value={active ?? ""}
        onChange={(event) => props.onChoose(groupId, event.currentTarget.value)}
      >
        <option value="" disabled>
          {onCount > 1 ? "Invalid — pick again" : "Not set"}
        </option>
        {(group?.members ?? []).map((member) => (
          <option key={member.id} value={member.id}>
            {props.rowLabel(member)}
          </option>
        ))}
      </select>
      {active === null && (
        <span className="preset-group-warn" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          {onCount > 1 ? `${onCount} options are on — only one can apply.` : "No option is on."}
        </span>
      )}
    </div>
  );
}

/** Which disclosure sections the editor is showing. */
type SectionKey = "generation" | "prompts" | "controls";

/** Modal preset editor: metadata plus the ordered prompt pipeline. */
export default function PresetEditor(props: PresetEditorProps) {
  const app = useAppMotion();
  const { confirm, dialog } = useConfirmDialog();

  // The prompts draft is a local state array updated immutably: a patch clones
  // only the row it touches, so each other row keeps its object identity and
  // its DOM element (rows render keyed by their stable id), never remounting
  // the row being typed in — focus stays where the user is typing. The draft
  // is also cloned per row — edits never leak into the cached list (or into the
  // shared NEW_PRESET_PROMPTS skeleton) until Save writes the whole array.
  const [name, setName] = useState(() => props.preset?.name ?? "");
  const [description, setDescription] = useState(() => props.preset?.description ?? "");
  // The generation settings draft. Edited keys are merged over the preset's
  // raw stored settings on save, so unknown keys (memory wiring, a future
  // setting) survive the whole-object PATCH that replaces `settings`.
  const [settings, setSettings] = useState<SettingsDraft>(() =>
    settingsDraft(props.preset?.settings as PresetGenerationSettings | undefined),
  );
  const [prompts, setPrompts] = useState<PresetPrompt[]>(() =>
    // A brand-new preset drafts the full marker skeleton: slots are fixed
    // pipeline positions a preset is expected to carry, so the user starts
    // from a working layout rather than an empty list.
    //
    // `effectiveRows` then overlays each control's effective choice on the
    // healed draft — after `draftPrompts`, so the overlay matches the ids the
    // editor actually shows. A governed row's stored `enabled` is derived data
    // (the server re-normalizes it on every write and the engine overlays the
    // choice again at generation), so seeding the raw column would render a
    // switch position generation never uses. The draft stays the draft — Save
    // still sends these rows, and the server normalizes them again.
    effectiveRows(
      draftPrompts(props.preset?.prompts ?? NEW_PRESET_PROMPTS),
      props.preset?.settings,
    ),
  );
  // The controls draft. Like `prompts` it is a cloned array (deep-cloned by
  // `draftControls`), so edits never leak into the cached list; unlike
  // prompts it is NOT applied to the pipeline — the engine switches rows at
  // generation time, and the editor only authors the declarations. The chosen
  // values are round-tripped verbatim, never edited here.
  const [controls, setControls] = useState<PresetControl[]>(() =>
    draftControls(settingsControls(props.preset?.settings)),
  );
  // The row whose body (content / advanced) is expanded — one at a time,
  // so long pipelines stay scannable.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The row currently playing its removal animation. `removePrompt` confirms,
  // parks the id here, and the row's <Presence> calls `completeRemove` once the
  // exit lands — so a deleted row animates out instead of vanishing between
  // frames. Under reduced motion removal commits immediately (no state here).
  const [exitingId, setExitingId] = useState<string | null>(null);
  // Disclosures are controlled here rather than by <details> so the section
  // chrome can animate and carry a count/validity summary. Generation and
  // Controls start folded (authoring-only chrome); Prompts is the content.
  const [sections, setSections] = useState<Record<SectionKey, boolean>>({
    generation: false,
    prompts: true,
    controls: false,
  });
  // Controls are open unless explicitly closed (keyed by the stable render key
  // below), so authoring a new control doesn't hide its options behind a click.
  const [closedControls, setClosedControls] = useState<ReadonlySet<string>>(() => new Set());

  // The fingerprint of the draft as it was when the editor opened. New preset
  // vs. existing edit does not matter: the same healed/overlaid draft is the
  // baseline, so an untouched editor is never reported dirty.
  const [baseline] = useState(() => draftSignature(name, description, settings, prompts, controls));

  // Stable render keys for the control/option draft rows. Solid's
  // reference-keyed <For> kept a row mounted when its store entry was patched
  // in place; React keys must be stable strings, and object identity does not
  // survive an immutable update. So every draft row object gets a key the
  // first time it renders, and each helper that clones a row carries that key
  // over (the React twin of the store's identity-preserving merge). Rows whose
  // id is editable (controls and options) need this — keying by `id` would
  // remount the field on every keystroke; prompt rows use their immutable id.
  // Writing the map during render is safe because it is idempotent: the same
  // object always yields the same key, so a StrictMode double render would
  // only re-set the same entry harmlessly.
  const rowKeys = useRef(new WeakMap<object, string>());
  const rowKeySeq = useRef(0);
  const keyOf = (row: object): string => {
    const existing = rowKeys.current.get(row);
    if (existing !== undefined) {
      return existing;
    }
    rowKeySeq.current += 1;
    const key = `preset-row-${rowKeySeq.current}`;
    rowKeys.current.set(row, key);
    return key;
  };
  const rekey = <T extends object>(source: object, next: T): T => {
    rowKeys.current.set(next, keyOf(source));
    return next;
  };
  /** Immutably replaces one control, reusing every other control object. */
  const mapControl = (index: number, update: (control: PresetControl) => PresetControl): void => {
    setControls((current) =>
      current.map((control, i) => (i === index ? rekey(control, update(control)) : control)),
    );
  };
  /** Immutably replaces one option inside one control, reusing the rest. */
  const mapOption = (
    controlIndex: number,
    optionIndex: number,
    update: (option: ControlOption) => ControlOption,
  ): void => {
    mapControl(controlIndex, (control) => ({
      ...control,
      options: control.options.map((option, j) =>
        j === optionIndex ? rekey(option, update(option)) : option,
      ),
    }));
  };

  /** What a row is called in labels and confirm dialogs — never blank. */
  const rowLabel = (prompt: PresetPrompt): string =>
    prompt.name.trim() === "" ? "unnamed prompt" : prompt.name.trim();

  /**
   * The control ids `controlIdProblem` compares against: every OTHER control
   * in the draft. Excluding the row's own id keeps an untouched control valid
   * while still flagging a rename onto a sibling's id.
   */
  const otherControlIds = (index: number): Set<string> =>
    new Set(controls.filter((_, i) => i !== index).map((control) => control.id));

  /** The reason a control's id is unusable, or null. Live editor validation.
   *  Declared before `invalid` because that derivation runs eagerly and calls it. */
  const controlIdError = (index: number): string | null => {
    const control = controls[index];
    return control === undefined ? null : controlIdProblem(control.id, otherControlIds(index));
  };

  /** scan_depth: integer ≥ 1 (mirrors `presetSettingsSchema`). */
  const scanDepth = parseInteger(settings.scan_depth);
  const validScanDepth = scanDepth !== null && scanDepth >= 1;

  /** wi_budget: integer ≥ 0 (mirrors `presetSettingsSchema`). */
  const wiBudget = parseInteger(settings.wi_budget);
  const validWiBudget = wiBudget !== null && wiBudget >= 0;

  /**
   * Save is blocked while the preset name or any prompt name is blank, or a
   * generation integer is unparseable/out of the schema's bounds. Controls
   * have their own rules: the engine silently DROPS a malformed control, so
   * anything the user could not round-trip must block Save rather than
   * vanish on reload. `problemCount` feeds the header's validity badge; the
   * boolean gate is exactly `problemCount > 0`, i.e. the same OR-chain as
   * before, only counted so the user can see how far they are from saving.
   */
  const problemCount =
    (name.trim() === "" ? 1 : 0) +
    prompts.filter((prompt) => prompt.name.trim() === "").length +
    (validScanDepth ? 0 : 1) +
    (validWiBudget ? 0 : 1) +
    controls.filter((_, index) => controlIdError(index) !== null).length +
    controls.filter((control) => controlOptionProblem(control) !== null).length;
  const invalid = problemCount > 0;

  /** Depth injections are dropped without a chat history to land in. */
  const hasChatHistory = prompts.some((prompt) => prompt.marker === "chatHistory");

  /**
   * Rows that render before the chat history and carry a macro whose value
   * changes every turn. Providers cache an unchanged prompt PREFIX, so one of
   * these costs a full cache miss on every single generation. Derived from the
   * draft, so the warning clears the moment the user fixes the row.
   */
  const volatilePrefix = useMemo(() => volatilePrefixBlocks(prompts), [prompts]);
  const volatilePrefixById = useMemo(
    () => new Map(volatilePrefix.map((block) => [block.promptId, block])),
    [volatilePrefix],
  );

  /** True once the draft differs from the state the editor opened on. */
  const dirty = useMemo(
    () => draftSignature(name, description, settings, prompts, controls) !== baseline,
    [name, description, settings, prompts, controls, baseline],
  );

  /**
   * The mutually-exclusive groups the pipeline defines, in pipeline order
   * (see lib/preset-groups). Derived from the draft, so the chooser follows
   * a manual row toggle too. Empty for an ungrouped preset, which then
   * behaves exactly as before — no chooser is rendered.
   *
   * Only the stable group IDS are exposed to the list: `listGroups` rebuilds
   * its objects on every prompts change, and keying rows by object identity
   * would remount them (and drop focus from the control being used). Rows look
   * their group up by id instead.
   */
  const groupIds = listGroups(prompts).map((group) => group.id);

  /**
   * Applies a group choice: exactly the picked member ends up enabled, its
   * siblings off. `applyGroupChoice` computes the target flags and reuses every
   * untouched row by reference; passing the result straight to the state setter
   * then keeps each untouched row's identity and its DOM, so focus survives a
   * pick. The no-op guard keeps a non-choice (the chooser's empty placeholder)
   * from producing a fresh array.
   */
  const chooseGroupMember = (groupId: string, memberId: string): void => {
    if (memberId === "") {
      return; // the chooser's invalid-state placeholder — not a choice
    }
    setPrompts((current) => {
      const next = applyGroupChoice(current, groupId, memberId);
      return next.every((prompt, index) => prompt === current[index]) ? current : next;
    });
  };

  /** What an option is called in labels and selects — never blank. */
  const optionLabel = (option: ControlOption): string =>
    option.label.trim() === "" ? option.id : option.label.trim();

  /** What a control is called in labels, badges and tooltips — never blank. */
  const controlLabel = (control: PresetControl): string =>
    control.label.trim() === "" ? control.id : control.label.trim();

  /**
   * The shared tail of every governed-row explanation: what the control's
   * ownership MEANS and what the user can do about it. Lowercase because both
   * callers introduce it after an em dash, and one constant means the switch's
   * tip and the badge's tip can never describe governance differently.
   */
  const GOVERNED_TAIL =
    "that control's choice switches this row on or off, so this row's own switch is disabled. Change it on the preset's card, or remove this row from that control's options.";

  /** Why a governed row's switch is disabled — for the switch itself. */
  const governedSwitchReason = (control: PresetControl): string =>
    `Controlled by ${controlLabel(control)} — ${GOVERNED_TAIL}`;

  /** The same fact from the badge, which already names the control. */
  const governedBadgeTip = (control: PresetControl): string =>
    `Control: ${controlLabel(control)} — ${GOVERNED_TAIL}`;

  /**
   * The pipeline rows a control governs, for the row badges and switches:
   * prompt id → the control that switches it. `governedPromptIds` mirrors
   * `applyChoices`' later-control-wins order, so the badge names the control
   * whose choice actually decides the row.
   */
  const governingControls = useMemo(() => governedPromptIds(controls), [controls]);

  /**
   * What a row's switch may do: the control whose choice owns the flag, or
   * `undefined` for a row no control names. `governanceOf` pairs the memoized
   * map with the draft controls, so a governed row always has a control to
   * name in its badge and tooltip — and only then is its switch disabled.
   */
  const governance = (prompt: PresetPrompt): RowGovernance =>
    governanceOf(prompt.id, controls, governingControls);

  const patchControl = (index: number, changes: Partial<PresetControl>): void => {
    mapControl(index, (control) => ({ ...control, ...changes }));
  };

  const patchOption = (
    controlIndex: number,
    optionIndex: number,
    changes: Partial<ControlOption>,
  ): void => {
    mapOption(controlIndex, optionIndex, (option) => ({ ...option, ...changes }));
  };

  const moveControl = (index: number, delta: -1 | 1): void => {
    setControls((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      const moved = next[index] as PresetControl;
      next[index] = next[target] as PresetControl;
      next[target] = moved;
      return next;
    });
  };

  /** Appends a control with a unique slug id and two starter options. */
  const addControl = (): void => {
    const taken = new Set(controls.map((control) => control.id));
    const id = uniqueId(slugify("New control", "control"), taken);
    setControls((current) => [
      ...current,
      {
        id,
        label: "New control",
        description: "",
        type: "select",
        options: [
          { id: "option-1", label: "Option 1", value: "", prompts: [] },
          { id: "option-2", label: "Option 2", value: "", prompts: [] },
        ],
        default: "",
      },
    ]);
  };

  const removeControl = (control: PresetControl, index: number): void => {
    confirm({
      title: "Delete control?",
      description: (
        <>
          <strong>{controlLabel(control)}</strong> and its options will be removed from this preset.
        </>
      ),
      confirmLabel: "Delete control",
      tone: "danger",
      onConfirm: () => {
        // By index, not object identity: every draft mutation replaces the row it
        // touches, so a captured reference is not guaranteed to be the one in the
        // current array. The caller already holds the position.
        setControls((current) => current.filter((_, i) => i !== index));
      },
    });
  };

  /** Appends an option with an id unique within its own control. */
  const addOption = (controlIndex: number): void => {
    const control = controls[controlIndex];
    if (control === undefined) {
      return;
    }
    const taken = new Set(control.options.map((option) => option.id));
    const id = uniqueId(slugify("New option", "option"), taken);
    mapControl(controlIndex, (current) => ({
      ...current,
      options: [...current.options, { id, label: "New option", value: "", prompts: [] }],
    }));
  };

  /**
   * Removes an option. A removed option that was the control's `default` is
   * cleared first: leaving the id dangling would still resolve (core collapses
   * an unknown default to the first option), but the editor's default select
   * would then show "First option" while the stored `default` says otherwise.
   */
  const removeOption = (controlIndex: number, optionIndex: number): void => {
    const control = controls[controlIndex];
    if (control === undefined) {
      return;
    }
    const removed = control.options[optionIndex];
    mapControl(controlIndex, (current) => ({
      ...current,
      options: current.options.filter((_, index) => index !== optionIndex),
    }));
    if (removed !== undefined && control.default === removed.id) {
      patchControl(controlIndex, { default: "" });
    }
  };

  const moveOption = (controlIndex: number, optionIndex: number, delta: -1 | 1): void => {
    mapControl(controlIndex, (control) => {
      const target = optionIndex + delta;
      if (target < 0 || target >= control.options.length) {
        return control;
      }
      const next = [...control.options];
      const moved = next[optionIndex] as ControlOption;
      next[optionIndex] = next[target] as ControlOption;
      next[target] = moved;
      return { ...control, options: next };
    });
  };

  /** Checks/unchecks one pipeline row on one option's `prompts` list. */
  const setOptionPrompt = (
    controlIndex: number,
    optionIndex: number,
    promptId: string,
    on: boolean,
  ): void => {
    mapOption(controlIndex, optionIndex, (option) => ({
      ...option,
      prompts: on
        ? option.prompts.includes(promptId)
          ? option.prompts
          : [...option.prompts, promptId]
        : option.prompts.filter((id) => id !== promptId),
    }));
  };

  /**
   * Prefills a control's options from a group (see lib/preset-groups): one
   * option per member, naming that member's own row. Member ids are already
   * slugs, but a hand-edited/imported group can hold anything, so each is
   * slugged and de-duplicated to stay a usable option id.
   */
  const linkGroup = (controlIndex: number, groupId: string): void => {
    const group = findGroup(prompts, groupId);
    if (group === undefined) {
      return;
    }
    const taken = new Set<string>();
    const options: ControlOption[] = group.members.map((member) => {
      const id = uniqueId(slugify(member.id, "option"), taken);
      taken.add(id);
      return { id, label: rowLabel(member), value: "", prompts: [member.id] };
    });
    mapControl(controlIndex, (control) => ({ ...control, options, default: "" }));
  };

  /** Distinct unknown trigger values, in first-seen order (for chip rendering). */
  const uniqueUnknownTriggers = (prompt: PresetPrompt): string[] => [
    ...new Set(unknownTriggers(prompt.injection_trigger)),
  ];

  /**
   * Merges changes into one prompt row by id; ids are stable keys, never
   * renamed. Cloning only the targeted row keeps its identity — and its DOM —
   * intact, so typing in a row never drops focus.
   */
  const patch = (id: string, changes: Partial<PresetPrompt>): void => {
    setPrompts((current) =>
      current.map((prompt) => (prompt.id === id ? { ...prompt, ...changes } : prompt)),
    );
  };

  const move = (index: number, delta: -1 | 1): void => {
    setPrompts((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      const moved = next[index] as PresetPrompt;
      next[index] = next[target] as PresetPrompt;
      next[target] = moved;
      return next;
    });
  };

  /**
   * The actual removal, run from the row's <Presence> `onExitComplete` (or
   * immediately under reduced motion). Clearing only this row's own state means
   * a background commit of a previously-exiting row cannot switch off the one
   * the user just asked to delete.
   */
  const completeRemovePrompt = (id: string): void => {
    setPrompts((current) => current.filter((prompt) => prompt.id !== id));
    setExpandedId((current) => (current === id ? null : current));
    setExitingId((current) => (current === id ? null : current));
  };

  const removePrompt = (prompt: PresetPrompt): void => {
    confirm({
      title: "Delete prompt?",
      description: (
        <>
          <strong>{rowLabel(prompt)}</strong> will be removed from this preset's pipeline.
        </>
      ),
      confirmLabel: "Delete prompt",
      tone: "danger",
      onConfirm: () => {
        // A second delete while one row is mid-exit would strand the first (its
        // Presence never completes), so commit the outstanding one first.
        if (exitingId !== null && exitingId !== prompt.id) {
          completeRemovePrompt(exitingId);
        }
        if (app.reduce) {
          completeRemovePrompt(prompt.id);
          return;
        }
        setExitingId(prompt.id);
      },
    });
  };

  /** Appends a regular prompt with a unique slug id and opens it for editing. */
  const addPrompt = (): void => {
    const taken = new Set(prompts.map((prompt) => prompt.id));
    const id = uniqueId(slugify("New prompt", "prompt"), taken);
    setPrompts((current) => [
      ...current,
      {
        id,
        name: "New prompt",
        role: "system",
        content: "",
        enabled: true,
        injection_position: 0,
        injection_depth: 4,
        injection_order: 100,
        injection_trigger: [],
      },
    ]);
    setExpandedId(id);
  };

  const toggleExpanded = (id: string): void => {
    setExpandedId((current) => (current === id ? null : id));
  };

  const toggleSection = (key: SectionKey): void => {
    setSections((current) => ({ ...current, [key]: !current[key] }));
  };

  const toggleControl = (key: string): void => {
    setClosedControls((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  /**
   * The full `settings` object Save sends. The PATCH replaces the whole
   * object, so the preset's raw stored settings are spread first and the
   * edited keys overwrite them — unknown keys (memory wiring, anything a
   * newer engine added) survive untouched. The `??` fallbacks are
   * unreachable: `invalid` already blocked an unparseable/out-of-range
   * draft before `save` gets here.
   *
   * `controls` is the draft (the whole point of this section) and
   * `control_values` is carried through verbatim: the editor never picks a
   * choice, and a plain Save must not wipe the one users made on the Presets
   * page. `withControlValues(stored, {})` performs the same merge the
   * controls route performs — it keeps a stored map as-is and replaces only a
   * malformed/non-object one — so a save and a PUT never disagree on the blob.
   */
  const mergedSettings = (): PresetGenerationSettings => {
    const stored = (props.preset?.settings ?? {}) as PresetGenerationSettings;
    return {
      ...withControlValues(stored, {}),
      scan_depth: scanDepth ?? PRESET_SETTINGS_DEFAULTS.scan_depth,
      wi_budget: wiBudget ?? PRESET_SETTINGS_DEFAULTS.wi_budget,
      new_chat_prompt: settings.new_chat_prompt,
      new_example_chat_prompt: settings.new_example_chat_prompt,
      personality_format: settings.personality_format,
      scenario_format: settings.scenario_format,
      controls: draftControls(controls),
    };
  };

  const save = (): void => {
    if (saving || invalid) {
      return;
    }
    setSaving(true);
    setError(null);
    const input = {
      name: name.trim(),
      description: description.trim(),
      // The draft replaces the whole stored array on update, and IS the new
      // layout on create — blank marker names already healed at draft time.
      // A row still playing its removal animation is filtered out, so a Save
      // clicked inside that ~150ms window cannot resurrect it.
      prompts: exitingId === null ? prompts : prompts.filter((prompt) => prompt.id !== exitingId),
      settings: mergedSettings(),
    };
    // A null preset is a brand-new draft: nothing exists server-side until
    // this create. An edit PATCHes the existing row instead.
    const request =
      props.preset === null ? createPreset(input) : updatePreset(props.preset.id, input);
    request
      .then((saved) => {
        setSaving(false);
        props.onSaved(saved);
      })
      .catch((err: unknown) => {
        setSaving(false);
        setError(err instanceof Error ? err.message : "Failed to save preset");
      });
  };

  /** Shared head controls: the reorder buttons. */
  const reorderButtons = (prompt: PresetPrompt, index: number): ReactNode => (
    <>
      <button
        type="button"
        className="btn btn-icon"
        aria-label={`Move ${rowLabel(prompt)} up`}
        data-tip="Move up"
        disabled={index === 0}
        onClick={() => move(index, -1)}
      >
        <ChevronUp size={16} />
      </button>
      <button
        type="button"
        className="btn btn-icon"
        aria-label={`Move ${rowLabel(prompt)} down`}
        data-tip="Move down"
        disabled={index === prompts.length - 1}
        onClick={() => move(index, 1)}
      >
        <ChevronDown size={16} />
      </button>
    </>
  );

  /**
   * The row's own switch. A row no control names keeps a live switch exactly
   * as before — group membership is metadata, not governance, so a grouped
   * row's switch stays live too.
   *
   * A GOVERNED row's `enabled` is derived data: the control's choice decides
   * it, the server re-normalizes the stored flag on every write, and the
   * engine overlays the choice again at generation. Letting the user flip it
   * would be a switch that lies — it appears to work, then quietly reverts on
   * save. So it renders disabled and explains itself in place.
   *
   * Why the explanation is a sibling <button> rather than the live branch's
   * `data-tip` on the label: a disabled checkbox is not focusable and takes no
   * pointer events of its own, so neither branch of the tooltip controller
   * could reach a tip attached to it. The `info-tip` button is the file's
   * house pattern for exactly this (natively focusable, aria-label gives
   * assistive tech the same text the sighted tooltip shows).
   */
  const enabledSwitch = (prompt: PresetPrompt, onToggle: (checked: boolean) => void): ReactNode => {
    const governanceState = governance(prompt);
    if (governanceState.disabled) {
      const reason = governedSwitchReason(governanceState.control);
      return (
        // The disabled switch and its Info button are one affordance, so they
        // are grouped and kept close (the row head's own gap would push the
        // explanation too far from the thing it explains).
        <span className="preset-governed-switch">
          {/* The tip rides the wrapper too (the live branch's pattern), so
              hovering the switch itself explains it — a disabled control emits
              no pointer events of its own, so the controller's closest()
              lookup lands on this span or the track inside it. */}
          <span className="switch" data-tip={reason}>
            <input
              type="checkbox"
              className="switch-input"
              checked={prompt.enabled}
              disabled
              aria-label={`${rowLabel(prompt)} is switched by the ${controlLabel(governanceState.control)} control`}
            />
            <span className="switch-track">
              <span className="switch-thumb" />
            </span>
          </span>
          <button type="button" className="info-tip" aria-label={reason} data-tip={reason}>
            <Info size={13} aria-hidden="true" />
          </button>
        </span>
      );
    }
    return (
      // data-tip on the label: the hidden checkbox is its content, so the
      // controller's closest("[data-tip]") lookup from either pointer or
      // keyboard focus still finds the tip.
      <label className="switch" data-tip={FIELD_TIPS.enabled}>
        <input
          type="checkbox"
          className="switch-input"
          checked={prompt.enabled}
          aria-label={`Toggle ${rowLabel(prompt)}`}
          onChange={(event) => onToggle(event.currentTarget.checked)}
        />
        <span className="switch-track">
          <span className="switch-thumb" />
        </span>
      </label>
    );
  };

  /**
   * The group a row belongs to, as a small pill in its head so the
   * relationship stays legible in the list. Data-tip names the group (the
   * chooser above explains how it behaves); absent for ungrouped rows.
   */
  const groupBadge = (prompt: PresetPrompt): ReactNode =>
    prompt.group ? (
      <span
        className="preset-group-badge"
        data-tip={`Group: ${prompt.group.label}. Pick one option in the Groups control above.`}
      >
        {prompt.group.label}
      </span>
    ) : null;

  /**
   * The control that switches a row, as a small pill beside the group badge.
   * The two are different facts — membership is static metadata, governance is
   * who flips the flag — so a row carrying both shows both. The tip states the
   * consequence the badge alone cannot: because that control's choice decides
   * the row, the row's own switch is DISABLED (the switch renders right beside
   * this badge and now carries an Info button with the same sentence).
   */
  const controlBadge = (prompt: PresetPrompt): ReactNode => {
    const { control } = governance(prompt);
    if (!control) {
      return null;
    }
    return (
      <span
        className="preset-group-badge preset-control-badge"
        data-tip={governedBadgeTip(control)}
      >
        Control: {controlLabel(control)}
      </span>
    );
  };

  /** The trigger-gating checkboxes and any imported unknown trigger values. */
  const triggerControls = (prompt: PresetPrompt): ReactNode => {
    const unknown = uniqueUnknownTriggers(prompt);
    return (
      <div className="field preset-triggers">
        {labelWithTip("Generation types", FIELD_TIPS.injectionTrigger ?? "")}
        <div className="preset-trigger-chips">
          {TRIGGER_OPTIONS.map((option) => {
            const on = (prompt.injection_trigger ?? []).includes(option.id);
            return (
              <label key={option.id} className={cx("preset-trigger-option", on && "is-on")}>
                <input
                  type="checkbox"
                  className="preset-trigger-check"
                  checked={on}
                  onChange={(event) =>
                    patch(prompt.id, {
                      injection_trigger: setTrigger(
                        prompt.injection_trigger,
                        option.id,
                        event.currentTarget.checked,
                      ),
                    })
                  }
                />
                <span className="preset-trigger-label">{option.label}</span>
              </label>
            );
          })}
        </div>
        {/* Values from an imported ST preset (or a future trigger) that the
            checkboxes do not represent. Listed with a remove control so they are
            visible and can be cleared, never silently dropped on save. */}
        {unknown.length > 0 && (
          <div className="preset-trigger-unknown">
            <span className="caption muted">Imported, never matches a Suvoj run:</span>
            <Presence>
              {unknown.map((value) => (
                <motion.button
                  key={value}
                  type="button"
                  layout
                  className="chip preset-trigger-unknown-chip"
                  aria-label={`Remove trigger ${value}`}
                  data-tip="Click to remove this trigger value"
                  variants={riseVariants(app)}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  transition={app.reduce ? INSTANT : app.spring.snappy}
                  onClick={() =>
                    patch(prompt.id, {
                      injection_trigger: setTrigger(prompt.injection_trigger, value, false),
                    })
                  }
                >
                  {value}
                  <X size={12} aria-hidden="true" />
                </motion.button>
              ))}
            </Presence>
          </div>
        )}
        <span className="field-hint">
          {triggersAllTypes(prompt.injection_trigger)
            ? "Applies to every generation type."
            : "Only sent for the selected types."}
        </span>
      </div>
    );
  };

  /**
   * The entrance/exit variants for one pipeline row. Under reduced motion every
   * transition is `INSTANT` (via `withDelay`/`app.transition`), so the row still
   * lands — it just lands in one frame. The stagger is a per-index transition
   * delay rather than the Stagger container because each row sits inside its own
   * Reorder.Item, which breaks the container's direct-child sequencing.
   */
  const rowVariants = (index: number): MotionVariants => ({
    hidden: { opacity: 0, y: 8 },
    visible: {
      opacity: 1,
      y: 0,
      transition: app.withDelay(Math.min(index, 8) * 0.03),
    },
    exit: { opacity: 0, y: 4, transition: { ...app.transition, duration: app.duration.fast } },
  });

  /**
   * One pipeline row, as rendered inside ReorderableList's `.reorder-body`.
   * A marker slot (fixed position, ghost card) and a regular prompt share the
   * same outer shell; only identity chrome and the presence of a content body
   * differ. The row is a `motion.div` so the `Presence` wrapping it can play
   * the exit before `completeRemovePrompt` drops it from the list.
   */
  const renderPromptRow = (prompt: PresetPrompt, index: number): ReactNode => {
    const marker = prompt.marker;
    const isMarker = marker !== undefined;
    const expanded = expandedId === prompt.id;
    const nameError = prompt.name.trim() === "" ? "Give this prompt a name." : null;
    // A prefix row whose macros change every turn: the row stays usable, it
    // just cannot be cached. Reported inline so the fix lands where the text
    // is edited.
    const volatile = volatilePrefixById.get(prompt.id);
    const head = isMarker ? (
      <div className="preset-row-head">
        <span className="preset-marker-badge" data-tip={FIELD_TIPS.slot}>
          Slot
        </span>
        {groupBadge(prompt)}
        {controlBadge(prompt)}
        <div className="preset-row-main">
          <span className="preset-row-name">{rowLabel(prompt)}</span>
          <span className="preset-row-desc">{MARKER_INFO[marker].description}</span>
        </div>
        <div className="preset-row-actions">
          {enabledSwitch(prompt, (checked) => patch(prompt.id, { enabled: checked }))}
          {reorderButtons(prompt, index)}
          {carriesContent(prompt) && (
            <button
              type="button"
              className="btn btn-icon preset-expand"
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${rowLabel(prompt)}`}
              data-tip={expanded ? "Collapse" : "Expand"}
              onClick={() => toggleExpanded(prompt.id)}
            >
              <ChevronDown size={16} />
            </button>
          )}
        </div>
      </div>
    ) : (
      <div className="preset-row-head">
        {enabledSwitch(prompt, (checked) => patch(prompt.id, { enabled: checked }))}
        {groupBadge(prompt)}
        {controlBadge(prompt)}
        <input
          className="input preset-prompt-name"
          type="text"
          placeholder="Prompt name"
          aria-label={`Name of ${rowLabel(prompt)}`}
          aria-invalid={nameError !== null}
          value={prompt.name}
          onChange={(event) => patch(prompt.id, { name: event.currentTarget.value })}
        />
        <select
          className="select preset-prompt-role"
          aria-label={`Role of ${rowLabel(prompt)}`}
          data-tip={FIELD_TIPS.role}
          value={prompt.role}
          onChange={(event) =>
            patch(prompt.id, { role: event.currentTarget.value as PresetPromptRole })
          }
        >
          <option value="system">System</option>
          <option value="user">User</option>
          <option value="assistant">Assistant</option>
        </select>
        <div className="preset-row-actions">
          {reorderButtons(prompt, index)}
          <button
            type="button"
            className="btn btn-icon btn-danger"
            aria-label={`Delete ${rowLabel(prompt)}`}
            data-tip="Delete"
            onClick={() => removePrompt(prompt)}
          >
            <Trash2 size={16} />
          </button>
          <button
            type="button"
            className="btn btn-icon preset-expand"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${rowLabel(prompt)}`}
            data-tip={expanded ? "Collapse" : "Expand"}
            onClick={() => toggleExpanded(prompt.id)}
          >
            <ChevronDown size={16} />
          </button>
        </div>
      </div>
    );

    return (
      <Presence key={prompt.id} initial onExitComplete={() => completeRemovePrompt(prompt.id)}>
        {exitingId === prompt.id ? null : (
          <motion.div
            key={prompt.id}
            className={cx(
              "card preset-row",
              isMarker ? "preset-row-marker" : "preset-row-prompt",
              !prompt.enabled && "is-off",
            )}
            variants={rowVariants(index)}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {head}
            {nameError !== null && (
              <span className="field-error preset-row-error" role="alert">
                {nameError}
              </span>
            )}
            {volatile !== undefined && (
              <p className="preset-group-warn preset-row-warn" role="note">
                <TriangleAlert size={14} />
                {prefixWarningText(volatile.macros)}
              </p>
            )}
            {isMarker ? (
              // Only the two slots that carry text have a body; the rest render
              // their data and have nothing to disclose.
              carriesContent(prompt) && (
                <Collapsible open={expanded}>
                  <div className="preset-row-body">
                    <textarea
                      className="textarea preset-content"
                      rows={8}
                      aria-label={`${rowLabel(prompt)} content`}
                      placeholder={
                        marker === "main"
                          ? "The system prompt — the first thing the model reads."
                          : "Steering applied after the chat history."
                      }
                      value={prompt.content}
                      onChange={(event) => patch(prompt.id, { content: event.currentTarget.value })}
                    />
                  </div>
                </Collapsible>
              )
            ) : (
              <Collapsible open={expanded}>
                <div className="preset-row-body">
                  <textarea
                    className="textarea preset-content"
                    rows={8}
                    aria-label={`${rowLabel(prompt)} content`}
                    placeholder="The text this prompt sends"
                    value={prompt.content}
                    onChange={(event) => patch(prompt.id, { content: event.currentTarget.value })}
                  />
                  <details className="preset-advanced">
                    <summary>Advanced</summary>
                    <div className="preset-advanced-body">
                      <div className="field-grid">
                        <div className="field">
                          {fieldLabel(
                            `injection-${prompt.id}`,
                            "Injection",
                            FIELD_TIPS.injection ?? "",
                          )}
                          <select
                            id={`preset-field-injection-${prompt.id}`}
                            className="select"
                            value={String(prompt.injection_position)}
                            onChange={(event) =>
                              patch(prompt.id, {
                                injection_position: event.currentTarget.value === "1" ? 1 : 0,
                              })
                            }
                          >
                            <option value="0">In place</option>
                            <option value="1">In chat, depth</option>
                          </select>
                        </div>
                        {prompt.injection_position === 1 && (
                          <>
                            <div className="field">
                              {fieldLabel(`depth-${prompt.id}`, "Depth", FIELD_TIPS.depth ?? "")}
                              <input
                                id={`preset-field-depth-${prompt.id}`}
                                className="input"
                                type="number"
                                min="0"
                                step="1"
                                value={prompt.injection_depth}
                                aria-label={`${rowLabel(prompt)} injection depth`}
                                onChange={(event) =>
                                  patch(prompt.id, {
                                    injection_depth: Math.max(
                                      0,
                                      Math.floor(Number(event.currentTarget.value) || 0),
                                    ),
                                  })
                                }
                              />
                            </div>
                            <div className="field">
                              {fieldLabel(
                                `order-${prompt.id}`,
                                "Order",
                                FIELD_TIPS.injectionOrder ?? "",
                              )}
                              {/* Uncontrolled (defaultValue, not value):
                                  React reverts a controlled input whose
                                  onChange did not change state, which
                                  would erase the partial value ("", "-")
                                  this field deliberately leaves
                                  uncommitted. The committed integer stays
                                  the source of truth, and onBlur restores
                                  it when the field was left mid-edit. */}
                              <input
                                id={`preset-field-order-${prompt.id}`}
                                className="input"
                                type="number"
                                step="1"
                                defaultValue={prompt.injection_order}
                                aria-label={`${rowLabel(prompt)} injection order`}
                                onChange={(event) => {
                                  // Commit only a real integer: a partial
                                  // value leaves the draft untouched rather
                                  // than snapping the order to 0 mid-edit.
                                  // Negative orders are legal.
                                  const value = parseInteger(event.currentTarget.value);
                                  if (value !== null) {
                                    patch(prompt.id, { injection_order: value });
                                  }
                                }}
                                onBlur={(event) => {
                                  // Restore the committed value when the field
                                  // was left mid-edit (empty).
                                  event.currentTarget.value = String(prompt.injection_order);
                                }}
                              />
                            </div>
                          </>
                        )}
                      </div>
                      {triggerControls(prompt)}
                    </div>
                  </details>
                </div>
              </Collapsible>
            )}
          </motion.div>
        )}
      </Presence>
    );
  };

  /** One control's card: identity row plus a collapsible options body. */
  const renderControl = (control: PresetControl, index: number): ReactNode => {
    const key = keyOf(control);
    const idError = controlIdError(index);
    const optionProblem = controlOptionProblem(control);
    const open = !closedControls.has(key);
    const bodyId = `preset-control-body-${key}`;

    return (
      <motion.div
        key={key}
        layout
        className="card preset-control"
        variants={riseVariants(app)}
        initial="hidden"
        animate="visible"
        exit="exit"
        // popLayout (on the wrapping Presence) lifts the exiting card out of
        // flow, and this layout transition slides the survivors into the gap.
        transition={app.reduce ? INSTANT : app.spring.soft}
      >
        <div className="preset-control-head">
          <span className="preset-control-index" aria-hidden="true">
            {index + 1}
          </span>
          <input
            className="input preset-control-id"
            type="text"
            placeholder="id"
            aria-label={`Id of control ${index + 1}`}
            data-tip={FIELD_TIPS.controlId}
            value={control.id}
            onChange={(event) => patchControl(index, { id: event.currentTarget.value })}
          />
          <input
            className="input preset-control-label"
            type="text"
            placeholder="Label shown to users"
            aria-label={`Label of control ${index + 1}`}
            data-tip={FIELD_TIPS.controlLabel}
            value={control.label}
            onChange={(event) => patchControl(index, { label: event.currentTarget.value })}
          />
          <select
            className="select preset-control-type"
            aria-label={`Type of control ${index + 1}`}
            data-tip={FIELD_TIPS.controlType}
            value={control.type}
            onChange={(event) =>
              patchControl(index, { type: event.currentTarget.value as PresetControlType })
            }
          >
            <option value="select">Dropdown</option>
            <option value="toggle">On/off switch</option>
          </select>
          <div className="preset-row-actions">
            <button
              type="button"
              className="btn btn-icon"
              aria-label={`Move control ${control.id || index + 1} up`}
              data-tip="Move up"
              disabled={index === 0}
              onClick={() => moveControl(index, -1)}
            >
              <ChevronUp size={16} />
            </button>
            <button
              type="button"
              className="btn btn-icon"
              aria-label={`Move control ${control.id || index + 1} down`}
              data-tip="Move down"
              disabled={index === controls.length - 1}
              onClick={() => moveControl(index, 1)}
            >
              <ChevronDown size={16} />
            </button>
            <button
              type="button"
              className="btn btn-icon btn-danger"
              aria-label={`Delete control ${control.id || index + 1}`}
              data-tip="Delete"
              onClick={() => removeControl(control, index)}
            >
              <Trash2 size={16} />
            </button>
            <button
              type="button"
              className="btn btn-icon preset-expand"
              aria-expanded={open}
              aria-controls={bodyId}
              aria-label={`${open ? "Collapse" : "Expand"} control ${control.id || index + 1}`}
              data-tip={open ? "Collapse options" : "Expand options"}
              onClick={() => toggleControl(key)}
            >
              <ChevronDown size={16} />
            </button>
          </div>
        </div>

        {/* Live id validation, in the same place and shape as the Generation
            integers' errors: the id is what a stored choice keys on, so a bad
            one cannot wait until Save. */}
        {idError !== null && (
          <span className="field-error" role="alert">
            {idError}
          </span>
        )}

        {/* The engine DROPS a control it cannot render (fewer than two
            options, a blank/duplicate option id, a toggle with extra options).
            Save is already blocked; this names which rule broke so the user can
            fix it instead of hunting a disabled button. Kept outside the
            disclosure so a collapsed card still reports its problem. */}
        {optionProblem !== null && (
          <span className="field-error" role="alert">
            {optionProblem}
          </span>
        )}

        <Collapsible id={bodyId} open={open}>
          <div className="preset-control-body">
            <div className="field">
              {fieldLabel(
                `control-description-${index}`,
                "Description (optional)",
                FIELD_TIPS.controlDescription ?? "",
              )}
              <input
                id={`preset-field-control-description-${index}`}
                className="input"
                value={control.description}
                placeholder="Shown under the switcher on the Presets page"
                onChange={(event) =>
                  patchControl(index, { description: event.currentTarget.value })
                }
              />
            </div>

            <div className="preset-control-options-head">
              {labelWithTip("Options", FIELD_TIPS.controlOptions ?? "")}
              {/* Prefill from a group's members: the fast path for the common
                  case (a Point-of-view group becomes a Point-of-view
                  switcher), offered only when the pipeline defines groups. */}
              {groupIds.length > 0 && (
                <select
                  className="select preset-control-link-group"
                  aria-label={`Link a group's options into control ${control.id || index + 1}`}
                  data-tip={FIELD_TIPS.controlLinkGroup}
                  value=""
                  onChange={(event) => {
                    linkGroup(index, event.currentTarget.value);
                  }}
                >
                  <option value="">Link a group…</option>
                  {groupIds.map((groupId) => (
                    <option key={groupId} value={groupId}>
                      {findGroup(prompts, groupId)?.label ?? groupId}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="preset-control-options">
              <Presence mode="popLayout">
                {control.options.map((option, optionIndex) => (
                  <motion.div
                    layout
                    className="preset-control-option"
                    key={keyOf(option)}
                    variants={riseVariants(app)}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    transition={app.reduce ? INSTANT : app.spring.soft}
                  >
                    <div className="preset-control-option-row">
                      <input
                        className="input preset-control-option-id"
                        type="text"
                        placeholder="id"
                        aria-label={`Option ${optionIndex + 1} id of control ${control.id || index + 1}`}
                        data-tip={FIELD_TIPS.controlOptions}
                        value={option.id}
                        onChange={(event) =>
                          patchOption(index, optionIndex, {
                            id: event.currentTarget.value,
                          })
                        }
                      />
                      <input
                        className="input preset-control-option-label"
                        type="text"
                        placeholder="Label shown to users"
                        aria-label={`Option ${optionIndex + 1} label of control ${control.id || index + 1}`}
                        value={option.label}
                        onChange={(event) =>
                          patchOption(index, optionIndex, {
                            label: event.currentTarget.value,
                          })
                        }
                      />
                      <div className="preset-row-actions">
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label={`Move option ${optionIndex + 1} up`}
                          data-tip="Move up"
                          disabled={optionIndex === 0}
                          onClick={() => moveOption(index, optionIndex, -1)}
                        >
                          <ChevronUp size={16} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label={`Move option ${optionIndex + 1} down`}
                          data-tip="Move down"
                          disabled={optionIndex === control.options.length - 1}
                          onClick={() => moveOption(index, optionIndex, 1)}
                        >
                          <ChevronDown size={16} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon btn-danger"
                          aria-label={`Delete option ${optionIndex + 1}`}
                          data-tip="Delete"
                          onClick={() => removeOption(index, optionIndex)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                    <div className="preset-control-option-value">
                      <div className="field">
                        {fieldLabel(
                          `control-value-${index}-${optionIndex}`,
                          "Macro value",
                          FIELD_TIPS.controlMacro ?? "",
                        )}
                        <input
                          id={`preset-field-control-value-${index}-${optionIndex}`}
                          className="input"
                          value={option.value}
                          placeholder={optionLabel(option)}
                          onChange={(event) =>
                            patchOption(index, optionIndex, {
                              value: event.currentTarget.value,
                            })
                          }
                        />
                      </div>
                      <div className="field preset-control-option-prompts">
                        <div className="field-label-row">
                          <span className="field-label">Switches on</span>
                          <button
                            type="button"
                            className="info-tip"
                            aria-label={FIELD_TIPS.controlPrompts ?? ""}
                            data-tip={FIELD_TIPS.controlPrompts}
                          >
                            <Info size={13} aria-hidden="true" />
                          </button>
                        </div>
                        {/* The current pipeline rows, as a compact scrollable
                            checkbox list: long pipelines stay usable, and a row
                            that has been deleted simply disappears from here. */}
                        <div className="preset-control-prompt-list">
                          {prompts.map((prompt) => (
                            <label className="preset-control-prompt" key={prompt.id}>
                              <input
                                type="checkbox"
                                className="preset-trigger-check"
                                aria-label={`Switch on ${rowLabel(prompt)} for option ${optionIndex + 1}`}
                                checked={option.prompts.includes(prompt.id)}
                                onChange={(event) =>
                                  setOptionPrompt(
                                    index,
                                    optionIndex,
                                    prompt.id,
                                    event.currentTarget.checked,
                                  )
                                }
                              />
                              <span className="preset-control-prompt-name">{rowLabel(prompt)}</span>
                              {/* The id, dimmed: it is what a stored
                                  choice stores, so a hand-editor can
                                  match a row here to one in the JSON. */}
                              <code className="preset-control-prompt-id">{prompt.id}</code>
                            </label>
                          ))}
                        </div>
                        {/* Ids the picker cannot show (a hand-edited or deleted
                            row) are surfaced rather than silently dropped on
                            save. */}
                        {option.prompts.some(
                          (id) => !prompts.some((prompt) => prompt.id === id),
                        ) && (
                          <span className="field-hint">
                            {option.prompts
                              .filter((id) => !prompts.some((prompt) => prompt.id === id))
                              .join(", ")}{" "}
                            — no matching pipeline row.
                          </span>
                        )}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </Presence>
            </div>

            <div className="preset-control-foot">
              <button
                type="button"
                className="btn preset-control-add-option"
                data-tip={
                  control.type === "toggle" && control.options.length >= 2
                    ? "An on/off switch uses exactly two options."
                    : FIELD_TIPS.controlAdd
                }
                disabled={control.type === "toggle" && control.options.length >= 2}
                onClick={() => addOption(index)}
              >
                <Plus size={16} />
                Add option
              </button>
              <div className="field preset-control-default">
                {fieldLabel(
                  `control-default-${index}`,
                  "Default choice",
                  FIELD_TIPS.controlDefault ?? "",
                )}
                <select
                  id={`preset-field-control-default-${index}`}
                  className="select"
                  value={control.default}
                  onChange={(event) => patchControl(index, { default: event.currentTarget.value })}
                >
                  <option value="">First option</option>
                  {control.options.map((option) => (
                    <option key={keyOf(option)} value={option.id}>
                      {optionLabel(option)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </Collapsible>
      </motion.div>
    );
  };

  const enabledCount = prompts.filter((prompt) => prompt.enabled).length;

  return (
    <>
      <Modal
        title={props.preset === null ? "New preset" : `Edit ${props.preset.name}`}
        wide
        onClose={props.onClose}
      >
        <form
          className="preset-editor stack"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          {/* Sticky header: identity, dirty/valid state, and the save actions.
            The Modal's own title bar scrolls away with the body, so this bar is
            what keeps Save reachable at the bottom of a long pipeline. */}
          <header className="preset-editor-head">
            <div className="preset-editor-fields field-grid">
              <div className="field">
                {fieldLabel("name", "Name", FIELD_TIPS.name ?? "")}
                <input
                  id="preset-field-name"
                  className="input"
                  value={name}
                  aria-invalid={name.trim() === ""}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
                {name.trim() === "" && (
                  <span className="field-error" role="alert">
                    A preset needs a name.
                  </span>
                )}
              </div>
              <div className="field">
                {fieldLabel("description", "Description", FIELD_TIPS.description ?? "")}
                <input
                  id="preset-field-description"
                  className="input"
                  placeholder="What this preset is for"
                  value={description}
                  onChange={(event) => setDescription(event.currentTarget.value)}
                />
              </div>
            </div>

            <div className="preset-editor-status">
              <div className="preset-editor-badges">
                {/* The dirty state reads in both directions: a badge while there
                  is something to write, quiet copy once there is not. */}
                {dirty ? (
                  <span className="badge">Unsaved changes</span>
                ) : (
                  <span className="caption muted">
                    {props.preset === null ? "New preset" : "Saved"}
                  </span>
                )}
                <span className={cx("badge", invalid ? "badge-warning" : "badge-success")}>
                  {invalid ? (
                    <TriangleAlert size={12} aria-hidden="true" />
                  ) : (
                    <Check size={12} aria-hidden="true" />
                  )}
                  {invalid ? `${problemCount} to fix` : "Valid"}
                </span>
              </div>
              <PresetEditorActions saving={saving} invalid={invalid} />
            </div>
          </header>

          <PresetSection
            id="generation"
            title="Generation"
            tip={FIELD_TIPS.generation}
            meta="Engine settings"
            open={sections.generation}
            onToggle={() => toggleSection("generation")}
          >
            <p className="caption muted">
              How the prompt is assembled: how far the lorebook scans, how many lorebook tokens may
              enter one prompt, and the wrappers around character data. These are not pipeline rows,
              so they have no position in the list.
            </p>
            <div className="field-grid">
              <div className="field">
                {fieldLabel("scan-depth", "World info scan depth", FIELD_TIPS.scanDepth ?? "")}
                <input
                  id="preset-field-scan-depth"
                  className="input"
                  type="number"
                  min="1"
                  step="1"
                  value={settings.scan_depth}
                  aria-invalid={!validScanDepth}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      scan_depth: event.currentTarget.value,
                    }))
                  }
                />
                {!validScanDepth && (
                  <span className="field-error" role="alert">
                    Enter a whole number of at least 1.
                  </span>
                )}
              </div>
              <div className="field">
                {fieldLabel("wi-budget", "World info budget (tokens)", FIELD_TIPS.wiBudget ?? "")}
                <input
                  id="preset-field-wi-budget"
                  className="input"
                  type="number"
                  min="0"
                  step="1"
                  value={settings.wi_budget}
                  aria-invalid={!validWiBudget}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, wi_budget: event.currentTarget.value }))
                  }
                />
                {!validWiBudget && (
                  <span className="field-error" role="alert">
                    Enter a whole number of 0 or more.
                  </span>
                )}
              </div>
            </div>
            <div className="field-grid">
              <div className="field">
                {fieldLabel("new-chat", "New chat prompt", FIELD_TIPS.newChatPrompt ?? "")}
                <input
                  id="preset-field-new-chat"
                  className="input"
                  value={settings.new_chat_prompt}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      new_chat_prompt: event.currentTarget.value,
                    }))
                  }
                />
              </div>
              <div className="field">
                {fieldLabel(
                  "new-example-chat",
                  "New example chat prompt",
                  FIELD_TIPS.newExampleChatPrompt ?? "",
                )}
                <input
                  id="preset-field-new-example-chat"
                  className="input"
                  value={settings.new_example_chat_prompt}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      new_example_chat_prompt: event.currentTarget.value,
                    }))
                  }
                />
              </div>
              <div className="field">
                {fieldLabel(
                  "personality-format",
                  "Personality format",
                  FIELD_TIPS.personalityFormat ?? "",
                )}
                <input
                  id="preset-field-personality-format"
                  className="input"
                  value={settings.personality_format}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      personality_format: event.currentTarget.value,
                    }))
                  }
                />
              </div>
              <div className="field">
                {fieldLabel("scenario-format", "Scenario format", FIELD_TIPS.scenarioFormat ?? "")}
                <input
                  id="preset-field-scenario-format"
                  className="input"
                  value={settings.scenario_format}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      scenario_format: event.currentTarget.value,
                    }))
                  }
                />
              </div>
            </div>
          </PresetSection>

          <PresetSection
            id="prompts"
            title="Prompts"
            tip={FIELD_TIPS.pipeline}
            meta={`${prompts.length} rows · ${enabledCount} on`}
            open={sections.prompts}
            onToggle={() => toggleSection("prompts")}
          >
            <p className="caption muted">
              The generation flow, top to bottom: the model receives these rows in list order. Drag
              a row's grip to reorder it, or use the arrow buttons — order IS generation order.
            </p>

            {/* Collapsible reference for the model of the pipeline. Folded by
              default so the editor opens straight onto the rows. */}
            <details className="preset-advanced">
              <summary>How the pipeline works</summary>
              <div className="preset-advanced-body">
                <p className="caption muted">
                  The pipeline is the whole prompt the model receives, assembled in list order — the
                  top row is read first and the bottom row last. Slot rows are fixed positions the
                  engine fills with its own data; regular prompts send their own text.
                </p>
                <p className="caption muted">
                  <strong>Slot</strong> rows are fixed positions. The engine fills each one with its
                  own data — the character card, persona, lorebook entries, the chat history — so
                  they have no text of their own. The Main prompt and Post-history instructions are
                  the exception: those two slots hold your own text.
                </p>
                <p className="caption muted">
                  By default a prompt renders where it sits in the list. Switching its Advanced
                  injection to <strong>In chat, depth</strong> instead hides it from that position
                  and drops it inside the chat history, counting back from the newest message. That
                  needs a Chat history slot to land in; without one the injection is dropped.
                </p>
              </div>
            </details>

            {!hasChatHistory && (
              <p className="warn-banner" role="note">
                <TriangleAlert size={16} />
                Without the Chat history slot the model won't see the conversation.
              </p>
            )}

            {/* Prefix-cache warning, one line naming the offending rows. Each of
              them also carries the explanation inline, where its text is
              edited; this banner exists so a user scrolling the pipeline sees
              the problem without expanding every row. */}
            {volatilePrefix.length > 0 && (
              <p className="warn-banner" role="note">
                <TriangleAlert size={16} />
                {volatilePrefix.length === 1
                  ? `"${volatilePrefix[0]?.label}" changes on every turn, so the prompt prefix can never be cached.`
                  : `${volatilePrefix.length} prompts above the chat history change on every turn, so the prompt prefix can never be cached.`}{" "}
                Open the row to see which macros.
              </p>
            )}

            {/* Groups are alternatives, not additions: one control picks the
              active option and switches its siblings off, so the pipeline can
              never end up with two members of the same group on at once.
              Ungrouped presets render nothing here. A hand-edited preset with
              zero or several members on is shown as an explicit "not set"
              state, never silently resolved. */}
            {groupIds.length > 0 && (
              <div className="preset-groups">
                {labelWithTip("Groups", FIELD_TIPS.groups ?? "")}
                <p className="caption muted">
                  Options that are alternatives. Picking one switches the others off.
                </p>
                <div className="preset-group-list">
                  {groupIds.map((groupId) => (
                    <GroupRow
                      key={groupId}
                      groupId={groupId}
                      prompts={prompts}
                      rowLabel={rowLabel}
                      onChoose={chooseGroupMember}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="preset-pipeline">
              <ReorderableList
                items={prompts}
                // A drop landing while a delete animation is in flight would
                // otherwise re-introduce the exiting row, so it is filtered out
                // of the reordered copy like `completeRemovePrompt` would.
                onReorder={(next) =>
                  setPrompts(exitingId === null ? next : next.filter((p) => p.id !== exitingId))
                }
                getKey={(prompt) => prompt.id}
                ariaLabel="Prompt pipeline"
                className="preset-pipeline-reorder"
              >
                {renderPromptRow}
              </ReorderableList>
              <button
                type="button"
                className="btn preset-add"
                data-tip={FIELD_TIPS.addPrompt}
                onClick={addPrompt}
              >
                <Plus size={16} />
                Add prompt
              </button>
            </div>
          </PresetSection>

          <PresetSection
            id="controls"
            title="Controls"
            tip={FIELD_TIPS.controls}
            meta={`${controls.length} ${controls.length === 1 ? "control" : "controls"}`}
            open={sections.controls}
            onToggle={() => toggleSection("controls")}
          >
            <p className="caption muted">
              Switchers your preset's users flip from the Presets page without opening this editor.
              Choosing an option switches that option's prompt rows on and every other option's rows
              off, and <code>{"{{ui:<control id>}}"}</code> in prompt text expands to the chosen
              option's value.
            </p>
            <p className="caption muted">
              A row a control names is switched by that control's choice, so it has no switch of its
              own — the editor disables it and names the control. Such a row should still not also
              sit in a group: the group chooser above could then look like it disagrees with what
              the row actually sends.
            </p>

            {controls.length > 0 ? (
              <div className="preset-control-list">
                {/* popLayout lifts an exiting control out of flow so the ones
                  below slide up while it fades. */}
                <Presence mode="popLayout">{controls.map(renderControl)}</Presence>
              </div>
            ) : (
              <p className="caption muted">
                No controls yet. Add one to let users switch a set of rows from the Presets page.
              </p>
            )}

            <button
              type="button"
              className="btn preset-add"
              data-tip={FIELD_TIPS.addControl}
              onClick={addControl}
            >
              <Plus size={16} />
              Add control
            </button>
          </PresetSection>

          {error !== null && (
            <p className="error-banner" role="alert">
              <TriangleAlert size={16} />
              {error}
            </p>
          )}
        </form>
      </Modal>
      {dialog}
    </>
  );
}
