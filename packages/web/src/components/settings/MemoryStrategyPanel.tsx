/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { getSettings, putSettings } from "../../lib/api";
import type { Profile } from "../../lib/api-profiles";
import { listProfiles } from "../../lib/api-profiles";
import { cx } from "../../lib/cx";
import { riseVariants, useAppMotion } from "../../lib/motion";
import { EyeOff, RotateCcw } from "../ui/icons";
import { Presence } from "../ui/presence";
import "../../styles/memory.css";
import "../../styles/settings.css";
import { SettingsError, SettingsLoading, SettingsSaved } from "./SettingsStates";
import { StepperRow } from "./Stepper";

/** The two built-in strategies (ids are the engine's registry keys). */
const STRATEGIES = [
  {
    id: "trim",
    name: "Trim",
    description: "Truncate oldest messages to fit the context budget.",
  },
  {
    id: "summaries",
    name: "Layered Summaries",
    description: "Compress older turns into layered summaries, keep recent turns verbatim.",
  },
] as const;

type StrategyId = (typeof STRATEGIES)[number]["id"];

interface TrimConfig {
  keep_last: number;
  min_keep: number;
}

interface SummariesConfig {
  chunk_size: number;
  summarize_after: number;
  /** "" = the default profile (profile_id stays unset server-side). */
  profile_id: string;
  /** Layer 0 keeps at most this many uncovered snippets before promoting. */
  max_snippets_per_layer: number;
  /** How many older snippets merge into one on promotion. */
  snippets_per_promotion: number;
  /** Allowed summary levels are 0..max_layer_depth-1. */
  max_layer_depth: number;
  /** One regex per line, stripped from summarizer input only. */
  strip_patterns: string;
  system_prompt: string;
  user_prompt: string;
  /** Wraps each injected snippet; {{summary}} is the snippet placeholder. */
  injection_template: string;
  /** Display-only: mark chat messages covered by summaries. */
  mark_summarized: boolean;
}

/** Engine defaults — mirror @suvoj/core engine/memory/trim.ts + summaries.ts. */
const TRIM_DEFAULTS: TrimConfig = { keep_last: 2, min_keep: 1 };
const SUMMARIES_DEFAULTS: SummariesConfig = {
  chunk_size: 8,
  summarize_after: 30,
  profile_id: "",
  max_snippets_per_layer: 15,
  snippets_per_promotion: 3,
  max_layer_depth: 3,
  strip_patterns: "",
  system_prompt:
    "You are a precise narrative-state tracker. Condense the core plot progression, changing dynamics, character motivations, and situational context into a single, high-density line. Output only this summary line, no preamble, no commentary, no markdown.",
  user_prompt: `<player_name>{{player_name}}</player_name>
<prior_context>{{context_str}}</prior_context>
<passage_in_question>{{story_txt}}</passage_in_question>

You are a Narrative Compression Specialist. Your task is to condense the <passage_in_question> into a dense, coherent summary that seamlessly continues from <prior_context>.

CRITICAL FILTERING RULES:
1. IGNORE all <details> and <summary>blocks. Do not summarize technical data or hidden mechanics.
2. IGNORE empty passages or repetitive sensory details already present in <prior_context>.

SUMMARIZATION PRIORITIES (Preserve in this order):
1. PLOT & ACTION: Key physical events, decisions made, and their immediate consequences.
2. RELATIONSHIP SHIFTS: Any change in relationships between NPCs including love, hate, friendship and other specifics.
3. CHARACTER STATE: Significant changes in NPC mood or revealed motivations.
4. ATMOSPHERIC ANCHORS: 2-3 most distinctive sensory details (smell, sound, lighting) that define the scene's tone. Avoid generic descriptions.
5. DIALOGUE ESSENCE: Paraphrase key exchanges. Preserve direct quotes ONLY if they reveal character voice or contain critical information.

OUTPUT GUIDELINES:
- Write as a single, fluid paragraph (not bullet points).
- Target length: 50-100 words for standard passages; up to 175 words for complex scenes.
- Use specific names, locations, and time references.
- Maintain the original narrative tone (e.g., gritty, romantic, tense).
- If the passage contains no significant new information, output exactly: [NO SIGNIFICANT CONTENT]

Output only the summary text. No preamble, no markdown, no commentary.`,
  injection_template: "[Summary of past events: {{summary}}]",
  mark_summarized: false,
};

