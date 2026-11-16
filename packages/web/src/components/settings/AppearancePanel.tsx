/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useLayoutEffect, useMemo, useState } from "react";
import { INSTANT, useAppMotion } from "../../lib/motion";
import {
  type BlurStrength,
  DEFAULT_DESIGN,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  type MotionIntensity,
  type SurfaceStyle,
  type Translucency,
  useDesign,
} from "../../stores/design";
import { useLayout } from "../../stores/layout";
import { pluginThemesAtom, THEMES, type ThemeId, themeKind, useTheme } from "../../stores/theme";
import "../../styles/settings.css";
import { Check, RotateCcw } from "../ui/icons";
import type { SegmentedOption } from "../ui/segmented";
import { Segmented } from "../ui/segmented";
import AdvancedSection from "./AdvancedSection";

/** One theme choice in the picker: a built-in THEMES entry or a plugin contribution. */
interface ThemeChoice {
  id: ThemeId;
  name: string;
  kind: "dark" | "light";
  /** Set only for plugin themes, whose preview comes from their own vars. */
  pluginVars?: Record<string, string>;
  /** The contributing plugin's display name, for the provenance line. */
  pluginName?: string;
}

/**
 * Fallback for a plugin theme's preview swatch when a token is missing. A
 * theme's vars are validated server-side, but the picker must not render
 * "undefined"; --fg-faint is a theme token that resolves in every palette.
 */
const SWATCH_FALLBACK = "var(--fg-faint)";

/** Diagonal split preview for a plugin theme, derived from its own vars
 *  (built-ins get their colors from the per-id rules in styles/shell.css). */
function pluginSwatchBackground(vars: Record<string, string>): string {
  const bg = vars["--bg"] ?? SWATCH_FALLBACK;
  const accent = vars["--accent"] ?? SWATCH_FALLBACK;
  return `linear-gradient(135deg, ${bg} 50%, ${accent} 50%)`;
}

/** Split choices into the Dark / Light rows the picker renders, preserving order. */
function splitByKind(items: ThemeChoice[]): { label: string; items: ThemeChoice[] }[] {
  return [
    { label: "Dark", items: items.filter((item) => item.kind === "dark") },
    { label: "Light", items: items.filter((item) => item.kind === "light") },
  ];
}

/** Navigation placement choices. */
const SIDE_OPTIONS: readonly SegmentedOption<"left" | "right" | "top">[] = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "top", label: "Top" },
];

/** Motion-intensity choices for the segmented control. */
const MOTION_OPTIONS: readonly SegmentedOption<MotionIntensity>[] = [
  { value: "off", label: "Off" },
  { value: "subtle", label: "Subtle" },
  { value: "full", label: "Full" },
];

/** Surface-style choices for the segmented control. */
const SURFACE_OPTIONS: readonly SegmentedOption<SurfaceStyle>[] = [
  { value: "flat", label: "Flat" },
  { value: "elevated", label: "Elevated" },
  { value: "glass", label: "Glass" },
  { value: "aero", label: "Aero" },
];

/** Glass/aero backdrop-blur choices for the segmented control. */
const BLUR_OPTIONS: readonly SegmentedOption<BlurStrength>[] = [
  { value: "light", label: "Light" },
  { value: "medium", label: "Medium" },
  { value: "heavy", label: "Heavy" },
];

/** Glass/aero chrome-opacity choices for the segmented control. */
const TRANSLUCENCY_OPTIONS: readonly SegmentedOption<Translucency>[] = [
  { value: "sheer", label: "Sheer" },
  { value: "balanced", label: "Balanced" },
  { value: "dense", label: "Dense" },
];

/** Neutral gray for an unavailable --accent — a color input always needs a value. */
const FALLBACK_ACCENT = "#808080";

/**
 * Reads the active theme's --accent from the document root, trimmed; an empty
 * value (var not defined) falls back to a neutral gray.
 *
 * `themeId` and `kind` are not read: they document which theme the derived
 * accent belongs to at each call site and keep the reading effect's dependency
 * list honest (the same signature convention as applyAccent in
 * stores/design.ts).
 */
