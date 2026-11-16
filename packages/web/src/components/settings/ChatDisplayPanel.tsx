/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/cx";
import { WRITING_STYLES } from "../../lib/writing-styles";
import { MAX_MAX_MESSAGES, MIN_MAX_MESSAGES, useChatHistory } from "../../stores/chat-history";
import type { TimestampFormat, TimestampMode } from "../../stores/formatting";
import { useFormatting } from "../../stores/formatting";
import type { MessageView } from "../../stores/layout";
import { useLayout } from "../../stores/layout";
import {
  MAX_STREAMING_INDICATOR_LABEL,
  useStreamingIndicator,
} from "../../stores/streaming-indicator";
import {
  MAX_SUMMARIZATION_INDICATOR_LABEL,
  useSummarizationIndicator,
} from "../../stores/summarization-indicator";
import { MAX_TRACKER_INDICATOR_LABEL, useTrackerIndicator } from "../../stores/tracker-indicator";
import { useWriting } from "../../stores/writing";
import "../../styles/settings.css";
import { RotateCcw } from "../ui/icons";
import type { SegmentedOption } from "../ui/segmented";
import { Segmented } from "../ui/segmented";
import AdvancedSection from "./AdvancedSection";
import { NumberStepper } from "./Stepper";
import WritingPreview from "./WritingPreview";

/** Toggle rows for the message-formatting group; keys map onto the store. */
const FORMATTING_OPTIONS = [
  {
    key: "quotes",
    label: "Highlight quotes",
    hint: "Quoted speech is wrapped in a distinct color.",
  },
  {
    key: "italics",
    label: "Italicize asterisks",
    hint: "Text wrapped in single asterisks becomes italic.",
  },
  {
    key: "bold",
    label: "Bold",
    hint: "Text wrapped in double asterisks becomes bold.",
  },
  {
    key: "underline",
    label: "Underline",
    hint: "Text wrapped in double underscores is underlined.",
  },
  {
    key: "renderHtml",
    label: "Render HTML in messages",
    hint: "Render the sanitized HTML/CSS the model outputs; turn off to show tags as plain text.",
  },
] as const;

/** Highlight color rows: store key, label, and the CSS var that carries the
 *  theme default while the stored color is null. */
const COLOR_OPTIONS = [
  { key: "quoteColor", label: "Quote text", cssVar: "--msg-quote" },
  { key: "italicColor", label: "Italic text", cssVar: "--msg-em" },
  { key: "underlineColor", label: "Underline text", cssVar: "--msg-underline" },
] as const;

type ColorKey = (typeof COLOR_OPTIONS)[number]["key"];

/** Timestamp visibility modes. */
const MODE_OPTIONS: readonly SegmentedOption<TimestampMode>[] = [
  { value: "always", label: "Always visible" },
  { value: "hover", label: "Show on hover" },
  { value: "off", label: "Disabled" },
];

/** Transcript layouts; "transcript" is the unboxed shared-column default. */
const VIEW_OPTIONS: readonly SegmentedOption<MessageView>[] = [
  { value: "transcript", label: "Transcript" },
  { value: "bubbles", label: "Bubbles" },
  { value: "flat", label: "Single column" },
];

/** Timestamp format choices; each row previews its own format live. */
const FORMAT_OPTIONS = [
  { id: "full", name: "Full" },
  { id: "short", name: "Short" },
  { id: "time", name: "Time only" },
  { id: "date", name: "Date only" },
  { id: "relative", name: "Relative" },
] as const;

/** Neutral gray for an unset theme var — a color input always needs a value. */
const FALLBACK_COLOR = "#808080";

/** Reads a --msg-* theme var from the document root, trimmed; an empty value
 *  (var not defined) falls back to a neutral gray. */
function readThemeColor(cssVar: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  return value === "" ? FALLBACK_COLOR : value;
}

/** Intl.DateTimeFormat is expensive to construct, so cache one per option set. */
const previewFormatters = new Map<string, Intl.DateTimeFormat>();

function formatDateTime(date: Date, options: Intl.DateTimeFormatOptions): string {
  const key = JSON.stringify(options);
  let formatter = previewFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(undefined, options);
    previewFormatters.set(key, formatter);
  }
  return formatter.format(date);
}

/** Coarse relative labels; past a week we fall back to the medium date. */
function formatRelative(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return formatDateTime(date, { dateStyle: "medium" });
}

/**
 * Format a date in a given timestamp format — a local mirror of the store's
 * formatTimestamp mapping (which renders only the *active* format), so every
 * option row can preview its own format at once.
 */