/** Keys removed by the summaries-config rework — never written back on save. */
const LEGACY_SUMMARY_KEYS = [
  "trigger_messages",
  "keep_last",
  "trigger_tokens",
  "prompt_template",
] as const;

/** True for plain JSON objects (the memory_config value shape). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads an integer config field, falling back to the engine default. */
function readInt(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
  min: number,
): number {
  const value = record?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.trunc(value));
}

/** Reads a string config field, falling back to the engine default. */
function readString(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const value = record?.[key];
  return typeof value === "string" && value !== "" ? value : fallback;
}

/**
 * Like {@link readString} but "" is a meaningful stored value (empty
 * strip_patterns = strip nothing, an emptied injection template = raw
 * snippet), so only a missing or non-string field falls back.
 */
function readStringAllowEmpty(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const value = record?.[key];
  return typeof value === "string" ? value : fallback;
}

/** Reads a boolean config field, falling back to the engine default. */
function readBool(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: boolean,
): boolean {
  const value = record?.[key];
  return typeof value === "boolean" ? value : fallback;
}

/** Self-playing demo: oldest messages drop out as the budget fills up. */
function TrimDemo() {
  return (
    <div className="memory-demo">
      <div className="memory-demo-stage memory-trim" aria-hidden="true">
        <span className="demo-msg demo-old" style={{ width: "84%" }} />
        <span className="demo-msg demo-old" style={{ width: "66%" }} />
        <span className="demo-msg demo-old" style={{ width: "76%" }} />
        <span className="demo-msg demo-kept" style={{ width: "58%" }} />
        <span className="demo-msg demo-kept" style={{ width: "72%" }} />
        <div className="demo-budget">
          <span className="demo-budget-label">context budget</span>
          <span className="demo-budget-track">
            <span className="demo-budget-fill" />
          </span>
        </div>
      </div>
      <p className="caption muted">
        How it works — when the history outgrows the context budget, the oldest messages are dropped
        until it fits again; the newest ones are always kept.
      </p>
    </div>
  );
}

/**
 * Self-playing demo: the layered-summaries pipeline, end to end. The loop
 * replays one turn of the mechanic — older messages get ghosted (the
 * eye-off mark fades in as they dim), collapse into level-0 snippet chips
 * wrapped in the injection template, and once a layer fills up its oldest
 * snippets merge into a higher-layer chip while the newest messages stay
 * verbatim below. Decorative: aria-hidden, pure CSS keyframes.
 */
