/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "bun:test";
import {
  compositeOver,
  contrastRatio,
  ensureContrast,
  normalizeHexColor,
  pageSurfaces,
  readableForeground,
  shade,
  storedDesign,
} from "./design";

describe("storedDesign", () => {
  it("falls back to the defaults for null and non-object shapes", () => {
    const defaults = {
      accent: null,
      motion: "full",
      surfaces: "elevated",
      blur: "medium",
      translucency: "balanced",
      uiFont: 100,
      chatFont: 100,
    };
    expect(storedDesign(null)).toEqual(defaults);
    expect(storedDesign(undefined)).toEqual(defaults);
    expect(storedDesign("glass")).toEqual(defaults);
    expect(storedDesign(42)).toEqual(defaults);
  });

  it("accepts valid accent, motion, surface, blur, translucency, and font values", () => {
    expect(
      storedDesign({
        accent: "#62aef0",
        motion: "subtle",
        surfaces: "glass",
        blur: "heavy",
        translucency: "dense",
        uiFont: 125,
        chatFont: 88,
      }),
    ).toEqual({
      accent: "#62aef0",
      motion: "subtle",
      surfaces: "glass",
      blur: "heavy",
      translucency: "dense",
      uiFont: 125,
      chatFont: 88,
    });
  });

  it("accepts a null accent (theme default)", () => {
    expect(storedDesign({ accent: null }).accent).toBeNull();
  });

  it("rejects invalid accents", () => {
    expect(storedDesign({ accent: "red" }).accent).toBeNull();
    expect(storedDesign({ accent: "#fff" }).accent).toBeNull();
    expect(storedDesign({ accent: "#gggggg" }).accent).toBeNull();
    expect(storedDesign({ accent: 123 }).accent).toBeNull();
  });

  it("rejects invalid motion and surface values", () => {
    expect(storedDesign({ motion: "fast" }).motion).toBe("full");
    expect(storedDesign({ motion: 1 }).motion).toBe("full");
    expect(storedDesign({ surfaces: "shiny" }).surfaces).toBe("elevated");
    expect(storedDesign({ surfaces: null }).surfaces).toBe("elevated");
    expect(storedDesign({ surfaces: "glass" }).surfaces).toBe("glass");
    expect(storedDesign({ surfaces: "aero" }).surfaces).toBe("aero");
  });

  it("accepts valid blur and translucency values", () => {
    expect(storedDesign({ blur: "light" }).blur).toBe("light");
    expect(storedDesign({ blur: "heavy" }).blur).toBe("heavy");
    expect(storedDesign({ translucency: "sheer" }).translucency).toBe("sheer");
    expect(storedDesign({ translucency: "dense" }).translucency).toBe("dense");
  });

  it("rejects invalid blur and translucency values back to their defaults", () => {
    expect(storedDesign({ blur: "extreme" }).blur).toBe("medium");
    expect(storedDesign({ blur: 3 }).blur).toBe("medium");
    expect(storedDesign({ blur: null }).blur).toBe("medium");
    expect(storedDesign({ translucency: "opaque" }).translucency).toBe("balanced");
    expect(storedDesign({ translucency: false }).translucency).toBe("balanced");
    expect(storedDesign({ translucency: null }).translucency).toBe("balanced");
  });

  it("merges blur and translucency independently", () => {
    expect(storedDesign({ blur: "heavy" })).toEqual({
      accent: null,
      motion: "full",
      surfaces: "elevated",
      blur: "heavy",
      translucency: "balanced",
      uiFont: 100,
      chatFont: 100,
    });
    expect(storedDesign({ translucency: "sheer" })).toEqual({
      accent: null,
      motion: "full",
      surfaces: "elevated",
      blur: "medium",
      translucency: "sheer",
      uiFont: 100,
      chatFont: 100,
    });
  });

  it("defaults font scales when missing, invalid, or not a finite number", () => {
    expect(storedDesign({ uiFont: null }).uiFont).toBe(100);
    expect(storedDesign({ chatFont: undefined }).chatFont).toBe(100);
    expect(storedDesign({ uiFont: true }).uiFont).toBe(100);
    expect(storedDesign({ uiFont: Number.NaN }).uiFont).toBe(100);
    expect(storedDesign({ chatFont: Number.POSITIVE_INFINITY }).chatFont).toBe(100);
    expect(storedDesign({ uiFont: "huge" }).uiFont).toBe(100);
    expect(storedDesign({ chatFont: "MEDIUM" }).chatFont).toBe(100);
    // Close-but-invalid ids must not be mistaken for legacy presets.
    expect(storedDesign({ uiFont: "xsmallest" }).uiFont).toBe(100);
    expect(storedDesign({ chatFont: "tiny" }).chatFont).toBe(100);
  });

  it("rounds and clamps numeric font scales into the supported range", () => {
    expect(storedDesign({ uiFont: 112 }).uiFont).toBe(112);
    expect(storedDesign({ uiFont: 87.6 }).uiFont).toBe(88);
    expect(storedDesign({ uiFont: 40 }).uiFont).toBe(75);
    expect(storedDesign({ uiFont: 400 }).uiFont).toBe(150);
    expect(storedDesign({ chatFont: 74.4 }).chatFont).toBe(75);
    expect(storedDesign({ chatFont: 149.6 }).chatFont).toBe(150);
  });

  it("migrates the legacy named presets onto their former percentages", () => {
    const presets = {
      xsmall: 81,
      small: 88,
      medium: 100,
      large: 113,
      xlarge: 125,
      xxlarge: 150,
    } as const;
    for (const [preset, expected] of Object.entries(presets)) {
      expect(storedDesign({ uiFont: preset }).uiFont).toBe(expected);
      expect(storedDesign({ chatFont: preset }).chatFont).toBe(expected);
    }
  });

  it("merges each font scale independently", () => {
    expect(storedDesign({ uiFont: 113 })).toEqual({
      accent: null,
      motion: "full",
      surfaces: "elevated",
      blur: "medium",
      translucency: "balanced",
      uiFont: 113,
      chatFont: 100,
    });
    expect(storedDesign({ chatFont: 88 })).toEqual({
      accent: null,
      motion: "full",
      surfaces: "elevated",
      blur: "medium",
      translucency: "balanced",
      uiFont: 100,
      chatFont: 88,
    });
  });

  it("round-trips the endpoints with every other field at its default", () => {
    expect(storedDesign({ uiFont: 150, chatFont: 75 })).toEqual({
      accent: null,
      motion: "full",
      surfaces: "elevated",
      blur: "medium",
      translucency: "balanced",
      uiFont: 150,
      chatFont: 75,
    });
  });
});

