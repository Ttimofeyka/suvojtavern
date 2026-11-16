/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router";
import GalleryPanel from "../components/characters/GalleryPanel";
import MacrosGuideModal from "../components/characters/MacrosGuideModal";
import StudioAiGenerateModal from "../components/studio/StudioAiGenerateModal";
import StudioEnhanceModal from "../components/studio/StudioEnhanceModal";
import StudioPreview from "../components/studio/StudioPreview";
import StudioStart, { type StudioResumeInfo } from "../components/studio/StudioStart";
import { AppLink } from "../components/ui/AppLink";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import { Collapsible } from "../components/ui/collapsible";
import {
  ArrowRight,
  BookMarked,
  Check,
  ChevronDown,
  ChevronLeft,
  Drama,
  FileImage,
  FileJson,
  Image,
  Sparkles,
  Tag,
  Trash2,
  TriangleAlert,
  Upload,
  WandSparkles,
  X,
} from "../components/ui/icons";
import Modal from "../components/ui/Modal";
import { Presence } from "../components/ui/presence";
import { ApiError, blobUrl } from "../lib/api";
import type { CharacterFieldKey, SeedFieldKey } from "../lib/api-character-generation";
import { CHARACTER_FIELD_LABELS, generateCharacterSeed } from "../lib/api-character-generation";
import type { Character, CharacterListItem } from "../lib/api-characters";
import {
  createCharacter,
  getCharacter,
  setCharacterImage,
  updateCharacter,
  uploadImage,
} from "../lib/api-characters";
import type { Lorebook } from "../lib/api-lorebooks";
import {
  attachLorebook,
  detachLorebook,
  listCharacterLorebooks,
  listLorebooks,
} from "../lib/api-lorebooks";
import { exportCardUrl } from "../lib/api-transfer";
import { cx } from "../lib/cx";
import { INSTANT, riseVariants, scaleVariants, useAppMotion } from "../lib/motion";
import type { StudioDraft } from "../lib/studio-draft";
import {
  applyGeneratedFields,
  coerceStudioDraft,
  countWords,
  draftContext,
  draftFromCharacter,
  draftStats,
  draftsEqual,
  draftToInput,
  emptyStudioDraft,
  writeField,
} from "../lib/studio-draft";
import { useCharacterGenerationConfig } from "../stores/ai-generation";
import "../styles/studio.css";

/** The five editorial stops in the studio. */
type StepKey = "identity" | "persona" | "world" | "voice" | "release";

interface StepDef {
  key: StepKey;
  label: string;
  sub: string;
  title: string;
  desc: string;
}

const IDENTITY_STEP: StepDef = {
  key: "identity",
  label: "Identity",
  sub: "Name & portrait",
  title: "Who is arriving?",
  desc: "The name, the tags that set the mood, and the face the card will wear.",
};

const STEPS: readonly StepDef[] = [
  IDENTITY_STEP,
  {
    key: "persona",
    label: "Persona",
    sub: "Description",
    title: "What are they like?",
    desc: "The description is the world; the personality is the person standing in it.",
  },
  {
    key: "world",
    label: "World",
    sub: "Scenario & voice",
    title: "Where does this begin?",
    desc: "The scenario sets the stage, and example dialogue teaches the model the rhythm.",
  },
  {
    key: "voice",
    label: "Voice",
    sub: "Greetings",
    title: "How do they open?",
    desc: "The first message and every alternate greeting the chat can swipe to.",
  },
  {
    key: "release",
    label: "Release",
    sub: "Notes & export",
    title: "Ready for the cast?",
    desc: "Author notes, advanced prompt overrides, and the card's PNG and JSON export.",
  },
];

const STEP_KEYS: readonly StepKey[] = STEPS.map((step) => step.key);

/**
 * The seed entry opens the SAME five-step editor. Only the first step's framing
 * changes: it leads with a freeform premise and the card fields, instead of
 * pretending the name is the only place to start.
 */
const SEED_STEPS: readonly StepDef[] = STEPS.map((step) =>
  step.key === "identity"
    ? {
        ...step,
        title: "What are you seeding?",
        desc: "Start with a premise, then fill what you know or mark a field for the AI. The card in the corner updates as you work.",
      }
    : step,
);

/** Which step owns each AI-markable field, for the rail's sparkle badge. */
const SEED_FIELD_STEP: Record<SeedFieldKey, StepKey> = {
  name: "identity",
  tags: "identity",
  description: "persona",
  personality: "persona",
  scenario: "world",
  mes_example: "world",
  first_mes: "voice",
  alternate_greetings: "voice",
  creator_notes: "release",
};

/** Where the draft came from, shown on the preview and in the topbar. */
type StudioSource =
  | { kind: "blank" }
  | { kind: "edit"; name: string }
  | { kind: "remix"; name: string }
  | { kind: "seed" };

/** The URL-driven load state for /characters/studio/:characterId. */
type RouteStatus = "ready" | "loading" | "error";

/** What a sessionStorage round-trip preserves. */
interface StoredStudio {
  draft: StudioDraft;
  baseline: StudioDraft;
  characterId: string | null;
  source: StudioSource;
  step: StepKey;
  /** The seed premise is not a card field, but it is AI context worth keeping. */
  seedNotes: string;
}

const STORAGE_KEY = "suvoj.studio.draft.v1";

/**
 * Stable ids for alternate greeting rows. The draft keeps greetings as plain
 * strings, so an index key would follow a removal onto the next row and remount
 * its textarea; these ids travel with the row instead.
 */
let alternateKeySeq = 0;

function makeAlternateKeys(count: number): string[] {
  return Array.from({ length: count }, () => `alt-${alternateKeySeq++}`);
}

function isStep(value: unknown): value is StepKey {
  return typeof value === "string" && STEP_KEYS.includes(value as StepKey);
}

function isSource(value: unknown): value is StudioSource {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "blank" || record.kind === "seed") {
    return true;
  }
  if (record.kind === "edit" || record.kind === "remix") {
    return typeof record.name === "string";
  }
  return false;
}

/** Restores a session draft; anything malformed is discarded. */
function readStoredStudio(): StoredStudio | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const draft = coerceStudioDraft(parsed.draft);
    const baseline = coerceStudioDraft(parsed.baseline);
    if (draft === null || baseline === null) {
      return null;
    }
    return {
      draft,
      baseline,
      characterId: typeof parsed.characterId === "string" ? parsed.characterId : null,
      source: isSource(parsed.source) ? parsed.source : { kind: "blank" },
      step: isStep(parsed.step) ? parsed.step : "identity",
      seedNotes: typeof parsed.seedNotes === "string" ? parsed.seedNotes : "",
    };
  } catch {
    return null;
  }
}

function removeStoredStudio(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // session storage unavailable — the in-memory draft still works.
  }
}

/** The inline controls that mark a field for the batch AI pass. */
interface AiMarkProps {
  marked: boolean;
  onToggle: () => void;
  direction: string;
  onDirectionChange: (value: string) => void;
}

/** A compact toggle in a field header; the direction panel follows it. */
function AiMarkButton(props: {
  marked: boolean;
  onToggle: () => void;
  label: string;
}): ReactElement {
  return (
    <button
      type="button"
      className={cx("studio-ai-mark", props.marked && "is-on")}
      aria-pressed={props.marked}
      aria-label={
        props.marked
          ? `Remove the AI mark from ${props.label}`
          : `Mark ${props.label} for AI generation`
      }
      data-tip={props.marked ? "AI will write this field" : "Mark for AI"}
      onClick={props.onToggle}
    >
      <WandSparkles size={13} aria-hidden="true" />
      <span>AI</span>
    </button>
  );
}

/** Optional guidance for one marked field; never saved to the card. */
function AiDirection(props: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  hint: string;
}): ReactElement {
  return (
    <div className="studio-ai-direction">
      <label className="studio-ai-direction-label" htmlFor={props.id}>
        <WandSparkles size={12} aria-hidden="true" />
        AI direction <span>optional</span>
      </label>
      <textarea
        id={props.id}
        className="textarea studio-ai-direction-input"
        rows={2}
        value={props.value}
        placeholder="Tone, a beat, a constraint, or anything to keep."
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
      <span className="field-hint">{props.hint}</span>
    </div>
  );
}