function previewTimestamp(format: TimestampFormat, date: Date): string {
  switch (format) {
    case "short":
      return formatDateTime(date, { dateStyle: "medium", timeStyle: "short" });
    case "time":
      return formatDateTime(date, { timeStyle: "short" });
    case "date":
      return formatDateTime(date, { dateStyle: "medium" });
    case "relative":
      return formatRelative(date);
    default:
      return formatDateTime(date, { dateStyle: "long", timeStyle: "short" });
  }
}

/** Card header with a title and its one-line explanation. */
function CardHead({ title, desc }: { title: string; desc: string }) {
  return (
    <header className="set-card-head">
      <div className="set-card-heading">
        <h3 className="set-card-title">{title}</h3>
        <p className="set-card-desc">{desc}</p>
      </div>
    </header>
  );
}

export interface IndicatorCardProps {
  /** DOM-id base for the master switch / dot inputs (unique per card). */
  id: string;
  title: string;
  desc: string;
  placeholder: string;
  maxLength: number;
  /** Accessible name of the label text input. */
  labelAria: string;
  show: boolean;
  onShow: (value: boolean) => void;
  label: string;
  onLabel: (value: string) => void;
  dot: boolean;
  onDot: (value: boolean) => void;
}

/**
 * One chat status-pill preference card (Streaming / Tracker / Summarization).
 * The three were ~210 lines of identical markup; they differ only in copy,
 * the bound store, and the label length cap. The dependent rows sit in a
 * disabled `.set-fields` fieldset, so the browser disables every control for
 * free while the master switch is off.
 */
function IndicatorCard(props: IndicatorCardProps) {
  return (
    <section className="set-card">
      <CardHead title={props.title} desc={props.desc} />
      <div className="set-card-body is-flush">
        <div className="set-rows">
          <label className="set-row switch-row" htmlFor={`${props.id}-show`}>
            <span className="set-row-main">
              <span className="set-row-label">{props.title}</span>
              <span className="set-row-hint">{props.desc}</span>
            </span>
            <span className="switch">
              <input
                id={`${props.id}-show`}
                type="checkbox"
                className="switch-input"
                checked={props.show}
                onChange={(event) => props.onShow(event.currentTarget.checked)}
              />
              <span className="switch-track">
                <span className="switch-thumb" />
              </span>
            </span>
          </label>
        </div>
      </div>
      <fieldset className="set-fields" disabled={!props.show}>
        <div className="set-rows">
          <div className="set-row">
            <span className="set-row-main">
              <span className="set-row-label">Label</span>
              <span className="set-row-hint">
                Text shown in the pill; leave empty for a dot-only indicator.
              </span>
            </span>
            <input
              className="input"
              type="text"
              aria-label={props.labelAria}
              maxLength={props.maxLength}
              placeholder={props.placeholder}
              value={props.label}
              onChange={(event) => props.onLabel(event.currentTarget.value)}
            />
          </div>
          <label className="set-row switch-row" htmlFor={`${props.id}-dot`}>
            <span className="set-row-main">
              <span className="set-row-label">Pulsing dot</span>
              <span className="set-row-hint">Animate a small pulsing dot next to the label.</span>
            </span>
            <span className="switch">
              <input
                id={`${props.id}-dot`}
                type="checkbox"
                className="switch-input"
                checked={props.dot}
                onChange={(event) => props.onDot(event.currentTarget.checked)}
              />
              <span className="switch-track">
                <span className="switch-thumb" />
              </span>
            </span>
          </label>
        </div>
      </fieldset>
    </section>
  );
}

