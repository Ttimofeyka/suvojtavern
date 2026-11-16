/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from "bun:test";
import { copyText } from "./clipboard";

/**
 * `copyText` reaches for two globals that the Bun test runtime does not
 * provide intact: `navigator` (present, but without `clipboard`) and
 * `document` (absent). Each test installs the minimum fake it needs and
 * `afterEach` restores the originals so the suite stays hermetic.
 */
const originalNavigator = globalThis.navigator;
const originalDocument = (globalThis as { document?: unknown }).document;

afterEach(() => {
  // `navigator` is writable/configurable on Bun's globalThis, so redefining is
  // safe either way.
  Object.defineProperty(globalThis, "navigator", {
    value: originalNavigator,
    configurable: true,
    writable: true,
  });
  if (originalDocument === undefined) {
    delete (globalThis as { document?: unknown }).document;
  } else {
    Object.defineProperty(globalThis, "document", {
      value: originalDocument,
      configurable: true,
      writable: true,
    });
  }
});

/** Installs a `navigator` whose only relevant surface is the clipboard. */
function installNavigator(clipboard: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard },
    configurable: true,
    writable: true,
  });
}

/** The slice of a textarea the fallback touches, with call captures. */
interface FakeTextarea {
  value: string;
  style: Record<string, string>;
  attributes: Record<string, string>;
  focusCalls: number;
  selection: { start: number; end: number } | null;
  removed: boolean;
  setAttribute(name: string, value: string): void;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  remove(): void;
}

interface FakeDom {
  textarea: FakeTextarea;
  execCalls: string[];
  appended: number;
  focusRestored: number;
}

/**
 * Installs a minimal `document` good enough for the legacy path: a focusable
 * textarea factory, a body that records appends, an `execCommand` that returns
 * `execResult`, and a selection whose ranges are restored after the copy.
 */
function installDocument(execResult: boolean): FakeDom {
  const textarea: FakeTextarea = {
    value: "",
    style: {},
    attributes: {},
    focusCalls: 0,
    selection: null,
    removed: false,
    setAttribute(name, value) {
      textarea.attributes[name] = value;
    },
    focus() {
      textarea.focusCalls += 1;
    },
    setSelectionRange(start, end) {
      textarea.selection = { start, end };
    },
    remove() {
      textarea.removed = true;
    },
  };
  const dom: FakeDom = { textarea, execCalls: [], appended: 0, focusRestored: 0 };
  const activeElement = {
    focus() {
      dom.focusRestored += 1;
    },
  };
  // A live range is cloned, then re-added; the fake only needs to prove the
  // restore path ran rather than model real selection semantics.
  const range = { cloneRange: () => range };
  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges: () => {},
    addRange: () => {},
  };
  Object.defineProperty(globalThis, "document", {
    value: {
      activeElement,
      getSelection: () => selection,
      createElement: () => textarea,
      body: {
        appendChild() {
          dom.appended += 1;
        },
      },
      execCommand(command: string) {
        dom.execCalls.push(command);
        return execResult;
      },
    },
    configurable: true,
    writable: true,
  });
  return dom;
}

describe("copyText", () => {
  it("writes via the async Clipboard API in a secure context", async () => {
    const written: string[] = [];
    installNavigator({
      writeText: async (text: string) => {
        written.push(text);
      },
    });
    // No document installed: a fallback attempt here would throw internally and
    // resolve `false`, so a `true` result proves the API path was taken.
    await expect(copyText("hello world")).resolves.toBe(true);
    expect(written).toEqual(["hello world"]);
  });

  it("falls back to execCommand when navigator.clipboard is undefined", async () => {
    installNavigator(undefined);
    const dom = installDocument(true);
    await expect(copyText("legacy text")).resolves.toBe(true);
    expect(dom.textarea.value).toBe("legacy text");
    expect(dom.textarea.selection).toEqual({ start: 0, end: "legacy text".length });
    expect(dom.execCalls).toEqual(["copy"]);
    expect(dom.appended).toBe(1);
    expect(dom.textarea.removed).toBe(true);
    expect(dom.focusRestored).toBe(1);
  });

  it("falls back to execCommand when the Clipboard API rejects", async () => {
    installNavigator({
      writeText: async () => {
        throw new Error("NotAllowedError");
      },
    });
    const dom = installDocument(true);
    await expect(copyText("after rejection")).resolves.toBe(true);
    expect(dom.textarea.value).toBe("after rejection");
    expect(dom.execCalls).toEqual(["copy"]);
  });

  it("resolves false when both paths fail without throwing", async () => {
    installNavigator({
      writeText: async () => {
        throw new Error("NotAllowedError");
      },
    });
    installDocument(false);
    await expect(copyText("doomed")).resolves.toBe(false);
  });

  it("resolves false when neither a clipboard nor a document exists", async () => {
    installNavigator(undefined);
    delete (globalThis as { document?: unknown }).document;
    await expect(copyText("nothing available")).resolves.toBe(false);
  });

  it("copies empty text verbatim rather than special-casing it", async () => {
    // Documented contract: empty text goes through the normal write. Callers
    // that treat empty input as a no-op guard it themselves.
    const written: string[] = [];
    installNavigator({
      writeText: async (text: string) => {
        written.push(text);
      },
    });
    await expect(copyText("")).resolves.toBe(true);
    expect(written).toEqual([""]);
  });
});