/** One labelled field with a counter and an optional AI action. */
function StudioField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint: string;
  rows?: number;
  input?: boolean;
  name?: boolean;
  placeholder?: string;
  aiEnabled: boolean;
  onEnhance?: () => void;
  aiMark?: AiMarkProps;
}): ReactElement {
  const app = useAppMotion();
  const verb = props.value.trim() === "" ? "Generate" : "Enhance";
  return (
    <div
      className={cx(
        "studio-field",
        props.name === true && "is-name",
        props.aiMark?.marked === true && "is-ai",
      )}
    >
      <div className="studio-field-head">
        <label className="studio-field-label" htmlFor={props.id}>
          {props.label}
        </label>
        <div className="studio-field-actions">
          {props.aiMark !== undefined && (
            <AiMarkButton
              marked={props.aiMark.marked}
              onToggle={props.aiMark.onToggle}
              label={props.label.toLowerCase()}
            />
          )}
          {props.aiEnabled && props.onEnhance !== undefined && (
            <button type="button" className="studio-ai-btn" onClick={props.onEnhance}>
              <Sparkles size={14} />
              {verb}
            </button>
          )}
        </div>
      </div>
      <Presence initial={false}>
        {props.aiMark?.marked === true && (
          <motion.div
            key="ai-direction"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={app.reduce ? INSTANT : app.transition}
          >
            <AiDirection
              id={`${props.id}-ai-direction`}
              value={props.aiMark.direction}
              onChange={props.aiMark.onDirectionChange}
              hint="The AI replaces this field. Its current text and this direction guide the next pass."
            />
          </motion.div>
        )}
      </Presence>
      {props.input === true ? (
        <input
          id={props.id}
          className="input studio-input studio-input-name"
          value={props.value}
          placeholder={props.placeholder}
          autoComplete="off"
          onChange={(event) => props.onChange(event.currentTarget.value)}
        />
      ) : (
        <textarea
          id={props.id}
          className="textarea studio-textarea"
          rows={props.rows ?? 5}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(event) => props.onChange(event.currentTarget.value)}
        />
      )}
      <div className="studio-field-foot">
        <span className="studio-field-hint">{props.hint}</span>
        <span className="studio-field-count tnum">
          {props.input === true
            ? `${props.value.length.toLocaleString()} chars`
            : `${countWords(props.value)} words · ${props.value.length.toLocaleString()} chars`}
        </span>
      </div>
    </div>
  );
}

/** Chip-style tag editor; commits on Enter, comma, or blur. */
function StudioTags(props: {
  tags: string[];
  onChange: (tags: string[]) => void;
  aiMark?: AiMarkProps;
}): ReactElement {
  const app = useAppMotion();
  const [input, setInput] = useState("");

  const commit = (raw: string): void => {
    const tag = raw.trim();
    setInput("");
    if (tag === "" || props.tags.includes(tag)) {
      return;
    }
    props.onChange([...props.tags, tag]);
  };

  const remove = (tag: string): void => {
    props.onChange(props.tags.filter((item) => item !== tag));
  };

  return (
    <div className={cx("studio-field studio-tags-field", props.aiMark?.marked === true && "is-ai")}>
      <div className="studio-field-head">
        <label className="studio-field-label" htmlFor="studio-tag-input">
          Tags
        </label>
        <div className="studio-field-actions">
          {props.aiMark !== undefined && (
            <AiMarkButton
              marked={props.aiMark.marked}
              onToggle={props.aiMark.onToggle}
              label="tags"
            />
          )}
          <span className="studio-field-count tnum">
            {props.tags.length} tag{props.tags.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
      <Presence initial={false}>
        {props.aiMark?.marked === true && (
          <motion.div
            key="tags-ai-direction"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={app.reduce ? INSTANT : app.transition}
          >
            <AiDirection
              id="studio-tags-ai-direction"
              value={props.aiMark.direction}
              onChange={props.aiMark.onDirectionChange}
              hint="The AI picks the tags. Your tags and this direction guide the next pass."
            />
          </motion.div>
        )}
      </Presence>
      <div className="studio-tags">
        <Presence>
          {props.tags.map((tag) => (
            <motion.span
              className="studio-tag"
              key={tag}
              layout
              variants={scaleVariants(app, 0.85)}
              initial="hidden"
              animate="visible"
              exit="exit"
              transition={app.reduce ? INSTANT : app.spring.snappy}
            >
              <Tag size={12} aria-hidden="true" />
              <span className="studio-tag-text">{tag}</span>
              <button
                type="button"
                className="studio-tag-remove"
                aria-label={`Remove tag ${tag}`}
                onClick={() => remove(tag)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </motion.span>
          ))}
        </Presence>
        <input
          id="studio-tag-input"
          className="input studio-tag-input"
          value={input}
          placeholder={props.tags.length === 0 ? "Add a tag…" : "Add…"}
          onChange={(event) => setInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              commit(input);
              return;
            }
            if (event.key === "Backspace" && input === "" && props.tags.length > 0) {
              const last = props.tags[props.tags.length - 1];
              if (last !== undefined) {
                remove(last);
              }
            }
          }}
          onBlur={() => commit(input)}
        />
      </div>
      <div className="studio-field-foot">
        <span className="studio-field-hint">
          Enter or comma to add. Tags are the card's quickest mood signal.
        </span>
      </div>
    </div>
  );
}

/**
 * Character Studio: a full-screen creation workspace launched from the
 * Characters tab. The start screen offers a blank draft, an existing card
 * (continue or remix), and a seed entry. All three land in the same five-step
 * editor: the seed entry adds a premise field and every editor field can be
 * marked for one batch AI pass (with an optional direction per field).
 */