/** Chat display settings: history window, message formatting, highlight colors, timestamps. */
export default function ChatDisplayPanel() {
  const { formatting, setFormatting, timestamps, setTimestamps } = useFormatting();
  const { chatHistory, setMaxMessages } = useChatHistory();
  const { layout, setMessageView, setSwipeGestures, toggleElement } = useLayout();
  const { writingStyle, setWritingStyle } = useWriting();
  const {
    streamingIndicator,
    setShow: setStreamingShow,
    setLabel: setStreamingLabel,
    setDot: setStreamingDot,
  } = useStreamingIndicator();
  const { trackerIndicator, setShow, setLabel, setDot } = useTrackerIndicator();
  const {
    summarizationIndicator,
    setShow: setSummarizationShow,
    setLabel: setSummarizationLabel,
    setDot: setSummarizationDot,
  } = useSummarizationIndicator();

  /** Ticks every second; the format previews re-render against the live clock. */
  const [now, setNow] = useState(Date.now());

  /** Theme-default colors read from the CSS vars once on mount; re-entering
   *  the section re-reads them, so a theme switch is picked up on the next
   *  visit (the theme picker lives in the Appearance section). */
  const [themeColors, setThemeColors] = useState<Record<ColorKey, string>>({
    quoteColor: FALLBACK_COLOR,
    italicColor: FALLBACK_COLOR,
    underlineColor: FALLBACK_COLOR,
  });

  /** The interval id lives in a ref so the cleanup returned by the effect can
   *  clear exactly the timer it started. */
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const next = {} as Record<ColorKey, string>;
    for (const option of COLOR_OPTIONS) {
      next[option.key] = readThemeColor(option.cssVar);
    }
    setThemeColors(next);

    timerRef.current = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
      }
    };
  }, []);

  return (
    <div className="set-stack">
      <section className="set-card">
        <CardHead
          title="Conversation"
          desc="How messages read. Transcript is the quiet, shared-column default; Bubbles keeps each role on its own side."
        />
        <div className="set-card-body">
          <div className="field">
            <span className="field-label" id="message-view-label">
              Presentation
            </span>
            <Segmented
              options={VIEW_OPTIONS}
              value={layout.messageView}
              onChange={(value) => setMessageView(value)}
              ariaLabelledBy="message-view-label"
            />
            <span className="field-hint">
              Transcript removes message boxes and puts both speakers on one reading edge.
            </span>
          </div>
        </div>
        <div className="set-card-body is-flush">
          <div className="set-rows">
            <label className="set-row switch-row" htmlFor="chat-avatars">
              <span className="set-row-main">
                <span className="set-row-label">Avatars</span>
                <span className="set-row-hint">Show each speaker's image beside their name.</span>
              </span>
              <span className="switch">
                <input
                  id="chat-avatars"
                  type="checkbox"
                  className="switch-input"
                  checked={layout.elements.avatars}
                  onChange={() => toggleElement("avatars")}
                />
                <span className="switch-track">
                  <span className="switch-thumb" />
                </span>
              </span>
            </label>
            <div className="set-row">
              <span className="set-row-main">
                <span className="set-row-label">Timestamps</span>
                <span className="set-row-hint">When each message's time appears.</span>
              </span>
              <span className="set-row-control">
                <Segmented
                  options={MODE_OPTIONS}
                  value={timestamps.mode}
                  onChange={(value) => setTimestamps("mode", value)}
                  ariaLabel="Timestamp visibility"
                />
              </span>
            </div>
          </div>
        </div>
      </section>

      <AdvancedSection summary="History, reveal pacing, formatting, colors, and status indicators">
        <section className="set-card">
          <CardHead
            title="History"
            desc="How much of the transcript is kept in the DOM as you scroll."
          />
          <div className="set-card-body is-flush">
            <div className="set-rows">
              <div className="set-row">
                <span className="set-row-main">
                  <span className="set-row-label">Messages rendered</span>
                  <span className="set-row-hint">
                    How many recent messages stay in the transcript. Older ones load as you scroll
                    up; scrolling back down unloads them.
                  </span>
                </span>
                <NumberStepper
                  className="set-stepper"
                  label="Messages rendered"
                  value={chatHistory.maxMessages}
                  min={MIN_MAX_MESSAGES}
                  max={MAX_MAX_MESSAGES}
                  onChange={setMaxMessages}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="set-card">
          <CardHead
            title="Streaming text reveal"
            desc="How a reply types itself out — the pacing of the text and the caret that trails it. Each card previews its own style."
          />
          <div className="set-card-body">
            <div role="radiogroup" aria-label="Streaming text reveal" className="writing-options">
              {WRITING_STYLES.map((style) => (
                <label
                  className={cx("writing-option", writingStyle === style.id && "is-active")}
                  key={style.id}
                >
                  <input
                    type="radio"
                    name="writing-style"
                    className="writing-radio"
                    value={style.id}
                    checked={writingStyle === style.id}
                    onChange={() => setWritingStyle(style.id)}
                  />
                  <span className="writing-option-head">
                    <span className="writing-option-name">{style.label}</span>
                    <span className="writing-option-desc">{style.description}</span>
                  </span>
                  <WritingPreview style={style.id} />
                </label>
              ))}
            </div>
          </div>
        </section>

        <section className="set-card">
          <CardHead
            title="Swipe gestures"
            desc="On touch screens, swipe a message sideways to move through its swipes."
          />
          <div className="set-card-body is-flush">
            <div className="set-rows">
              <label className="set-row switch-row" htmlFor="swipe-gestures">
                <span className="set-row-main">
                  <span className="set-row-label">Swipe to change swipes</span>
                  <span className="set-row-hint">
                    Swipe a message right-to-left for the next swipe (a new one on the last reply),
                    left-to-right for the previous.
                  </span>
                </span>
                <span className="switch">
                  <input
                    id="swipe-gestures"
                    type="checkbox"
                    className="switch-input"
                    checked={layout.swipeGestures}
                    onChange={() => setSwipeGestures(!layout.swipeGestures)}
                  />
                  <span className="switch-track">
                    <span className="switch-thumb" />
                  </span>
                </span>
              </label>
            </div>
          </div>
        </section>

        <section className="set-card">
          <CardHead
            title="Message formatting"
            desc="How the model's markdown is turned into chat text."
          />
          <div className="set-card-body is-flush">
            <div className="set-rows">
              {FORMATTING_OPTIONS.map((item) => (
                <label
                  className="set-row switch-row"
                  htmlFor={`formatting-${item.key}`}
                  key={item.key}
                >
                  <span className="set-row-main">
                    <span className="set-row-label">{item.label}</span>
                    <span className="set-row-hint">{item.hint}</span>
                  </span>
                  <span className="switch">
                    <input
                      id={`formatting-${item.key}`}
                      type="checkbox"
                      className="switch-input"
                      checked={formatting[item.key]}
                      onChange={() => setFormatting(item.key, !formatting[item.key])}
                    />
                    <span className="switch-track">
                      <span className="switch-thumb" />
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </section>

        <section className="set-card">
          <CardHead
            title="Highlight colors"
            desc="Overrides for the theme's quote, italic, and underline colors."
          />
          <div className="set-card-body is-flush">
            <div className="set-rows">
              {COLOR_OPTIONS.map((option) => (
                <div className="set-row" key={option.key}>
                  <span className="set-row-label">{option.label}</span>
                  <span className="set-row-control color-controls">
                    <input
                      type="color"
                      className="color-input"
                      aria-label={`${option.label} highlight color`}
                      value={formatting[option.key] ?? themeColors[option.key]}
                      onChange={(event) => setFormatting(option.key, event.currentTarget.value)}
                    />
                    {formatting[option.key] !== null ? (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        aria-label={`Reset ${option.label} to the theme default`}
                        onClick={() => setFormatting(option.key, null)}
                      >
                        <RotateCcw size={12} />
                        Theme default
                      </button>
                    ) : (
                      <span className="color-hint">Theme default</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="set-card">
          <CardHead
            title="Timestamp format"
            desc="How each timestamp is written. Visibility lives in Conversation above."
          />
          <div className="set-card-body">
            <div role="radiogroup" aria-label="Timestamp format" className="stack">
              {FORMAT_OPTIONS.map((format) => (
                <label
                  className={cx("timestamp-row", timestamps.format === format.id && "is-active")}
                  key={format.id}
                >
                  <input
                    type="radio"
                    name="timestamp-format"
                    className="timestamp-radio"
                    value={format.id}
                    checked={timestamps.format === format.id}
                    onChange={() => setTimestamps("format", format.id)}
                  />
                  <span className="timestamp-dot" aria-hidden="true" />
                  <span className="timestamp-name">{format.name}</span>
                  <span className="timestamp-preview">
                    {previewTimestamp(format.id, new Date(now))}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </section>

        {/* Streaming indicator preferences — streaming is the primary stage, so
          its card leads the three. */}
        <IndicatorCard
          id="streaming-indicator"
          title="Streaming indicator"
          desc="A status pill at the top of the chat while a reply streams."
          placeholder="Streaming…"
          maxLength={MAX_STREAMING_INDICATOR_LABEL}
          labelAria="Streaming indicator label"
          show={streamingIndicator.show}
          onShow={setStreamingShow}
          label={streamingIndicator.label}
          onLabel={setStreamingLabel}
          dot={streamingIndicator.dot}
          onDot={setStreamingDot}
        />

        <IndicatorCard
          id="tracker-indicator"
          title="Tracker indicator"
          desc="A status pill at the top of the chat while a tracker snapshot generates."
          placeholder="Tracking…"
          maxLength={MAX_TRACKER_INDICATOR_LABEL}
          labelAria="Tracker indicator label"
          show={trackerIndicator.show}
          onShow={setShow}
          label={trackerIndicator.label}
          onLabel={setLabel}
          dot={trackerIndicator.dot}
          onDot={setDot}
        />

        <IndicatorCard
          id="summarization-indicator"
          title="Summarization indicator"
          desc="A status pill at the top of the chat while a summary generates."
          placeholder="Summarizing…"
          maxLength={MAX_SUMMARIZATION_INDICATOR_LABEL}
          labelAria="Summarization indicator label"
          show={summarizationIndicator.show}
          onShow={setSummarizationShow}
          label={summarizationIndicator.label}
          onLabel={setSummarizationLabel}
          dot={summarizationIndicator.dot}
          onDot={setSummarizationDot}
        />
      </AdvancedSection>
    </div>
  );
}