function SummariesDemo() {
  return (
    <div className="memory-demo">
      <div className="memory-demo-stage memory-layered" aria-hidden="true">
        {/* Layer 1: the roll-up chip the level-0 snippets promote into. */}
        <div className="demo-layer">
          <span className="demo-layer-label">layer 1</span>
          <span className="demo-chip demo-chip-l1">[Summary of past events: …]</span>
        </div>
        {/* Layer 0: one wrapped snippet per summarized chunk of messages. */}
        <div className="demo-layer">
          <span className="demo-layer-label">layer 0</span>
          <div className="demo-chips">
            <span className="demo-chip demo-chip-l0">[Summary of past events: …]</span>
            <span className="demo-chip demo-chip-l0">[Summary of past events: …]</span>
            <span className="demo-chip demo-chip-l0">[Summary of past events: …]</span>
          </div>
        </div>
        {/* The ghosted messages: they collapse into the chips above but stay
            on screen, dimmed and marked — readable in the chat, just not
            sent to the AI anymore. */}
        <div className="demo-old-block">
          <span className="demo-ghost">
            <EyeOff size={11} className="demo-ghost-icon" />
            <span className="demo-ghost-bar" style={{ width: "76%" }} />
          </span>
          <span className="demo-ghost">
            <EyeOff size={11} className="demo-ghost-icon" />
            <span className="demo-ghost-bar" style={{ width: "58%" }} />
          </span>
          <span className="demo-ghost">
            <EyeOff size={11} className="demo-ghost-icon" />
            <span className="demo-ghost-bar" style={{ width: "68%" }} />
          </span>
        </div>
        <span className="demo-note">readable in chat — hidden from the AI</span>
        <span className="demo-divider" />
        <div className="demo-live">
          <span className="demo-msg demo-kept" style={{ width: "56%" }} />
          <span className="demo-msg demo-kept" style={{ width: "68%" }} />
          <span className="demo-tag">verbatim</span>
        </div>
      </div>
      <p className="caption muted">
        How it works — the newest messages always stay verbatim, while older ones are compressed
        chunk by chunk into snippets wrapped in the injection template; as a layer fills up, its
        oldest snippets merge into a higher-layer summary of summaries. Covered messages stay
        readable in the chat but are hidden from the AI — enable "Mark summarized messages" below to
        see which ones.
      </p>
    </div>
  );
}