export default function CharacterStudio() {
  const navigate = useNavigate();
  const { characterId: routeCharacterId } = useParams<{ characterId: string }>();
  const app = useAppMotion();
  const charGen = useCharacterGenerationConfig();
  const canvasRef = useRef<HTMLElement | null>(null);
  const portraitInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);

  const [mode, setMode] = useState<"start" | "edit">(() =>
    routeCharacterId === "new" ? "edit" : "start",
  );
  const [routeStatus, setRouteStatus] = useState<RouteStatus>(() =>
    routeCharacterId !== undefined && routeCharacterId !== "new" ? "loading" : "ready",
  );
  const [routeError, setRouteError] = useState<string | null>(null);
  // A retry re-runs the URL load without changing the parameter.
  const [routeAttempt, setRouteAttempt] = useState(0);
  // The ID whose save already populated the draft; the route effect must not
  // fetch and overwrite that state when the URL adopts the new ID.
  const skipRouteLoadRef = useRef<string | null>(null);
  // `/characters/studio/new` starts blank once per visit; direct entry is
  // already initialized above, so this only guards a later navigation into it.
  const handledNewRouteRef = useRef<string | null>(routeCharacterId === "new" ? "new" : null);
  const routeIdRef = useRef<string | undefined>(routeCharacterId);
  routeIdRef.current = routeCharacterId;
  const [closing, setClosing] = useState(false);
  const [storedResume, setStoredResume] = useState<StoredStudio | null>(() =>
    // A direct blank draft starts clean; a resume banner belongs to the studio
    // landing screen, not to /characters/studio/new.
    routeCharacterId === "new" ? null : readStoredStudio(),
  );
  const [draft, setDraft] = useState<StudioDraft>(() => emptyStudioDraft());
  const [baseline, setBaseline] = useState<StudioDraft>(() => emptyStudioDraft());
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [source, setSource] = useState<StudioSource>({ kind: "blank" });
  const [step, setStep] = useState<StepKey>("identity");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [enhanceField, setEnhanceField] = useState<CharacterFieldKey | null>(null);
  const [avatarBase, setAvatarBase] = useState<string | null>(null);
  const [pendingAvatar, setPendingAvatar] = useState<{ file: File; url: string } | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [alternateKeys, setAlternateKeys] = useState<string[]>([]);
  // Direction of the current step change, so the outgoing step leaves toward
  // the side the user is travelling and the incoming one arrives from it.
  const [stepDirection, setStepDirection] = useState<1 | -1>(1);
  /** The full row behind an edit/remix, kept for the gallery and avatar. */
  const [loadedCharacter, setLoadedCharacter] = useState<Character | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [macrosOpen, setMacrosOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** Which pending navigation is asking for an animated confirmation. */
  const [confirmAction, setConfirmAction] = useState<"leave" | "another" | null>(null);

  // Lorebook links. `selected` is what the next save should converge to;
  // `attached` is the last known server truth and the detach baseline. For a
  // brand-new card both start empty and the sync runs after the card exists.
  const [allLorebooks, setAllLorebooks] = useState<Lorebook[]>([]);
  const [lorebooksLoading, setLorebooksLoading] = useState(true);
  const [lorebooksError, setLorebooksError] = useState<string | null>(null);
  const [selectedLorebookIds, setSelectedLorebookIds] = useState<Set<string>>(() => new Set());
  const [attachedLorebookIds, setAttachedLorebookIds] = useState<Set<string>>(() => new Set());
  /** False when the server links could not be read: save must then only attach
   *  what is selected, never blind-detach links it could not see. */
  const [attachmentsLoaded, setAttachmentsLoaded] = useState(true);

  // Seed/AI authoring state. None of this is part of the saved card: the
  // premise is prompt context, and marks/directions are a one-shot request.
  const [seedNotes, setSeedNotes] = useState("");
  const [aiMarks, setAiMarks] = useState<SeedFieldKey[]>([]);
  const [aiDirections, setAiDirections] = useState<Partial<Record<SeedFieldKey, string>>>({});
  const [altCount, setAltCount] = useState(2);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);

  const pendingRef = useRef(pendingAvatar);
  pendingRef.current = pendingAvatar;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Guards the per-character link fetch: switching cards quickly must not let
  // an older response overwrite the newer card's selected lorebooks.
  const lorebookLinkTokenRef = useRef(0);

  const isSeed = source.kind === "seed";
  const aiEnabled = charGen.enabled;
  const seedAuthoring = isSeed && aiEnabled;
  const stepDefs = seedAuthoring ? SEED_STEPS : STEPS;
  const seedDirty = seedAuthoring && seedNotes.trim() !== "";

  const clearPendingAvatar = useCallback((): void => {
    const current = pendingRef.current;
    if (current !== null) {
      URL.revokeObjectURL(current.url);
    }
    pendingRef.current = null;
    setPendingAvatar(null);
  }, []);

  const resetAi = useCallback((): void => {
    setAiMarks([]);
    setAiDirections({});
    setAltCount(2);
    setAiOpen(false);
    setAiBusy(false);
    setAiError(null);
    setAiNotice(null);
  }, []);

  const toggleAiMark = (field: SeedFieldKey): void => {
    setAiMarks((current) =>
      current.includes(field) ? current.filter((item) => item !== field) : [...current, field],
    );
    setAiNotice(null);
  };

  const setAiDirection = (field: SeedFieldKey, value: string): void => {
    setAiDirections((current) => ({ ...current, [field]: value }));
  };

  /** Ignores the feature switch once; every field header reads the same shape. */
  const aiMarkFor = (field: SeedFieldKey): AiMarkProps | undefined => {
    if (!aiEnabled) {
      return undefined;
    }
    return {
      marked: aiMarks.includes(field),
      onToggle: () => toggleAiMark(field),
      direction: aiDirections[field] ?? "",
      onDirectionChange: (value) => setAiDirection(field, value),
    };
  };

  // Never leak a preview URL, whichever way the studio exits.
  useEffect(
    () => () => {
      const current = pendingRef.current;
      if (current !== null) {
        URL.revokeObjectURL(current.url);
      }
    },
    [],
  );

  // The studio is portaled outside #root (see the return), so the covered app
  // has to be removed from the tab order and the accessibility tree by hand.
  useEffect(() => {
    const root = document.getElementById("root");
    if (root === null) {
      return;
    }
    root.setAttribute("inert", "");
    return () => root.removeAttribute("inert");
  }, []);

  // Move focus into the workspace on entry. The section is a non-interactive
  // landmark, so it carries tabIndex -1 and the CSS suppresses its container
  // ring; Tab continues from the topbar's back button.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const dirty = !draftsEqual(draft, baseline);
  const stats = draftStats(draft);
  const saved = characterId !== null && !dirty;
  const avatarUrl = pendingAvatar?.url ?? avatarBase;

  // Persist the working session so a reload or an accidental route change can
  // be resumed. A pristine blank draft is not worth a resume banner, so it is
  // removed instead of stored.
  useEffect(() => {
    if (mode !== "edit") {
      return;
    }
    const timer = window.setTimeout(() => {
      if (characterId === null && draft.name.trim() === "" && !dirty && seedNotes.trim() === "") {
        removeStoredStudio();
        return;
      }
      try {
        const payload: StoredStudio = { draft, baseline, characterId, source, step, seedNotes };
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // storage full/unavailable — the in-memory draft still works.
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [mode, draft, baseline, characterId, source, step, dirty, seedNotes]);

  // Warn on a real tab close/reload. The visible topbar back is the in-app
  // exit and has its own confirm. A seed premise is not part of the card, but
  // losing it would lose the AI context the author just wrote.
  useEffect(() => {
    if (mode !== "edit" || (!dirty && !seedDirty)) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [mode, dirty, seedDirty]);

  const statusTone = saving
    ? "busy"
    : saveError !== null
      ? "danger"
      : draft.name.trim() === ""
        ? "danger"
        : dirty
          ? "dirty"
          : "clean";
  const statusText = saving
    ? "Saving…"
    : saveError !== null
      ? "Save failed"
      : draft.name.trim() === ""
        ? "Name required"
        : dirty
          ? characterId === null
            ? "Unsaved draft"
            : "Unsaved changes"
          : characterId === null
            ? "New draft"
            : "Saved";

  // The picker list is global; link state is per card and loaded alongside the
  // card itself. A failed list load keeps the panel usable (the card can still
  // save) and offers a retry in the field.
  const loadLorebooks = useCallback((): void => {
    setLorebooksLoading(true);
    setLorebooksError(null);
    listLorebooks()
      .then((items) => {
        setAllLorebooks(items);
        setLorebooksLoading(false);
      })
      .catch((err: unknown) => {
        setLorebooksError(err instanceof Error ? err.message : "Failed to load lorebooks");
        setLorebooksLoading(false);
      });
  }, []);

  useEffect(() => {
    loadLorebooks();
  }, [loadLorebooks]);

  const loadLorebookLinks = useCallback((id: string): void => {
    const token = ++lorebookLinkTokenRef.current;
    setAttachmentsLoaded(false);
    setSelectedLorebookIds(new Set());
    setAttachedLorebookIds(new Set());
    listCharacterLorebooks(id)
      .then((items) => {
        if (token !== lorebookLinkTokenRef.current) {
          return;
        }
        const ids = new Set(items.map((book) => book.id));
        setAttachedLorebookIds(ids);
        setSelectedLorebookIds(new Set(ids));
        setAttachmentsLoaded(true);
      })
      .catch(() => {
        if (token === lorebookLinkTokenRef.current) {
          // Unknown links: saving only attaches, never blind-detaches.
          setAttachmentsLoaded(false);
        }
      });
  }, []);

  const save = useCallback((): void => {
    if (saving) {
      return;
    }
    if (draft.name.trim() === "") {
      setSaveError("Give the character a name before saving.");
      setStep("identity");
      return;
    }
    const snapshot = draft;
    const avatarPick = pendingAvatar;
    const currentId = characterId;
    const currentAvatar = avatarBase;
    const wantedLinks = new Set(selectedLorebookIds);
    const previousLinks = new Set(attachedLorebookIds);
    const canDetach = attachmentsLoaded;
    setSaving(true);
    setSaveError(null);
    setSaveWarning(null);
    void (async () => {
      try {
        const input = draftToInput(snapshot);
        const savedCharacter =
          currentId === null
            ? await createCharacter(input)
            : await updateCharacter(currentId, input);
        const warnings: string[] = [];
        let nextAvatar = currentAvatar;
        if (avatarPick !== null) {
          try {
            const image = await uploadImage(savedCharacter.id, avatarPick.file);
            await setCharacterImage(savedCharacter.id, image.id, { avatar: true });
            nextAvatar = blobUrl(image.blob_path);
            URL.revokeObjectURL(avatarPick.url);
            pendingRef.current = null;
            setPendingAvatar(null);
          } catch {
            warnings.push("Character saved, but the portrait upload failed. Save again to retry.");
          }
        }

        // Converge the links toward the current selection. Partial failures
        // keep their successful side in the baseline so a retry only redoes
        // the true gaps.
        const currentLinks = new Set(previousLinks);
        const failedLinks: string[] = [];
        const linkName = (id: string): string =>
          allLorebooks.find((book) => book.id === id)?.name ?? id;
        for (const linkId of [...wantedLinks].filter((id) => !currentLinks.has(id))) {
          try {
            await attachLorebook(linkId, savedCharacter.id);
            currentLinks.add(linkId);
          } catch {
            failedLinks.push(linkName(linkId));
          }
        }
        if (canDetach) {
          for (const linkId of [...currentLinks].filter((id) => !wantedLinks.has(id))) {
            try {
              await detachLorebook(linkId, savedCharacter.id);
              currentLinks.delete(linkId);
            } catch (err) {
              if (err instanceof ApiError && err.status === 404) {
                currentLinks.delete(linkId);
              } else {
                failedLinks.push(linkName(linkId));
              }
            }
          }
        }
        setAttachedLorebookIds(currentLinks);
        if (failedLinks.length > 0) {
          warnings.push(
            `Character saved, but linking ${failedLinks.length} lorebook${
              failedLinks.length === 1 ? "" : "s"
            } failed (${failedLinks.join(", ")}). Save again to retry.`,
          );
        }

        setCharacterId(savedCharacter.id);
        setLoadedCharacter(savedCharacter);
        setAvatarBase(nextAvatar);
        setBaseline(snapshot);
        setSource({ kind: "edit", name: savedCharacter.name });
        // The seed premise is prompt-only; once the card is saved the editor
        // no longer shows it, so keep no hidden authoring state behind.
        setSeedNotes("");
        setSaveWarning(warnings.length > 0 ? warnings.join(" ") : null);
        if (routeIdRef.current === undefined || routeIdRef.current === "new") {
          // Adopt the real ID in the URL without reloading over the draft.
          skipRouteLoadRef.current = savedCharacter.id;
          navigate(`/characters/studio/${savedCharacter.id}`, { replace: true });
        }
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Save failed");
      } finally {
        setSaving(false);
      }
    })();
  }, [
    saving,
    draft,
    pendingAvatar,
    characterId,
    avatarBase,
    selectedLorebookIds,
    attachedLorebookIds,
    attachmentsLoaded,
    allLorebooks,
    navigate,
  ]);

  const saveRef = useRef(save);
  saveRef.current = save;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // ⌘S / Ctrl+S saves without reaching for the topbar. The listener is bound
  // once; the refs carry the latest handler and mode.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        if (modeRef.current !== "edit") {
          return;
        }
        event.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Step changes start at the top of the writing column, not wherever the
  // previous step was scrolled to.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `step` is the transition trigger; the ref and motion preference are read only.
  useEffect(() => {
    canvasRef.current?.scrollTo({ top: 0, behavior: app.reduce ? "auto" : "smooth" });
  }, [step]);

  const clearStored = useCallback((): void => {
    removeStoredStudio();
    setStoredResume(null);
  }, []);

  // Fade the overlay out before the route swaps, so the shell (and its
  // sidebar) arrives gradually instead of popping back in. The small buffer
  // keeps the last frame from being cut off by the navigation.
  const doLeave = useCallback((): void => {
    if (closing) {
      return;
    }
    setClosing(true);
    window.setTimeout(
      () => {
        clearStored();
        navigate("/characters");
      },
      app.reduce ? 0 : Math.round(app.duration.fast * 1000) + 40,
    );
  }, [closing, clearStored, navigate, app]);

  const leave = (): void => {
    if (mode === "edit" && (dirty || seedDirty)) {
      setConfirmAction("leave");
      return;
    }
    doLeave();
  };

  const resetSession = useCallback((): void => {
    clearPendingAvatar();
    setAvatarBase(null);
    setLoadedCharacter(null);
    setAlternateKeys([]);
    setSeedNotes("");
    resetAi();
    setSaveError(null);
    setSaveWarning(null);
    setAvatarError(null);
    setDragOver(false);
    setEnhanceField(null);
    setPreviewOpen(false);
    setGalleryOpen(false);
    setMacrosOpen(false);
    setConfirmAction(null);
    setStepDirection(1);
    setSelectedLorebookIds(new Set());
    setAttachedLorebookIds(new Set());
    setAttachmentsLoaded(true);
    lorebookLinkTokenRef.current++;
  }, [clearPendingAvatar, resetAi]);

  const startBlank = useCallback((): void => {
    clearStored();
    resetSession();
    const empty = emptyStudioDraft();
    setDraft(empty);
    setBaseline(emptyStudioDraft());
    setCharacterId(null);
    setSource({ kind: "blank" });
    setStep("identity");
    setMode("edit");
    setRouteStatus("ready");
    setRouteError(null);
  }, [clearStored, resetSession]);

  /** The seed entry opens the same editor with a premise field at the top. */
  const startSeed = useCallback((): void => {
    clearStored();
    resetSession();
    const empty = emptyStudioDraft();
    setDraft(empty);
    setBaseline(emptyStudioDraft());
    setCharacterId(null);
    setSource({ kind: "seed" });
    setStep("identity");
    setMode("edit");
    setRouteStatus("ready");
    setRouteError(null);
  }, [clearStored, resetSession]);

  /** Populates every editing surface from one fetched card. */
  const applyCharacter = useCallback(
    (full: Character, openMode: "edit" | "remix"): void => {
      clearPendingAvatar();
      setLoadedCharacter(full);
      setAvatarBase(openMode === "edit" ? blobUrl(full.avatar_path) : null);
      const next = draftFromCharacter(full);
      setDraft(next);
      setAlternateKeys(makeAlternateKeys(next.alternate_greetings.length));
      setSeedNotes("");
      resetAi();
      setSaveError(null);
      setSaveWarning(null);
      setAvatarError(null);
      setEnhanceField(null);
      setPreviewOpen(false);
      setGalleryOpen(false);
      setStepDirection(1);
      if (openMode === "edit") {
        setBaseline(next);
        setCharacterId(full.id);
        setSource({ kind: "edit", name: full.name });
        loadLorebookLinks(full.id);
      } else {
        setBaseline(emptyStudioDraft());
        setCharacterId(null);
        setSource({ kind: "remix", name: full.name });
        setSelectedLorebookIds(new Set());
        setAttachedLorebookIds(new Set());
        setAttachmentsLoaded(true);
        lorebookLinkTokenRef.current++;
      }
      setStep("identity");
      setMode("edit");
      setRouteStatus("ready");
      setRouteError(null);
      clearStored();
    },
    [clearPendingAvatar, clearStored, loadLorebookLinks, resetAi],
  );

  const openCharacter = useCallback(
    async (character: CharacterListItem, openMode: "edit" | "remix"): Promise<void> => {
      if (openMode === "edit") {
        // The route owns the fetch, loading state, and the shareable URL.
        navigate(`/characters/studio/${character.id}`);
        return;
      }
      const full = await getCharacter(character.id);
      applyCharacter(full, "remix");
    },
    [applyCharacter, navigate],
  );

  const resumeDraft = (): void => {
    if (storedResume === null) {
      return;
    }
    resetSession();
    setDraft(storedResume.draft);
    setAlternateKeys(makeAlternateKeys(storedResume.draft.alternate_greetings.length));
    setSeedNotes(storedResume.seedNotes);
    setBaseline(storedResume.baseline);
    setCharacterId(storedResume.characterId);
    setSource(storedResume.source);
    setStep(storedResume.step);
    setMode("edit");
    if (storedResume.characterId !== null) {
      loadLorebookLinks(storedResume.characterId);
      getCharacter(storedResume.characterId)
        .then((full) => {
          setAvatarBase(blobUrl(full.avatar_path));
          setLoadedCharacter(full);
        })
        .catch(() => {}); // deleted elsewhere — the draft is still editable
    } else {
      setAttachmentsLoaded(true);
    }
  };

  const doStartAnother = useCallback((): void => {
    clearStored();
    resetSession();
    setDraft(emptyStudioDraft());
    setBaseline(emptyStudioDraft());
    setCharacterId(null);
    setSource({ kind: "blank" });
    setStep("identity");
    setMode("start");
    navigate("/characters/studio", { replace: true });
  }, [clearStored, resetSession, navigate]);

  const startAnother = (): void => {
    if (dirty || seedDirty) {
      setConfirmAction("another");
      return;
    }
    doStartAnother();
  };

  // URL-driven editing: the Characters grid links straight to a card. The
  // retry attempt is a dependency so the error screen can re-run the fetch
  // without changing the ID.
  useEffect(() => {
    // `routeAttempt` is read only by the dependency list; it exists to re-run
    // this effect after the error screen's retry.
    void routeAttempt;
    if (routeCharacterId === undefined) {
      handledNewRouteRef.current = null;
      setRouteStatus("ready");
      setRouteError(null);
      setMode("start");
      return;
    }
    if (routeCharacterId === "new") {
      if (handledNewRouteRef.current === "new") {
        return;
      }
      handledNewRouteRef.current = "new";
      setRouteStatus("ready");
      setRouteError(null);
      startBlank();
      return;
    }
    handledNewRouteRef.current = null;
    const skip = skipRouteLoadRef.current;
    skipRouteLoadRef.current = null;
    if (skip === routeCharacterId) {
      setRouteStatus("ready");
      setRouteError(null);
      return;
    }
    let cancelled = false;
    // Hide any previous card's editor while the new one loads; the route
    // state below replaces the body with its own loading/error surface.
    setMode("start");
    setRouteStatus("loading");
    setRouteError(null);
    getCharacter(routeCharacterId)
      .then((full) => {
        if (!cancelled) {
          applyCharacter(full, "edit");
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRouteError(err instanceof Error ? err.message : "Failed to load character");
          setRouteStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [routeCharacterId, routeAttempt, applyCharacter, startBlank]);

  const pickAvatar = (files: FileList | null | undefined): void => {
    if (files === null || files === undefined || files.length === 0) {
      return;
    }
    const file = files[0];
    if (file === undefined || !file.type.startsWith("image/")) {
      setAvatarError("Choose an image file.");
      return;
    }
    clearPendingAvatar();
    setAvatarError(null);
    setPendingAvatar({ file, url: URL.createObjectURL(file) });
  };

  type StudioScalarKey = "name" | CharacterFieldKey | "system_prompt" | "post_history_instructions";

  const setField = (field: StudioScalarKey, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const toggleLorebook = (id: string, checked: boolean): void => {
    setSelectedLorebookIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const setAlternate = (index: number, value: string): void => {
    setDraft((current) => ({
      ...current,
      alternate_greetings: current.alternate_greetings.map((greeting, item) =>
        item === index ? value : greeting,
      ),
    }));
  };

  const addAlternate = (): void => {
    setAlternateKeys((current) => [...current, `alt-${alternateKeySeq++}`]);
    setDraft((current) => ({
      ...current,
      alternate_greetings: [...current.alternate_greetings, ""],
    }));
  };

  const removeAlternate = (index: number): void => {
    setAlternateKeys((current) => current.filter((_, item) => item !== index));
    setDraft((current) => ({
      ...current,
      alternate_greetings: current.alternate_greetings.filter((_, item) => item !== index),
    }));
  };

  /**
   * One batch pass over every marked field. The whole draft and the seed
   * premise travel as context; only the marked keys come back. Generated
   * fields lose their marks (and directions) so the count always means
   * "still to write", while failed/missing fields stay marked for a retry.
   */
  const generateMarked = useCallback(async (): Promise<void> => {
    if (!charGen.enabled || aiBusy || aiMarks.length === 0) {
      return;
    }
    const snapshot = draft;
    const marks = [...aiMarks];
    const directions = { ...aiDirections };
    const count = altCount;
    setAiBusy(true);
    setAiError(null);
    setAiNotice(null);
    try {
      const result = await generateCharacterSeed({
        notes: seedNotes,
        name: snapshot.name,
        tags: snapshot.tags,
        description: snapshot.description,
        personality: snapshot.personality,
        scenario: snapshot.scenario,
        first_mes: snapshot.first_mes,
        alternate_greetings: snapshot.alternate_greetings,
        mes_example: snapshot.mes_example,
        creator_notes: snapshot.creator_notes,
        generate: marks,
        directions,
        alternate_count: count,
      });
      // Merge into the live draft, not the request snapshot: the author may
      // have closed the dialog and edited another field while it was writing.
      const next = applyGeneratedFields(draftRef.current, result.fields);
      setDraft(next);
      if (result.fields.alternate_greetings !== undefined) {
        setAlternateKeys(makeAlternateKeys(next.alternate_greetings.length));
      }
      const generated = Object.keys(result.fields) as SeedFieldKey[];
      const unresolved = marks.length - generated.length;
      setAiMarks((current) => current.filter((field) => !generated.includes(field)));
      setAiDirections((current) => {
        const remaining = { ...current };
        for (const field of generated) {
          delete remaining[field];
        }
        return remaining;
      });
      setAiOpen(false);
      setAiNotice(
        unresolved > 0
          ? `AI wrote ${generated.length} of ${marks.length} marked fields. The rest stayed marked for a retry.`
          : marks.length === 1
            ? "AI wrote the marked field. Review before saving."
            : `AI wrote all ${marks.length} marked fields. Review before saving.`,
      );
    } catch (error) {
      setAiError(error instanceof Error ? error.message : "Generation failed");
    } finally {
      setAiBusy(false);
    }
  }, [charGen.enabled, aiBusy, aiMarks, aiDirections, altCount, draft, seedNotes]);

  const sourceLabel = useMemo((): string | null => {
    switch (source.kind) {
      case "blank":
        return null;
      case "edit":
        return `Editing ${source.name}`;
      case "remix":
        return `Remix of ${source.name}`;
      case "seed":
        return "New concept";
    }
  }, [source]);

  const resumeInfo: StudioResumeInfo | null =
    storedResume === null
      ? null
      : {
          name: storedResume.draft.name.trim() || "Untitled draft",
          detail:
            storedResume.characterId !== null
              ? draftsEqual(storedResume.draft, storedResume.baseline)
                ? "Saved card"
                : "Saved card · unsaved changes"
              : `${draftStats(storedResume.draft).percent}% ready`,
        };

  const stepIndex = stepDefs.findIndex((item) => item.key === step);
  const currentStep: StepDef = stepDefs[stepIndex] ?? stepDefs[0] ?? IDENTITY_STEP;

  const stepAiCount = (key: StepKey): number =>
    aiEnabled ? aiMarks.filter((field) => SEED_FIELD_STEP[field] === key).length : 0;

  const stepComplete = (key: StepKey): boolean => {
    switch (key) {
      case "identity":
        return draft.name.trim() !== "";
      case "persona":
        return draft.description.trim() !== "" || draft.personality.trim() !== "";
      case "world":
        return draft.scenario.trim() !== "" || draft.mes_example.trim() !== "";
      case "voice":
        return (
          draft.first_mes.trim() !== "" ||
          draft.alternate_greetings.some((greeting) => greeting.trim() !== "")
        );
      case "release":
        return (
          draft.creator_notes.trim() !== "" ||
          draft.system_prompt.trim() !== "" ||
          characterId !== null
        );
    }
  };

  const goToStep = (key: StepKey): void => {
    if (key === step) {
      return;
    }
    // The rail and the footer controls both travel through this one path, so
    // the slide direction always follows the step order, not the trigger.
    const nextIndex = stepDefs.findIndex((item) => item.key === key);
    setStepDirection(nextIndex >= stepIndex ? 1 : -1);
    setStep(key);
  };

  const renderPortrait = (): ReactElement => (
    <div className="studio-portrait-block">
      <span className="studio-field-label">Portrait</span>
      <div className="studio-portrait">
        <button
          type="button"
          className={cx("studio-portrait-frame", dragOver && "is-over")}
          aria-label={avatarUrl === null ? "Upload portrait" : "Replace portrait"}
          onClick={() => portraitInputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDragOver(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            pickAvatar(event.dataTransfer.files);
          }}
        >
          {avatarUrl !== null ? (
            <img className="studio-portrait-image" src={avatarUrl} alt="" />
          ) : (
            <span className="studio-portrait-fallback" aria-hidden="true">
              {draft.name.trim().charAt(0).toUpperCase() || "?"}
            </span>
          )}
          <span className="studio-portrait-overlay">
            <Upload size={15} />
            {avatarUrl === null ? "Upload" : "Replace"}
          </span>
        </button>
        <input
          ref={portraitInputRef}
          type="file"
          accept="image/*"
          className="file-hidden"
          aria-label="Upload portrait"
          onChange={(event) => {
            pickAvatar(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
        <div className="studio-portrait-copy">
          <p className="studio-field-hint">
            A square portrait reads best. Portraits are upload-only; the AI writes text fields. It
            uploads after the character is saved.
          </p>
          {pendingAvatar !== null && (
            <div className="studio-portrait-pending">
              <span className="badge badge-warning">Pending upload</span>
              <button type="button" className="btn btn-ghost" onClick={clearPendingAvatar}>
                <X size={14} />
                Remove
              </button>
            </div>
          )}
          {avatarError !== null && <p className="field-error">{avatarError}</p>}
          {characterId !== null && (
            <button
              type="button"
              className="btn btn-ghost studio-gallery-open"
              onClick={() => setGalleryOpen(true)}
            >
              <Image size={14} />
              Manage gallery
            </button>
          )}
        </div>
      </div>
    </div>
  );

  const renderIdentity = (): ReactElement => (
    <>
      {seedAuthoring && (
        <StudioField
          id="studio-seed-notes"
          label="Concept"
          value={seedNotes}
          onChange={setSeedNotes}
          hint="A premise, theme, or constraint for the AI. This text is prompt context, not a saved card field."
          rows={4}
          placeholder="A drowned cathedral city where the tides keep the old gods asleep…"
          aiEnabled={false}
        />
      )}
      <StudioField
        id="studio-name"
        label="Name"
        name
        input
        value={draft.name}
        onChange={(value) => setField("name", value)}
        hint="The name the model uses for {{char}}."
        placeholder="A name the card can own"
        aiEnabled={false}
        aiMark={aiMarkFor("name")}
      />
      <div className="studio-identity-grid">
        {renderPortrait()}
        <StudioTags
          tags={draft.tags}
          onChange={(tags) => setDraft((current) => ({ ...current, tags }))}
          aiMark={aiMarkFor("tags")}
        />
      </div>
    </>
  );

  const renderPersona = (): ReactElement => (
    <>
      <StudioField
        id="studio-description"
        label="Description"
        value={draft.description}
        onChange={(value) => setField("description", value)}
        hint="The core of the card — the world, the character, and the people around them."
        rows={12}
        placeholder="Open with the world, not a biography. What does it feel like to arrive?"
        aiEnabled={charGen.enabled}
        onEnhance={() => setEnhanceField("description")}
        aiMark={aiMarkFor("description")}
      />
      <StudioField
        id="studio-personality"
        label="Personality"
        value={draft.personality}
        onChange={(value) => setField("personality", value)}
        hint="Temperament, habits, contradictions, and the way they speak. Add what the description leaves out."
        rows={6}
        placeholder="Guarded, precise, and warmer than she admits."
        aiEnabled={charGen.enabled}
        onEnhance={() => setEnhanceField("personality")}
        aiMark={aiMarkFor("personality")}
      />
    </>
  );

  const renderWorld = (): ReactElement => (
    <>
      <StudioField
        id="studio-scenario"
        label="Scenario"
        value={draft.scenario}
        onChange={(value) => setField("scenario", value)}
        hint="The stage the roleplay opens on. A starting condition, not a finished plot."
        rows={7}
        placeholder="Rain on the harbor. The last ship left an hour ago."
        aiEnabled={charGen.enabled}
        onEnhance={() => setEnhanceField("scenario")}
        aiMark={aiMarkFor("scenario")}
      />
      <StudioField
        id="studio-mes-example"
        label="Example dialogue"
        value={draft.mes_example}
        onChange={(value) => setField("mes_example", value)}
        hint="A short exchange that teaches the voice. Use <START>, {{user}}:, and {{char}}: turns."
        rows={9}
        placeholder={
          "<START>\n{{user}}: You came back.\n{{char}}: *She doesn't turn around.* “The door was open.”"
        }
        aiEnabled={charGen.enabled}
        onEnhance={() => setEnhanceField("mes_example")}
        aiMark={aiMarkFor("mes_example")}
      />

      <div className="studio-field studio-lorebooks">
        <div className="studio-field-head">
          <span className="studio-field-label">World info</span>
          <span className="studio-field-count tnum">{selectedLorebookIds.size} linked</span>
        </div>
        {lorebooksError !== null ? (
          <div className="error-banner" role="alert">
            <span>{lorebooksError}</span>
            <button type="button" className="btn btn-ghost" onClick={loadLorebooks}>
              Retry
            </button>
          </div>
        ) : lorebooksLoading ? (
          <div className="studio-lorebook-skeletons" aria-hidden="true">
            {[0, 1, 2].map((item) => (
              <span className="skeleton studio-lorebook-skeleton" key={item} />
            ))}
          </div>
        ) : allLorebooks.length === 0 ? (
          <p className="studio-field-hint">
            No lorebooks yet — create one on the <AppLink to="/lorebooks">Lorebooks page</AppLink>{" "}
            to attach it here.
          </p>
        ) : (
          <div className="lorebook-picker-list">
            {allLorebooks.map((book) => (
              <label
                className="lorebook-picker-row"
                htmlFor={`studio-lorebook-${book.id}`}
                key={book.id}
              >
                <span className="switch">
                  <input
                    id={`studio-lorebook-${book.id}`}
                    type="checkbox"
                    className="switch-input"
                    checked={selectedLorebookIds.has(book.id)}
                    onChange={(event) => toggleLorebook(book.id, event.currentTarget.checked)}
                  />
                  <span className="switch-track">
                    <span className="switch-thumb" />
                  </span>
                </span>
                <span className="lorebook-picker-text">
                  <span className="lorebook-picker-name">{book.name}</span>
                  {book.description !== "" && (
                    <span className="lorebook-picker-desc">{book.description}</span>
                  )}
                </span>
                {book.global && <span className="pill">Global</span>}
              </label>
            ))}
          </div>
        )}
        <span className="studio-field-hint">
          Attached lorebooks inject their world info into this character's chats. For a new card,
          links apply right after the first save.
          {!attachmentsLoaded && characterId !== null
            ? " Existing links could not be read; saving will only add new links."
            : ""}
        </span>
      </div>
    </>
  );

  const renderVoice = (): ReactElement => {
    const altAi = aiMarkFor("alternate_greetings");
    return (
      <>
        <StudioField
          id="studio-first-mes"
          label="First message"
          value={draft.first_mes}
          onChange={(value) => setField("first_mes", value)}
          hint="The opening beat. Leave the scene open so the user can answer."
          rows={10}
          placeholder={"*The door opens before you knock.* “You took your time.”"}
          aiEnabled={charGen.enabled}
          onEnhance={() => setEnhanceField("first_mes")}
          aiMark={aiMarkFor("first_mes")}
        />
        <div className="studio-greetings">
          <div className="studio-field-head">
            <span className="studio-field-label">Alternate greetings</span>
            <div className="studio-field-actions">
              {altAi !== undefined && (
                <AiMarkButton
                  marked={altAi.marked}
                  onToggle={altAi.onToggle}
                  label="alternate greetings"
                />
              )}
              <span className="studio-field-count tnum">
                {draft.alternate_greetings.length} alternate
                {draft.alternate_greetings.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>
          {altAi?.marked === true && (
            <div className="studio-greeting-ai">
              <div className="studio-greeting-ai-row">
                <label className="studio-ai-direction-label" htmlFor="studio-alt-count">
                  How many
                </label>
                <select
                  id="studio-alt-count"
                  className="input studio-alt-count"
                  value={altCount}
                  onChange={(event) => setAltCount(Number(event.currentTarget.value))}
                >
                  {[1, 2, 3, 4].map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
                <span className="studio-greeting-ai-count-label">
                  alternate opening{altCount === 1 ? "" : "s"}
                </span>
              </div>
              <AiDirection
                id="studio-alt-ai-direction"
                value={altAi.direction}
                onChange={altAi.onDirectionChange}
                hint={`The AI replaces the list with ${altCount} new opening${
                  altCount === 1 ? "" : "s"
                }. Existing text and this direction guide it.`}
              />
            </div>
          )}
          <Presence>
            {draft.alternate_greetings.map((greeting, index) => (
              <motion.div
                className="studio-greeting"
                key={alternateKeys[index] ?? "alt-missing"}
                layout
                variants={riseVariants(app)}
                initial="hidden"
                animate="visible"
                exit="exit"
                transition={app.reduce ? INSTANT : app.spring.soft}
              >
                <div className="studio-greeting-head">
                  <span className="studio-greeting-label">Alternate {index + 2}</span>
                  <button
                    type="button"
                    className="btn btn-icon studio-greeting-remove"
                    aria-label={`Remove alternate ${index + 2}`}
                    onClick={() => removeAlternate(index)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <textarea
                  className="textarea studio-textarea"
                  rows={5}
                  aria-label={`Alternate greeting ${index + 2}`}
                  placeholder="Another way the scene can begin."
                  value={greeting}
                  onChange={(event) => setAlternate(index, event.currentTarget.value)}
                />
                <div className="studio-field-foot">
                  <span className="studio-field-hint">
                    {countWords(greeting)} words · {greeting.length.toLocaleString()} chars
                  </span>
                </div>
              </motion.div>
            ))}
          </Presence>
          <button type="button" className="btn studio-add" onClick={addAlternate}>
            <Sparkles size={15} />
            Add alternate greeting
          </button>
          <p className="field-hint">
            Card 1 is the default opening. Alternates appear as swipes — a different mood, place, or
            first move.
          </p>
        </div>
      </>
    );
  };

  const renderRelease = (): ReactElement => {
    const checklist: { label: string; filled: boolean }[] = [
      { label: "Name", filled: draft.name.trim() !== "" },
      { label: "Description", filled: draft.description.trim() !== "" },
      { label: "Personality", filled: draft.personality.trim() !== "" },
      { label: "Scenario", filled: draft.scenario.trim() !== "" },
      { label: "First message", filled: draft.first_mes.trim() !== "" },
      { label: "Tags", filled: draft.tags.length > 0 },
      { label: "Example dialogue", filled: draft.mes_example.trim() !== "" },
      { label: "Creator notes", filled: draft.creator_notes.trim() !== "" },
    ];
    return (
      <>
        <StudioField
          id="studio-creator-notes"
          label="Creator notes"
          value={draft.creator_notes}
          onChange={(value) => setField("creator_notes", value)}
          hint="Author-facing notes: tone, content warnings, and how to play the card well. Never sent to the model."
          rows={6}
          placeholder="A slow-burn political drama. Best played with a patient user."
          aiEnabled={charGen.enabled}
          onEnhance={() => setEnhanceField("creator_notes")}
          aiMark={aiMarkFor("creator_notes")}
        />

        <div className={cx("studio-advanced", advancedOpen && "is-open")}>
          <button
            type="button"
            className="studio-advanced-summary"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((current) => !current)}
          >
            <span>Advanced prompt overrides</span>
            <ChevronDown size={16} className="studio-advanced-chevron" aria-hidden="true" />
          </button>
          <Collapsible open={advancedOpen} lazy>
            <div className="studio-advanced-body">
              <StudioField
                id="studio-system-prompt"
                label="System prompt"
                value={draft.system_prompt}
                onChange={(value) => setDraft((current) => ({ ...current, system_prompt: value }))}
                hint="Replaces the preset's system prompt for this character when set. Leave empty to inherit."
                rows={5}
                aiEnabled={false}
              />
              <StudioField
                id="studio-post-history"
                label="Post-history instructions"
                value={draft.post_history_instructions}
                onChange={(value) =>
                  setDraft((current) => ({ ...current, post_history_instructions: value }))
                }
                hint="Injected after the chat history. Leave empty to inherit the preset."
                rows={4}
                aiEnabled={false}
              />
            </div>
          </Collapsible>
        </div>

        <section className="studio-release" aria-label="Release summary">
          <div className="studio-release-head">
            <span className="studio-release-icon" aria-hidden="true">
              <WandSparkles size={20} />
            </span>
            <div className="studio-release-heading">
              <h3 className="studio-release-title">Save and export</h3>
              <p className="studio-release-desc">
                {stats.filledFields}/{stats.totalFields} fields · {stats.words} words ·{" "}
                {stats.greetings} opening{stats.greetings === 1 ? "" : "s"}
              </p>
            </div>
          </div>

          <ul className="studio-release-checklist">
            {checklist.map((item) => (
              <li
                className={cx("studio-release-check", item.filled && "is-filled")}
                key={item.label}
              >
                <span className="studio-check-mark" aria-hidden="true">
                  {item.filled && <Check size={11} />}
                </span>
                {item.label}
              </li>
            ))}
          </ul>

          <div className="studio-release-actions">
            <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
              {saving ? (
                <span className="spinner btn-spinner" aria-hidden="true" />
              ) : (
                <Check size={16} />
              )}
              {saving ? "Saving…" : characterId === null ? "Save character" : "Save changes"}
            </button>
            {characterId !== null && !dirty ? (
              <>
                <a className="btn" href={exportCardUrl(characterId)} download="">
                  <FileImage size={16} />
                  PNG
                </a>
                <a className="btn" href={exportCardUrl(characterId, "json")} download="">
                  <FileJson size={16} />
                  JSON
                </a>
              </>
            ) : (
              <span className="studio-release-hint">
                {dirty ? "Save to update the export." : "Save to unlock PNG and JSON export."}
              </span>
            )}
          </div>

          {saved && (
            <div className="studio-release-foot">
              <p className="studio-release-saved">
                <Check size={14} aria-hidden="true" />
                Saved to your cast.
              </p>
              <button type="button" className="btn btn-ghost" onClick={leave}>
                Open Characters
              </button>
              <button type="button" className="btn btn-ghost" onClick={startAnother}>
                Create another
              </button>
            </div>
          )}
        </section>
      </>
    );
  };

  const renderStep = (): ReactElement => {
    switch (step) {
      case "identity":
        return renderIdentity();
      case "persona":
        return renderPersona();
      case "world":
        return renderWorld();
      case "voice":
        return renderVoice();
      case "release":
        return renderRelease();
    }
  };

  const nextStep = stepDefs[stepIndex + 1];
  const prevStep = stepDefs[stepIndex - 1];

  // A step swap is spatial: the outgoing page leaves toward the side the user
  // came from and the next one arrives from that side. Under reduced motion
  // both the distance and the duration collapse, so the content simply swaps.
  const stepVariants = useMemo(
    () => ({
      hidden: { opacity: 0, x: app.reduce ? 0 : 22 * stepDirection },
      visible: { opacity: 1, x: 0, transition: app.transition },
      exit: {
        opacity: 0,
        x: app.reduce ? 0 : -14 * stepDirection,
        transition: { ...app.transition, duration: app.reduce ? 0 : app.duration.fast },
      },
    }),
    [app, stepDirection],
  );

  const renderRouteLoading = (): ReactElement => (
    <div className="studio-route-state" role="status" aria-busy="true">
      <span className="studio-route-spinner" aria-hidden="true">
        <span className="spinner" />
      </span>
      <p className="studio-route-title">Opening the card…</p>
      <p className="studio-route-copy">Loading the full character, its portrait, and its links.</p>
      <div className="studio-route-skeleton" aria-hidden="true">
        <span className="skeleton studio-route-skeleton-line" />
        <span className="skeleton studio-route-skeleton-line is-short" />
        <span className="skeleton studio-route-skeleton-block" />
      </div>
    </div>
  );

  const renderRouteError = (): ReactElement => (
    <div className="studio-route-state is-error" role="alert">
      <span className="studio-route-icon" aria-hidden="true">
        <TriangleAlert size={22} />
      </span>
      <p className="studio-route-title">Couldn't open that card</p>
      <p className="studio-route-copy">{routeError ?? "The character could not be loaded."}</p>
      <div className="studio-route-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            setRouteStatus("loading");
            setRouteError(null);
            setRouteAttempt((current) => current + 1);
          }}
        >
          Try again
        </button>
        <button type="button" className="btn btn-primary" onClick={doLeave}>
          Back to Characters
        </button>
      </div>
    </div>
  );

  return createPortal(
    // Portaled to <body>: the route lives inside .app-main-content, whose
    // .page-enter animation transforms the wrapper for ~360ms. A fixed child
    // of a transformed ancestor is contained by that ancestor, which made the
    // overlay cover only the main pane until the animation ended and then snap
    // over the sidebar. As a body child it is viewport-fixed from the first
    // frame, and the opacity tween below gives the sidebar a real crossfade.
    <motion.section
      ref={rootRef}
      tabIndex={-1}
      className="studio"
      aria-label="Character Studio"
      initial={{ opacity: 0 }}
      animate={{ opacity: closing ? 0 : 1 }}
      transition={{
        ...app.transition,
        duration: closing ? app.duration.fast : app.duration.med,
      }}
      style={closing ? { pointerEvents: "none" } : undefined}
    >
      <header className="studio-topbar">
        <div className="studio-topbar-left">
          <button
            type="button"
            className="btn btn-icon studio-back"
            aria-label="Back to Characters"
            data-tip="Back to Characters"
            onClick={leave}
          >
            <ChevronLeft size={18} />
          </button>
          <span className="studio-brand-mark" aria-hidden="true">
            <WandSparkles size={16} />
          </span>
          <span className="studio-brand">
            <span className="studio-brand-name">Character Studio</span>
            {mode === "edit" && (
              <>
                <span className="studio-brand-sep" aria-hidden="true">
                  /
                </span>
                <span className="studio-brand-step">{currentStep.label}</span>
              </>
            )}
          </span>
        </div>

        {mode === "start" ? (
          <span className="studio-topbar-tag">
            {routeStatus === "loading"
              ? "Opening the card…"
              : routeStatus === "error"
                ? "Card unavailable"
                : "A place to build the cast"}
          </span>
        ) : (
          <div className="studio-topbar-right">
            {sourceLabel !== null && (
              <span className="studio-source" data-tip={sourceLabel}>
                {sourceLabel}
              </span>
            )}
            <span className={cx("studio-status", `is-${statusTone}`)} role="status">
              <span className="studio-status-dot" aria-hidden="true" />
              <Presence mode="wait" initial={false}>
                <motion.span
                  key={statusText}
                  className="studio-status-text"
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -2 }}
                  transition={app.reduce ? INSTANT : app.transition}
                >
                  {statusText}
                </motion.span>
              </Presence>
            </span>
            {aiEnabled && (
              <button
                type="button"
                className="btn studio-ai-trigger"
                aria-label={
                  aiMarks.length > 0
                    ? `Generate ${aiMarks.length} marked fields with AI`
                    : "Generate marked fields with AI"
                }
                aria-haspopup="dialog"
                data-tip={
                  aiMarks.length === 0
                    ? "Mark fields with the AI icon first"
                    : "Generate marked fields"
                }
                disabled={aiMarks.length === 0 || aiBusy}
                onClick={() => setAiOpen(true)}
              >
                {aiBusy ? (
                  <span className="spinner btn-spinner" aria-hidden="true" />
                ) : (
                  <WandSparkles size={16} />
                )}
                <span className="studio-ai-trigger-label">AI</span>
                {aiMarks.length > 0 && (
                  <span className="studio-ai-count tnum">{aiMarks.length}</span>
                )}
              </button>
            )}
            <button
              type="button"
              className="btn btn-icon"
              aria-label="Open macros guide"
              aria-haspopup="dialog"
              data-tip="Macros guide"
              onClick={() => setMacrosOpen(true)}
            >
              <BookMarked size={16} />
            </button>
            <button
              type="button"
              className="btn btn-ghost studio-preview-toggle"
              aria-label="Preview card"
              aria-haspopup="dialog"
              onClick={() => setPreviewOpen(true)}
            >
              <Drama size={16} />
              <span className="studio-preview-toggle-label">Preview</span>
            </button>
            {characterId !== null && !dirty && (
              <span className="studio-exports">
                <a
                  className="btn btn-icon"
                  href={exportCardUrl(characterId)}
                  download=""
                  aria-label="Export card as PNG"
                  data-tip="Export PNG"
                >
                  <FileImage size={16} />
                </a>
                <a
                  className="btn btn-icon"
                  href={exportCardUrl(characterId, "json")}
                  download=""
                  aria-label="Export card as JSON"
                  data-tip="Export JSON"
                >
                  <FileJson size={16} />
                </a>
              </span>
            )}
            <button
              type="button"
              className="btn btn-primary studio-save"
              onClick={save}
              disabled={saving}
            >
              {saving ? (
                <span className="spinner btn-spinner" aria-hidden="true" />
              ) : (
                <Check size={16} />
              )}
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </header>

      {routeStatus === "loading" ? (
        renderRouteLoading()
      ) : routeStatus === "error" ? (
        renderRouteError()
      ) : mode === "start" ? (
        <StudioStart
          resume={resumeInfo}
          onResume={resumeDraft}
          onDiscardResume={clearStored}
          onBlank={startBlank}
          onOpenCharacter={openCharacter}
          onSeed={startSeed}
          aiEnabled={aiEnabled}
        />
      ) : (
        <div className="studio-body">
          <nav className="studio-rail" aria-label="Studio steps">
            <div className="studio-rail-nav">
              {stepDefs.map((item, index) => {
                const active = item.key === step;
                const complete = stepComplete(item.key);
                const aiCount = stepAiCount(item.key);
                return (
                  <button
                    type="button"
                    className={cx(
                      "studio-step-link",
                      active && "is-active",
                      complete && "is-complete",
                    )}
                    key={item.key}
                    aria-current={active ? "step" : undefined}
                    onClick={() => goToStep(item.key)}
                  >
                    {active && (
                      <motion.span
                        className="studio-step-indicator"
                        layoutId="studio-step-indicator"
                        aria-hidden="true"
                        transition={app.reduce ? INSTANT : app.spring.snappy}
                      />
                    )}
                    <span className="studio-step-num tnum">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="studio-step-text">
                      <span className="studio-step-label">{item.label}</span>
                      <span className="studio-step-sub">{item.sub}</span>
                    </span>
                    <span
                      className={cx("studio-step-check", aiCount > 0 && "has-ai")}
                      aria-hidden="true"
                    >
                      {aiCount > 0 ? <WandSparkles size={12} /> : complete && <Check size={12} />}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="studio-rail-foot">
              <div className="studio-meter" aria-hidden="true">
                <motion.span
                  className="studio-meter-fill"
                  initial={false}
                  animate={{ scaleX: stats.percent / 100 }}
                  transition={app.reduce ? INSTANT : app.spring.soft}
                />
              </div>
              <div className="studio-meter-label">
                <span>Cast readiness</span>
                <span className="tnum">{stats.percent}%</span>
              </div>
              <p className="studio-rail-hint tnum">
                {stats.words} words · {stats.greetings} opening
                {stats.greetings === 1 ? "" : "s"}
              </p>
            </div>
          </nav>

          <main className="studio-canvas" ref={canvasRef}>
            {aiNotice !== null && (
              <div className="studio-ai-notice studio-banner" role="status">
                <WandSparkles size={15} aria-hidden="true" />
                <span>{aiNotice}</span>
                <button type="button" className="btn btn-ghost" onClick={() => setAiNotice(null)}>
                  Dismiss
                </button>
              </div>
            )}
            {saveError !== null && (
              <div className="error-banner studio-banner" role="alert">
                <span>{saveError}</span>
                <button type="button" className="btn btn-ghost" onClick={save}>
                  Retry save
                </button>
              </div>
            )}
            {saveWarning !== null && (
              <div className="warn-banner studio-banner" role="status">
                {saveWarning}
              </div>
            )}

            <Presence mode="wait">
              <motion.div
                className="studio-step"
                key={step}
                variants={stepVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <header className="studio-step-head">
                  <p className="studio-eyebrow">
                    Step {stepIndex + 1} / {stepDefs.length} · {currentStep.label}
                  </p>
                  <h1 className="studio-step-title">{currentStep.title}</h1>
                  <p className="studio-step-desc">{currentStep.desc}</p>
                </header>

                <div className="studio-form">{renderStep()}</div>

                <div className="studio-step-nav">
                  {prevStep !== undefined ? (
                    <button type="button" className="btn" onClick={() => goToStep(prevStep.key)}>
                      <ChevronLeft size={16} />
                      {prevStep.label}
                    </button>
                  ) : (
                    <span />
                  )}
                  <span className="studio-step-nav-hint">
                    <kbd className="studio-kbd">⌘/Ctrl</kbd>
                    <kbd className="studio-kbd">S</kbd>
                    <span>to save</span>
                  </span>
                  {nextStep !== undefined && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => goToStep(nextStep.key)}
                    >
                      Continue to {nextStep.label}
                      <ArrowRight size={16} />
                    </button>
                  )}
                </div>
              </motion.div>
            </Presence>
          </main>

          <div className="studio-preview-wrap">
            <StudioPreview
              draft={draft}
              avatarUrl={avatarUrl}
              sourceLabel={sourceLabel}
              saved={saved}
            />
            <button
              type="button"
              className="btn btn-primary studio-preview-save"
              onClick={save}
              disabled={saving}
            >
              {saving ? (
                <span className="spinner btn-spinner" aria-hidden="true" />
              ) : (
                <Check size={16} />
              )}
              {saving ? "Saving…" : characterId === null ? "Save character" : "Save changes"}
            </button>
          </div>
        </div>
      )}

      {previewOpen && (
        <Modal title="Card preview" onClose={() => setPreviewOpen(false)}>
          <StudioPreview
            draft={draft}
            avatarUrl={avatarUrl}
            sourceLabel={sourceLabel}
            saved={saved}
          />
        </Modal>
      )}

      <StudioAiGenerateModal
        open={aiOpen}
        marks={aiMarks}
        directions={aiDirections}
        alternateCount={altCount}
        busy={aiBusy}
        error={aiError}
        onGenerate={() => void generateMarked()}
        onClose={() => setAiOpen(false)}
      />

      <StudioEnhanceModal
        open={enhanceField !== null}
        field={enhanceField ?? "description"}
        label={enhanceField === null ? "Description" : CHARACTER_FIELD_LABELS[enhanceField]}
        characterName={draft.name}
        tags={draft.tags}
        currentText={enhanceField === null ? "" : draft[enhanceField]}
        context={enhanceField === null ? "" : draftContext(draft, enhanceField)}
        onApply={(text) => {
          if (enhanceField !== null) {
            setDraft((current) => writeField(current, enhanceField, text));
          }
        }}
        onClose={() => setEnhanceField(null)}
      />

      {galleryOpen && characterId !== null && (
        <Modal title="Portrait & gallery" wide onClose={() => setGalleryOpen(false)}>
          <GalleryPanel
            character={{
              id: characterId,
              name: draft.name,
              avatar_path: loadedCharacter?.avatar_path ?? null,
            }}
            onChanged={() => {
              // An avatar change in the gallery must reach the preview too;
              // a pending local pick still wins until it is uploaded.
              void getCharacter(characterId)
                .then((full) => {
                  setLoadedCharacter(full);
                  if (pendingRef.current === null) {
                    setAvatarBase(blobUrl(full.avatar_path));
                  }
                })
                .catch(() => {});
            }}
          />
        </Modal>
      )}

      {macrosOpen && <MacrosGuideModal onClose={() => setMacrosOpen(false)} />}

      {confirmAction !== null && (
        <ConfirmDialog
          title={confirmAction === "leave" ? "Discard this draft?" : "Start another character?"}
          description={
            <>
              The unsaved changes to{" "}
              <strong>{draft.name.trim() === "" ? "this draft" : draft.name.trim()}</strong> will be
              lost.
            </>
          }
          confirmLabel={confirmAction === "leave" ? "Discard and leave" : "Discard and start over"}
          tone="danger"
          onClose={() => setConfirmAction(null)}
          onConfirm={() => {
            const action = confirmAction;
            setConfirmAction(null);
            if (action === "leave") {
              doLeave();
            } else {
              doStartAnother();
            }
          }}
        />
      )}
    </motion.section>,
    document.body,
  );
}
