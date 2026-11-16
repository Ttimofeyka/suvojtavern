/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import { trackerPalette } from "./TemplateFrame";

/*
 * TemplateFrame itself needs a DOM (getComputedStyle, an iframe), so the frame
 * is not rendered here. What these tests pin down is the PALETTE CONTRACT that
 * makes the tracker follow the active theme: every `--tf-*` token draws from
 * the mapped theme token, a theme that defines its tokens never sees a literal,
 * and a missing token falls back per kind instead of rendering blank.
 */

/** A token reader over a plain map — stands in for the live computed style. */
function reader(tokens: Record<string, string>): (name: string) => string {
  return (name) => tokens[name] ?? "";
}

/** The dark fixture: every source token `trackerPalette` reads. */
const LIGHT_THEME = {
  "--bg-elev": "#fffdf8",
  "--fg": "#2f2a22",
  "--border-strong": "#d8d0bf",
  "--bg-subtle": "#f6f1e6",
  "--border": "#e9e1d1",
  "--fg-muted": "#6f6656",
  "--fg-faint": "#8d8371",
  "--warning": "#b98a2e",
  "--accent": "#2b5f8f",
  "--badge-fg": "#1d4a73",
  "--badge-bg": "color-mix(in srgb, #2b5f8f 14%, transparent)",
};

/** Parses the emitted block into a name -> value map. */
function parse(block: string): Record<string, string> {
  return Object.fromEntries(
    block
      .split(";")
      .filter((entry) => entry !== "")
      .map((entry) => {
        const at = entry.indexOf(":");
        return [entry.slice(0, at), entry.slice(at + 1)];
      }),
  );
}

describe("trackerPalette", () => {
  it("derives every token from the active theme's cascade", () => {
    const palette = parse(trackerPalette("light", reader(LIGHT_THEME)));

    expect(palette["--tf-card-bg"]).toBe("#fffdf8");
    expect(palette["--tf-card-fg"]).toBe("#2f2a22");
    expect(palette["--tf-card-border"]).toBe("#d8d0bf");
    expect(palette["--tf-section-border"]).toBe("#e9e1d1");
    expect(palette["--tf-label"]).toBe("#6f6656");
    expect(palette["--tf-section-name"]).toBe("#8d8371");
    expect(palette["--tf-scene-accent"]).toBe("#b98a2e");
    expect(palette["--tf-character-accent"]).toBe("#2b5f8f");
    expect(palette["--tf-character-name"]).toBe("#1d4a73");
    expect(palette["--tf-topic-fg"]).toBe("#1d4a73");
    expect(palette["--tf-topic-bg"]).toBe(LIGHT_THEME["--badge-bg"]);
  });

  it("keeps the two accent roles distinct", () => {
    const palette = parse(trackerPalette("light", reader(LIGHT_THEME)));
    expect(palette["--tf-scene-accent"]).not.toBe(palette["--tf-character-accent"]);
  });

  it("derives the section well from the card, not the page's recessed surface", () => {
    const palette = parse(trackerPalette("light", reader(LIGHT_THEME)));
    expect(palette["--tf-section-bg"]).toBe("color-mix(in srgb, #2f2a22 7%, #fffdf8)");
  });

  it("builds the pill edge from the theme accent at border alpha", () => {
    const palette = parse(trackerPalette("dark", reader({ "--accent": "#5b9df9" })));
    expect(palette["--tf-topic-border"]).toBe("color-mix(in srgb, #5b9df9 35%, transparent)");
  });

  it("falls back per kind for tokens the theme does not define", () => {
    const dark = parse(trackerPalette("dark", reader({})));
    const light = parse(trackerPalette("light", reader({})));
    expect(dark["--tf-card-bg"]).toBe("#15171d");
    expect(light["--tf-card-bg"]).toBe("#fffdf8");
    expect(dark["--tf-card-fg"]).not.toBe(light["--tf-card-fg"]);
    // A fallback still reaches every token, so no declaration renders empty.
    for (const name of Object.keys(dark)) {
      expect(light[name], name).not.toBe("");
      expect(light[name], name).not.toBeUndefined();
    }
  });

  it("fills a fallback only for the token whose source is missing", () => {
    const palette = parse(trackerPalette("light", reader({ "--fg": "#2f2a22" })));
    expect(palette["--tf-card-fg"]).toBe("#2f2a22");
    expect(palette["--tf-card-bg"]).toBe("#fffdf8");
  });

  it("neutralizes a token value that could escape the declaration block", () => {
    const palette = parse(
      trackerPalette("dark", reader({ "--bg-elev": "red}</style><script>x</script>" })),
    );
    const block = trackerPalette("dark", reader({ "--bg-elev": "red}</style><script>x" }));
    expect(palette["--tf-card-bg"]).toBe("red/stylescriptx/script");
    expect(block).not.toContain("<");
    expect(block).not.toContain("}");
  });
});

describe("trackerPalette tokens", () => {
  it("covers the whole `--tf-*` contract the shipped tracker CSS reads", () => {
    const block = trackerPalette("dark", reader({}));
    for (const name of [
      "--tf-card-bg",
      "--tf-card-fg",
      "--tf-card-border",
      "--tf-section-bg",
      "--tf-section-border",
      "--tf-scene-accent",
      "--tf-character-accent",
      "--tf-character-name",
      "--tf-label",
      "--tf-section-name",
      "--tf-topic-fg",
      "--tf-topic-bg",
      "--tf-topic-border",
    ]) {
      expect(block, name).toContain(`${name}:`);
    }
  });
});