function readThemeAccent(_themeId: ThemeId, _kind: "dark" | "light" | null): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return value === "" ? FALLBACK_ACCENT : value;
}

/** Title + description block shared by every appearance card. */
function CardHead({ title, desc }: { title: string; desc?: string }) {
  return (
    <header className="set-card-head">
      <div className="set-card-heading">
        <h3 className="set-card-title">{title}</h3>
        {desc !== undefined && <p className="set-card-desc">{desc}</p>}
      </div>
    </header>
  );
}

/** One labeled knob row: description on the left, its control on the right. */
function KnobRow({
  label,
  labelId,
  children,
}: {
  label: string;
  /** Id of the label text, for a control's `aria-labelledby`. */
  labelId?: string;
  children: ReactNode;
}) {
  return (
    <div className="set-row">
      <span className="set-row-label" id={labelId}>
        {label}
      </span>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

/**
 * Continuous font-scale knob: a percent slider plus a readout. The readout is
 * aria-hidden because the native range already exposes the numeric value to
 * assistive tech; repeating it here would announce the same number twice.
 */
function FontScaleRow({
  label,
  labelId,
  value,
  onChange,
}: {
  label: string;
  labelId: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <KnobRow label={label} labelId={labelId}>
      <span className="set-range-control">
        <input
          type="range"
          className="set-range"
          min={FONT_SCALE_MIN}
          max={FONT_SCALE_MAX}
          step={1}
          value={value}
          aria-labelledby={labelId}
          aria-valuetext={`${value}%`}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
        />
        <span className="set-range-value" aria-hidden="true">
          {value}%
        </span>
      </span>
    </KnobRow>
  );
}

/** Appearance settings: theme picker, accent override, motion, surfaces (with
 *  the blur/translucency knobs the Glass/Aero styles read), and font size. */
export default function AppearancePanel() {
  const {
    design,
    setAccent,
    setMotion,
    setSurfaces,
    setBlur,
    setTranslucency,
    setUiFont,
    setChatFont,
    setAppearance,
  } = useDesign();
  const { layout, setSide } = useLayout();
  const app = useAppMotion();
  const theme = useTheme();
  // Subscribe to the plugin-theme registry directly: `themeGroups` is a memo,
  // so it must recompute — not merely re-render — when a plugin theme
  // registers or drops (a disabled plugin's themes must disappear).
  const pluginThemes = useAtomValue(pluginThemesAtom);

  /**
   * Theme choices, grouped by kind. Derived from a memo (not a module-level
   * constant) so a plugin theme registered by the injector shows up — and one
   * whose plugin was disabled disappears — while the panel is mounted. Plugin
   * entries carry `kind` the same way built-ins do, so the split is uniform.
   */
  const themeGroups = useMemo(() => {
    const builtins: ThemeChoice[] = THEMES.map((item) => ({ ...item }));
    const plugins: ThemeChoice[] = pluginThemes.map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      pluginVars: entry.vars,
      pluginName: entry.pluginName,
    }));
    return splitByKind([...builtins, ...plugins]).filter((group) => group.items.length > 0);
  }, [pluginThemes]);

  /** Theme-default accent read from --accent. A layout effect (not a memo) so
   *  it runs after the theme attribute has been swapped, and re-reads whenever
   *  the theme id (or its resolved kind) changes while the panel is open. */
  const [themeAccent, setThemeAccent] = useState(FALLBACK_ACCENT);
  // themeKind reads the plugin-kind registry (a plain read); useTheme subscribes
  // to it, so a registry change re-renders and this picks up the new kind.
  const accentKind = themeKind(theme.current);

  useLayoutEffect(() => {
    // The theme attribute swap (theme.set -> applyTheme) is synchronous and has
    // already happened by the time layout effects run, so the computed --accent
    // is the new theme's. Passing both the id and the kind re-reads the derived
    // accent when a plugin registry change flips this id's kind.
    setThemeAccent(readThemeAccent(theme.current, accentKind));
  }, [theme.current, accentKind]);

  /** The accent currently painted: the override when set, else the theme's. */
  const activeAccent = design.accent ?? themeAccent;

  /** True when every knob already sits at its default — disables Reset. */
  const isDefault =
    design.accent === DEFAULT_DESIGN.accent &&
    design.motion === DEFAULT_DESIGN.motion &&
    design.surfaces === DEFAULT_DESIGN.surfaces &&
    design.blur === DEFAULT_DESIGN.blur &&
    design.translucency === DEFAULT_DESIGN.translucency &&
    design.uiFont === DEFAULT_DESIGN.uiFont &&
    design.chatFont === DEFAULT_DESIGN.chatFont;

  // Blur and translucency only paint under Glass/Aero; under Flat/Elevated the
  // two controls are disabled so they cannot imply an effect that won't render.
  const backdropApplies = design.surfaces === "glass" || design.surfaces === "aero";
  const blurOptions = BLUR_OPTIONS.map((option) => ({ ...option, disabled: !backdropApplies }));
  const translucencyOptions = TRANSLUCENCY_OPTIONS.map((option) => ({
    ...option,
    disabled: !backdropApplies,
  }));

  /**
   * Restore every appearance knob to its default in ONE atomic write.
   * `setAppearance` applies the whole patch and persists exactly once, so the
   * single PUT always carries the complete default state; seven separate
   * setters would race (each PUTs the whole object fire-and-forget, and the
   * last response to land would win regardless of order).
   */
  const resetAppearance = (): void => {
    setAppearance({ ...DEFAULT_DESIGN });
    // The override var is removed synchronously; re-read so the swatch shows
    // the theme default immediately.
    setThemeAccent(readThemeAccent(theme.current, accentKind));
  };

  return (
    <div className="set-stack">
      <section className="set-card">
        <CardHead
          title="Theme"
          desc="Choose a palette. Themes contributed by plugins appear here while their plugin is enabled."
        />
        <div className="set-card-body">
          {themeGroups.map((group) => (
            <fieldset className="set-theme-fieldset" key={group.label}>
              <legend className="set-theme-group-label">{group.label}</legend>
              <div className="set-theme-grid">
                {group.items.map((item) => {
                  const selected = item.id === theme.current;
                  return (
                    <motion.button
                      type="button"
                      className="set-theme-card"
                      key={item.id}
                      aria-pressed={selected}
                      onClick={() => theme.set(item.id)}
                      whileHover={app.reduce ? undefined : { y: -2 }}
                      whileTap={app.reduce ? undefined : { scale: 0.98 }}
                      transition={app.reduce ? INSTANT : app.spring.snappy}
                    >
                      <span
                        className="theme-swatch"
                        data-theme-id={item.id}
                        style={
                          item.pluginVars
                            ? { background: pluginSwatchBackground(item.pluginVars) }
                            : undefined
                        }
                      >
                        {selected && (
                          // Shared-layout check: Motion flies it from the
                          // previously selected swatch to the new one. Under
                          // reduce it snaps; either way the check is visible,
                          // so selection never depends on the animation.
                          <motion.span
                            layoutId="theme-selected-check"
                            className="theme-check"
                            aria-hidden="true"
                            transition={app.reduce ? INSTANT : app.spring.snappy}
                          >
                            <Check size={10} strokeWidth={3.5} />
                          </motion.span>
                        )}
                      </span>
                      <span className="set-theme-meta">
                        <span className="set-theme-name">{item.name}</span>
                        <span className="set-theme-kind">
                          {item.kind}
                          {item.pluginName && (
                            <span className="set-theme-plugin">{` · from ${item.pluginName}`}</span>
                          )}
                        </span>
                      </span>
                    </motion.button>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      </section>

      <section className="set-card">
        <CardHead
          title="Reading"
          desc="How large the conversation reads, and how much it moves. These are the controls most people need."
        />
        <div className="set-card-body is-flush">
          <FontScaleRow
            label="Chat text"
            labelId="chat-font-label"
            value={design.chatFont}
            onChange={setChatFont}
          />
          <KnobRow label="Motion">
            <Segmented
              options={MOTION_OPTIONS}
              value={design.motion}
              onChange={setMotion}
              ariaLabel="Motion intensity"
            />
          </KnobRow>
        </div>
      </section>

      <section className="set-card">
        <CardHead
          title="Navigation"
          desc="Where the main navigation sits. The content column fills the rest of the window."
        />
        <div className="set-card-body is-flush">
          <KnobRow label="Position" labelId="navigation-position-label">
            <Segmented
              options={SIDE_OPTIONS}
              value={layout.side}
              onChange={setSide}
              ariaLabelledBy="navigation-position-label"
            />
          </KnobRow>
        </div>
      </section>

      <AdvancedSection summary="Fine appearance, accent, surfaces, and interface scale">
        <section className="set-card">
          <CardHead
            title="Accent"
            desc="Tint buttons, links, focus rings, and badges. The theme default keeps each palette's own accent."
          />
          <div className="set-card-body is-flush">
            <div className="set-row">
              <span className="set-row-label">Accent color</span>
              <span className="set-row-control">
                <span className="set-accent-swatch">
                  <span className="set-accent-chip" style={{ background: activeAccent }} />
                  <input
                    type="color"
                    className="color-input"
                    aria-label="Accent color"
                    value={activeAccent}
                    onChange={(event) => setAccent(event.currentTarget.value)}
                  />
                </span>
                {design.accent !== null ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    aria-label="Reset accent to the theme default"
                    onClick={() => {
                      setAccent(null);
                      // The override var is removed synchronously; re-read so the
                      // swatch shows the theme default immediately.
                      setThemeAccent(readThemeAccent(theme.current, accentKind));
                    }}
                  >
                    <RotateCcw size={12} />
                    Theme default
                  </button>
                ) : (
                  <span className="color-hint">Theme default</span>
                )}
              </span>
            </div>
          </div>
        </section>

        <section className="set-card">
          <CardHead
            title="Surface"
            desc="How app chrome and cards are painted. Flat removes shadows; Glass adds translucency; Aero frosts the chrome with the same blur plus saturation, a specular sheen, and a crisper edge — neither touches the message area or the editors."
          />
          <div className="set-card-body is-flush">
            <KnobRow label="Style">
              <Segmented
                options={SURFACE_OPTIONS}
                value={design.surfaces}
                onChange={setSurfaces}
                ariaLabel="Surface style"
              />
            </KnobRow>
            {/* The disclaimer sits *above* the controls it governs, so their
              disabled state is explained before the user reaches them. */}
            <div className="set-card-body">
              <p className="caption muted">Blur and Translucency apply to Glass and Aero only.</p>
            </div>
            <KnobRow label="Blur">
              <Segmented
                options={blurOptions}
                value={design.blur}
                onChange={setBlur}
                ariaLabel="Backdrop blur"
              />
            </KnobRow>
            <KnobRow label="Translucency">
              <Segmented
                options={translucencyOptions}
                value={design.translucency}
                onChange={setTranslucency}
                ariaLabel="Chrome translucency"
              />
            </KnobRow>
          </div>
        </section>

        <section className="set-card">
          <CardHead
            title="Interface size"
            desc="Scales the whole app. Chat text above scales the conversation on top of it."
          />
          <div className="set-card-body is-flush">
            <FontScaleRow
              label="Interface"
              labelId="ui-font-label"
              value={design.uiFont}
              onChange={setUiFont}
            />
          </div>
        </section>

        <div className="row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={resetAppearance}
            disabled={isDefault}
          >
            <RotateCcw size={14} />
            Reset appearance
          </button>
        </div>
      </AdvancedSection>
    </div>
  );
}