describe("contrastRatio", () => {
  it("returns 21 for black on white and 1 for a color on itself", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#62aef0", "#62aef0")).toBeCloseTo(1, 5);
  });
});

describe("ensureContrast", () => {
  it("leaves an already-compliant color unchanged", () => {
    expect(ensureContrast("#000000", "#ffffff", 4.5)).toBe("#000000");
    expect(ensureContrast("#ffffff", "#000000", 4.5)).toBe("#ffffff");
  });

  it("darkens a light accent on a light background to meet 4.5:1", () => {
    const result = ensureContrast("#ffff00", "#ffffff", 4.5);
    expect(result).not.toBe("#ffff00");
    expect(contrastRatio(result, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("lightens a dark accent on a dark background to meet 4.5:1", () => {
    const result = ensureContrast("#000080", "#1e1d1b", 4.5);
    expect(result).not.toBe("#000080");
    expect(contrastRatio(result, "#1e1d1b")).toBeGreaterThanOrEqual(4.5);
  });

  it("stays deterministic across calls", () => {
    expect(ensureContrast("#ffff00", "#ffffff", 4.5)).toBe(
      ensureContrast("#ffff00", "#ffffff", 4.5),
    );
  });

  it("keeps a hover derived from the text-safe accent readable on the page", () => {
    // The raw-accent hover used to fail these (1.79:1, 2.38:1, 1.93:1); the
    // hover is now derived from the text-safe accent and re-checked.
    const cases: Array<[string, string, "dark" | "light"]> = [
      ["#ffd166", "#ffffff", "light"],
      ["#4ecdc4", "#ffffff", "light"],
      ["#333333", "#1e1d1b", "dark"],
    ];
    for (const [accent, page, kind] of cases) {
      const textAccent = ensureContrast(accent, page, 4.5);
      const hover = ensureContrast(shade(textAccent, kind === "dark" ? 0.12 : -0.1), page, 4.5);
      expect(contrastRatio(hover, page)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("compositeOver", () => {
  it("alpha-composites a tint over an opaque base", () => {
    // 0% black over white is white; 14% black over white is #dbdbdb.
    expect(compositeOver("#000000", 0, "#ffffff")).toBe("#ffffff");
    expect(compositeOver("#000000", 0.14, "#ffffff")).toBe("#dbdbdb");
  });

  it("composites a saturated tint to a deterministic valid hex", () => {
    expect(compositeOver("#ff00ff", 0.14, "#ffffff")).toBe("#ffdbff");
    expect(compositeOver("#ff00ff", 0.14, "#ffffff")).toBe(
      compositeOver("#ff00ff", 0.14, "#ffffff"),
    );
    expect(compositeOver("#ff00ff", 0.14, "#ffffff")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("clamps the tint amount to 0..1", () => {
    expect(compositeOver("#000000", -1, "#ffffff")).toBe("#ffffff");
    expect(compositeOver("#000000", 2, "#ffffff")).toBe("#000000");
  });

  it("validates badge text against the painted tint, not the bare page", () => {
    // A magenta accent used to leave --badge-fg at 3.63:1 on the tint; the
    // foreground is now checked against the composite and clears 4.5:1.
    const accent = "#ff00ff";
    const page = "#ffffff";
    const textAccent = ensureContrast(accent, page, 4.5);
    const composite = compositeOver(accent, 0.14, page);
    const badgeFg = ensureContrast(textAccent, composite, 4.5);
    expect(contrastRatio(badgeFg, composite)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("pageSurfaces", () => {
  it("falls back to kind-based opaque surfaces without a stylesheet", () => {
    expect(pageSurfaces("light")).toEqual(["#ffffff", "#ffffff", "#f4f3f1"]);
    expect(pageSurfaces("dark")).toEqual(["#1e1d1b", "#262522", "#2a2926"]);
  });

  it("returns a valid hex color for every surface", () => {
    for (const kind of ["light", "dark"] as const) {
      for (const surface of pageSurfaces(kind)) {
        expect(surface).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("expands a short computed value instead of taking the fallback path", () => {
    // Regression for the minifier case: this mirrors exactly what pageSurfaces
    // does per token — normalize, then fall back only on null. The production
    // build minifies CSS with lightningcss, which shortens #ffffff to #fff, so
    // a minified `--bg: #fff` must yield #ffffff, never the light fallback
    // literal, and must never reach hexToRgb in its 3-digit form (which would
    // mis-parse). pageSurfaces reads the live DOM, so the pure normalizer is
    // the hermetic test surface for the parse/expand behavior.
    expect(normalizeHexColor("#fff") ?? "#ffffff").toBe("#ffffff");
    expect(normalizeHexColor("#f00")).toBe("#ff0000");
    expect(normalizeHexColor("#f00")).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("normalizeHexColor", () => {
  it("expands 3-digit hex and lowercases 6-digit hex", () => {
    expect(normalizeHexColor("#fff")).toBe("#ffffff");
    expect(normalizeHexColor("#f00")).toBe("#ff0000");
    expect(normalizeHexColor("#ffffff")).toBe("#ffffff");
    expect(normalizeHexColor("#FFFFFF")).toBe("#ffffff");
    expect(normalizeHexColor("#AbC")).toBe("#aabbcc");
  });

  it("returns null for anything that is not a 3- or 6-digit hex", () => {
    expect(normalizeHexColor("red")).toBeNull();
    expect(normalizeHexColor("#ff")).toBeNull();
    expect(normalizeHexColor("#ffff")).toBeNull();
    expect(normalizeHexColor("#gggggg")).toBeNull();
    expect(normalizeHexColor("")).toBeNull();
    expect(normalizeHexColor(null)).toBeNull();
    expect(normalizeHexColor(undefined)).toBeNull();
    expect(normalizeHexColor(123)).toBeNull();
    expect(normalizeHexColor({})).toBeNull();
  });
});

describe("badge foreground worst-case surface", () => {
  const BADGE_TINT = 0.14;

  /** Mirrors applyAccent's worst-case badge selection. */
  function badgeForeground(accent: string, surfaces: string[]): string {
    const textAccent = ensureContrast(accent, surfaces[0], 4.5);
    const composites = surfaces.map((surface) => compositeOver(accent, BADGE_TINT, surface));
    const worst = composites.reduce((currentWorst, surface) =>
      contrastRatio(textAccent, surface) < contrastRatio(textAccent, currentWorst)
        ? surface
        : currentWorst,
    );
    return ensureContrast(textAccent, worst, 4.5);
  }

  function expectClearsEverySurface(accent: string, surfaces: string[]): void {
    const badgeFg = badgeForeground(accent, surfaces);
    for (const surface of surfaces) {
      const composite = compositeOver(accent, BADGE_TINT, surface);
      expect(contrastRatio(badgeFg, composite)).toBeGreaterThanOrEqual(4.5);
    }
  }

  it("clears AA for a light accent against every light surface", () => {
    // The old page-only check left --badge-fg at 4.157:1 on --bg-subtle; the
    // worst-case check clears 4.5:1 against every surface composite.
    expectClearsEverySurface("#8a5a2b", ["#f7f2e7", "#fffdf6", "#efe8d8"]);
    expectClearsEverySurface("#8a5a2b", pageSurfaces("light"));
  });

  it("clears AA for a dark accent against every dark surface", () => {
    // The old page-only check left this at 4.055:1 on --bg-elev.
    expectClearsEverySurface("#0075de", ["#1e1d1b", "#272624", "#171615"]);
  });
});

describe("readableForeground", () => {
  it("picks the higher-contrast of white and #111111", () => {
    expect(readableForeground("#ffffff")).toBe("#111111");
    expect(readableForeground("#000000")).toBe("#ffffff");
  });

  it("picks the better option for a common light-blue accent", () => {
    const fg = readableForeground("#62aef0");
    expect(fg).toBe("#111111");
    expect(contrastRatio(fg, "#62aef0")).toBeGreaterThanOrEqual(
      contrastRatio("#ffffff", "#62aef0"),
    );
  });
});

describe("shade", () => {
  it("mixes toward white for positive amounts and black for negative", () => {
    expect(shade("#000000", 1)).toBe("#ffffff");
    expect(shade("#ffffff", -1)).toBe("#000000");
    expect(shade("#808080", 0)).toBe("#808080");
  });
});