/** Chooses how long chats stay within the model's context window. */
export default function MemoryStrategyPanel() {
  const [strategy, setStrategy] = useState<StrategyId>("trim");
  const [trim, setTrim] = useState<TrimConfig>(TRIM_DEFAULTS);
  const [summaries, setSummaries] = useState<SummariesConfig>(SUMMARIES_DEFAULTS);
  /** Raw memory_config as loaded — unknown strategies and keys survive a save. */
  const [rawConfig, setRawConfig] = useState<Record<string, unknown>>({});
  /** Connection profiles for the summarizer-profile select. */
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [saving, setSaving] = useState(false);
  /** A strategy radio save is in flight — blocks racing the config save. */
  const [switching, setSwitching] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** GET /api/settings failed — without the stored values a save would wipe
   *  the real config, so the panel stays locked until a retry succeeds. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** True until the first GET settles (either way); drives the skeleton. */
  const [loading, setLoading] = useState(true);
  const app = useAppMotion();

  /**
   * Loads the stored config into local state. A stable callback (it touches
   * only component-local state and module-level fetchers) so the mount effect
   * and the error state's retry button run the exact same path. A load never
   * falls back to defaults: saving them would overwrite the real
   * memory_config, so a failure stays visible through loadError.
   */
  const loadConfig = useCallback((): void => {
    setLoading(true);
    setLoadError(null);
    getSettings()
      .then((settings) => {
        if (settings.memory_strategy === "trim" || settings.memory_strategy === "summaries") {
          setStrategy(settings.memory_strategy);
        }
        const raw = isRecord(settings.memory_config) ? settings.memory_config : {};
        setRawConfig(raw);
        const trimRaw = isRecord(raw.trim) ? raw.trim : undefined;
        setTrim({
          keep_last: readInt(trimRaw, "keep_last", TRIM_DEFAULTS.keep_last, 0),
          min_keep: readInt(trimRaw, "min_keep", TRIM_DEFAULTS.min_keep, 1),
        });
        const summariesRaw = isRecord(raw.summaries) ? raw.summaries : undefined;
        setSummaries({
          chunk_size: readInt(summariesRaw, "chunk_size", SUMMARIES_DEFAULTS.chunk_size, 1),
          summarize_after: readInt(
            summariesRaw,
            "summarize_after",
            SUMMARIES_DEFAULTS.summarize_after,
            1,
          ),
          profile_id: readString(summariesRaw, "profile_id", ""),
          max_snippets_per_layer: readInt(
            summariesRaw,
            "max_snippets_per_layer",
            SUMMARIES_DEFAULTS.max_snippets_per_layer,
            1,
          ),
          snippets_per_promotion: readInt(
            summariesRaw,
            "snippets_per_promotion",
            SUMMARIES_DEFAULTS.snippets_per_promotion,
            2,
          ),
          max_layer_depth: readInt(
            summariesRaw,
            "max_layer_depth",
            SUMMARIES_DEFAULTS.max_layer_depth,
            1,
          ),
          strip_patterns: readStringAllowEmpty(summariesRaw, "strip_patterns", ""),
          system_prompt: readString(
            summariesRaw,
            "system_prompt",
            SUMMARIES_DEFAULTS.system_prompt,
          ),
          user_prompt: readString(summariesRaw, "user_prompt", SUMMARIES_DEFAULTS.user_prompt),
          injection_template: readStringAllowEmpty(
            summariesRaw,
            "injection_template",
            SUMMARIES_DEFAULTS.injection_template,
          ),
          mark_summarized: readBool(summariesRaw, "mark_summarized", false),
        });
      })
      .catch((err: unknown) => {
        // Not silently swallowed: saving over unwritten defaults would PUT
        // them as the whole memory_config and wipe the stored values.
        setLoadError(err instanceof Error ? err.message : "Failed to load settings");
      })
      .finally(() => setLoading(false));
    listProfiles()
      .then((result) => setProfiles(result.profiles))
      .catch(() => {}); // profiles unreachable — the select shows the default only
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  /** Selecting a strategy persists it immediately (the classic radio pattern). */
  const selectStrategy = async (id: StrategyId): Promise<void> => {
    if (switching || saving) {
      return; // a save is already in flight — ignore racing toggles
    }
    const previous = strategy;
    setSwitching(true);
    setStrategy(id);
    setNote(null);
    setError(null);
    try {
      await putSettings({ memory_strategy: id });
      setNote("Saved");
    } catch (err) {
      // The PUT failed — put the radio back where the server still is.
      setStrategy(previous);
      setError(err instanceof Error ? err.message : "Failed to save memory strategy");
    } finally {
      setSwitching(false);
    }
  };

  /**
   * Saves the config of the active strategy (and the strategy itself, in case
   * its immediate save failed). memory_config is merged over the raw loaded
   * record so other strategies and unknown keys are never clobbered; the
   * summaries entry is rebuilt with the current schema's keys only (the
   * legacy trigger_messages/keep_last/trigger_tokens/prompt_template never
   * come back).
   */
  const saveConfig = async (): Promise<void> => {
    setSaving(true);
    setNote(null);
    setError(null);
    try {
      const trimCurrent = trim;
      const summariesCurrent = summaries;
      // readString (load) treats "" as unset, so an emptied prompt must not
      // save as "" — save the default so the stored value always matches
      // what the engine interpolates. strip_patterns and
      // injection_template keep "" as-is: empty is meaningful there (strip
      // nothing / wrap the snippet in nothing but a newline).
      const systemPrompt =
        summariesCurrent.system_prompt.trim() === ""
          ? SUMMARIES_DEFAULTS.system_prompt
          : summariesCurrent.system_prompt;
      const userPrompt =
        summariesCurrent.user_prompt.trim() === ""
          ? SUMMARIES_DEFAULTS.user_prompt
          : summariesCurrent.user_prompt;
      // A stored profile_id pointing at a deleted profile drops out here —
      // the server resolves missing ids to the default profile anyway. An
      // empty list (fetch failed; the server always seeds a default) keeps
      // the stored id so a network blip can't silently clear it.
      const known = profiles.some((profile) => profile.id === summariesCurrent.profile_id);
      const profileId = known || profiles.length === 0 ? summariesCurrent.profile_id : "";
      const config: Record<string, unknown> = { ...rawConfig };
      config.trim = {
        ...(isRecord(config.trim) ? config.trim : {}),
        keep_last: trimCurrent.keep_last,
        min_keep: trimCurrent.min_keep,
      };
      const summariesStored: Record<string, unknown> = isRecord(config.summaries)
        ? { ...config.summaries }
        : {};
      for (const key of LEGACY_SUMMARY_KEYS) {
        delete summariesStored[key];
      }
      if (profileId === "") {
        delete summariesStored.profile_id;
      } else {
        summariesStored.profile_id = profileId;
      }
      summariesStored.chunk_size = summariesCurrent.chunk_size;
      summariesStored.summarize_after = summariesCurrent.summarize_after;
      summariesStored.max_snippets_per_layer = summariesCurrent.max_snippets_per_layer;
      summariesStored.snippets_per_promotion = summariesCurrent.snippets_per_promotion;
      summariesStored.max_layer_depth = summariesCurrent.max_layer_depth;
      summariesStored.strip_patterns = summariesCurrent.strip_patterns;
      summariesStored.system_prompt = systemPrompt;
      summariesStored.user_prompt = userPrompt;
      summariesStored.injection_template = summariesCurrent.injection_template;
      summariesStored.mark_summarized = summariesCurrent.mark_summarized;
      config.summaries = summariesStored;
      const saved = await putSettings({ memory_strategy: strategy, memory_config: config });
      // Refresh the raw snapshot from the response so a later save merges
      // over fresh server state, not the one loaded at mount.
      setRawConfig(isRecord(saved.memory_config) ? saved.memory_config : config);
      // The stored prompts are never empty — show exactly what the engine uses.
      setSummaries((current) => ({
        ...current,
        system_prompt: systemPrompt,
        user_prompt: userPrompt,
      }));
      setNote("Saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save memory settings");
    } finally {
      setSaving(false);
    }
  };

  const editTrim = (patch: Partial<TrimConfig>): void => {
    setNote(null);
    setTrim((current) => ({ ...current, ...patch }));
  };

  const editSummaries = (patch: Partial<SummariesConfig>): void => {
    setNote(null);
    setSummaries((current) => ({ ...current, ...patch }));
  };

  return (
    <div className="set-stack">
      <p className="caption muted set-intro">
        Memory strategies shape what the model sees of a long conversation: when the history
        outgrows the context budget, older turns are dropped or compressed. The choice made here
        applies globally and overrides the preset's own memory setting.
      </p>

      {loading ? (
        <SettingsLoading label="Loading memory settings…" rows={3} />
      ) : loadError !== null ? (
        <SettingsError
          title="Couldn't load memory settings"
          details={loadError}
          onRetry={loadConfig}
        />
      ) : (
        <>
          <section className="set-card">
            <header className="set-card-head">
              <div className="set-card-heading">
                <h3 className="set-card-title">Strategy</h3>
                <p className="set-card-desc">
                  Pick one; the choice is saved immediately, and the config below saves with the
                  Save button.
                </p>
              </div>
            </header>
            <div className="set-card-body">
              <div role="radiogroup" aria-label="Memory strategy" className="stack">
                {STRATEGIES.map((item) => (
                  <label
                    className={cx("strategy-option", strategy === item.id && "is-active")}
                    key={item.id}
                  >
                    <input
                      type="radio"
                      name="memory-strategy"
                      className="strategy-radio"
                      value={item.id}
                      checked={strategy === item.id}
                      disabled={switching || saving}
                      onChange={() => void selectStrategy(item.id)}
                    />
                    <span className="strategy-dot" aria-hidden="true" />
                    <span className="strategy-label">
                      <span className="strategy-name">{item.name}</span>
                      <span className="strategy-desc">{item.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </section>

          {/* Crossfade the strategy config: mode="wait" swaps the whole block
              cleanly instead of reconciling one shared subtree. Presence's
              initial defaults to false, so the first strategy does not replay
              an entrance on mount. */}
          <Presence mode="wait">
            {strategy === "trim" ? (
              <motion.div
                className="set-stack"
                key="trim"
                variants={riseVariants(app)}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <TrimDemo />
                <section className="set-card">
                  <header className="set-card-head">
                    <div className="set-card-heading">
                      <h3 className="set-card-title">Trim configuration</h3>
                      <p className="set-card-desc">
                        How aggressively the oldest messages are dropped.
                      </p>
                    </div>
                  </header>
                  <div className="set-card-body is-flush">
                    <div className="set-rows">
                      <StepperRow
                        label="Keep last"
                        hint="Newest messages never dropped, even over budget."
                        value={trim.keep_last}
                        min={0}
                        onChange={(value) => editTrim({ keep_last: value })}
                      />
                      <StepperRow
                        label="Min keep"
                        hint="Hard floor of remaining messages before trimming gives up."
                        value={trim.min_keep}
                        min={1}
                        onChange={(value) => editTrim({ min_keep: value })}
                      />
                    </div>
                  </div>
                </section>
              </motion.div>
            ) : (
              <motion.div
                className="set-stack"
                key="summaries"
                variants={riseVariants(app)}
                initial="hidden"
                animate="visible"
                exit="exit"
              >
                <SummariesDemo />
                <section className="set-card">
                  <header className="set-card-head">
                    <div className="set-card-heading">
                      <h3 className="set-card-title">Layering</h3>
                      <p className="set-card-desc">
                        Chunking, promotion thresholds, and what the summarizer sees.
                      </p>
                    </div>
                  </header>
                  <div className="set-card-body is-flush">
                    <div className="set-rows">
                      <StepperRow
                        label="Summarize after"
                        hint="Messages before summarization begins — the newest messages always stay verbatim; older ones are summarized once a full chunk exists."
                        value={summaries.summarize_after}
                        min={1}
                        onChange={(value) => editSummaries({ summarize_after: value })}
                      />
                      <StepperRow
                        label="Chunk size"
                        hint="Messages per summary."
                        value={summaries.chunk_size}
                        min={1}
                        onChange={(value) => editSummaries({ chunk_size: value })}
                      />
                      <StepperRow
                        label="Max snippets per layer"
                        hint="Exceeding this promotes the layer's oldest snippets to the next layer."
                        value={summaries.max_snippets_per_layer}
                        min={1}
                        onChange={(value) => editSummaries({ max_snippets_per_layer: value })}
                      />
                      <StepperRow
                        label="Snippets per promotion"
                        hint="How many older snippets merge into one on promotion."
                        value={summaries.snippets_per_promotion}
                        min={2}
                        onChange={(value) => editSummaries({ snippets_per_promotion: value })}
                      />
                      <StepperRow
                        label="Max layer depth"
                        hint="Layers of summaries — deeper layers compress more."
                        value={summaries.max_layer_depth}
                        min={1}
                        onChange={(value) => editSummaries({ max_layer_depth: value })}
                      />
                      {/* The ghost-mark toggle: display-only, but it lives with the
                          layering knobs because it answers "what happens to covered
                          messages" the demo above just narrated. */}
                      <label className="set-row switch-row" htmlFor="mark-summarized">
                        <span className="set-row-main">
                          <span className="set-row-label">Mark summarized messages</span>
                          <span className="set-row-hint">
                            A subtle marker on chat messages covered by summaries and hidden from
                            the AI — they look and behave exactly the same otherwise. Takes effect
                            the next time the chat loads.
                          </span>
                        </span>
                        <span className="switch">
                          <input
                            id="mark-summarized"
                            type="checkbox"
                            className="switch-input"
                            checked={summaries.mark_summarized}
                            onChange={() =>
                              editSummaries({ mark_summarized: !summaries.mark_summarized })
                            }
                          />
                          <span className="switch-track">
                            <span className="switch-thumb" />
                          </span>
                        </span>
                      </label>
                    </div>
                    <div className="set-card-body">
                      <div className="field">
                        <label className="field-label" htmlFor="summarizer-profile">
                          Summarizer profile
                        </label>
                        <select
                          id="summarizer-profile"
                          className="select"
                          value={summaries.profile_id}
                          onChange={(event) =>
                            editSummaries({ profile_id: event.currentTarget.value })
                          }
                        >
                          <option value="">Default profile</option>
                          {profiles.map((profile) => (
                            <option value={profile.id} key={profile.id}>
                              {profile.name}
                            </option>
                          ))}
                        </select>
                        <span className="field-hint">
                          The model used for summarization — pick a cheaper model to save credits.
                        </span>
                      </div>
                      <div className="field">
                        <label className="field-label" htmlFor="summaries-injection-template">
                          Injection template
                        </label>
                        <input
                          id="summaries-injection-template"
                          className="input"
                          type="text"
                          value={summaries.injection_template}
                          onChange={(event) =>
                            editSummaries({ injection_template: event.currentTarget.value })
                          }
                        />
                        <span className="field-hint">
                          Wraps each injected snippet — use {"{{summary}}"} as the placeholder for
                          the snippet text.
                        </span>
                      </div>
                      <div className="field">
                        <label className="field-label" htmlFor="summaries-strip-patterns">
                          Strip patterns
                        </label>
                        <textarea
                          id="summaries-strip-patterns"
                          className="textarea"
                          rows={3}
                          aria-label="Strip patterns"
                          value={summaries.strip_patterns}
                          onChange={(event) =>
                            editSummaries({ strip_patterns: event.currentTarget.value })
                          }
                        />
                        <span className="field-hint">
                          One regex per line, stripped from messages before they are handed to the
                          summarizer (invalid lines are ignored).
                        </span>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="set-card">
                  <header className="set-card-head">
                    <div className="set-card-heading">
                      <h3 className="set-card-title">Prompts</h3>
                      <p className="set-card-desc">
                        The system and user messages of every summarizer call.
                      </p>
                    </div>
                  </header>
                  <div className="set-card-body">
                    <div className="field">
                      <div className="memory-prompt-head">
                        <span className="field-label">System prompt</span>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() =>
                            editSummaries({ system_prompt: SUMMARIES_DEFAULTS.system_prompt })
                          }
                        >
                          <RotateCcw size={12} />
                          Reset to default
                        </button>
                      </div>
                      <textarea
                        className="textarea"
                        rows={5}
                        aria-label="Summarizer system prompt"
                        value={summaries.system_prompt}
                        onChange={(event) =>
                          editSummaries({ system_prompt: event.currentTarget.value })
                        }
                      />
                      <span className="field-hint">
                        Sent as the system message of every summarizer call. Reset restores the
                        built-in prompt.
                      </span>
                    </div>
                    <div className="field">
                      <div className="memory-prompt-head">
                        <span className="field-label">User prompt</span>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() =>
                            editSummaries({ user_prompt: SUMMARIES_DEFAULTS.user_prompt })
                          }
                        >
                          <RotateCcw size={12} />
                          Reset to default
                        </button>
                      </div>
                      <textarea
                        className="textarea"
                        rows={10}
                        aria-label="Summarizer user prompt"
                        value={summaries.user_prompt}
                        onChange={(event) =>
                          editSummaries({ user_prompt: event.currentTarget.value })
                        }
                      />
                      <span className="field-hint">
                        {
                          "Placeholders: {{player_name}}, {{context_str}} (the summaries so far), and"
                        }
                        {
                          " {{story_txt}} (the passage to condense). Reset restores the built-in prompt."
                        }
                      </span>
                    </div>
                  </div>
                </section>
              </motion.div>
            )}
          </Presence>
        </>
      )}

      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={loading || loadError !== null || saving || switching}
          onClick={() => void saveConfig()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <SettingsSaved note={note} />
        {error && <span className="field-error">{error}</span>}
      </div>
    </div>
  );
}
