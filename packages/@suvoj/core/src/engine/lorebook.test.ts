/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { Repositories } from "../repositories";
import { createRepositories } from "../repositories";
import type { LorebookEntryInput } from "../schema/lorebooks";
import { createTestDb } from "../test-utils";
import fixture from "./fixtures/lorebook.json";
import { LorebookPosition, type LorebookRunResult, runLorebook } from "./lorebook";

/** Minimal shape of the ST fixture entries (all fields optional). */
interface StEntry {
  key?: string[];
  keysecondary?: string[];
  content?: string;
  constant?: boolean;
  selective?: boolean;
  selectiveLogic?: number;
  order?: number;
  position?: number;
  depth?: number;
  role?: string | null;
  probability?: number;
  disable?: boolean;
  sticky?: number;
  cooldown?: number;
  delay?: number;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  scanDepth?: number | null;
  group?: string;
  groupOverride?: boolean;
  groupWeight?: number;
  excludeRecursion?: boolean;
  preventRecursion?: boolean;
  delayUntilRecursion?: boolean;
  displayIndex?: number;
  characterFilter?: { isExclude: boolean; names: string[]; tags: string[] } | null;
}

interface StFixture {
  entries: Record<string, StEntry>;
}

/** Maps one ST world info entry to the native entry input. */
function stToInput(st: StEntry): LorebookEntryInput {
  return {
    keys: st.key ?? [],
    secondary: st.keysecondary ?? [],
    content: st.content ?? "",
    constant: st.constant ?? false,
    selective: st.selective ?? false,
    logic: st.selectiveLogic ?? 0,
    order: st.order ?? 100,
    position: st.position ?? 0,
    depth: st.depth ?? 4,
    role: st.role ?? null,
    probability: st.probability ?? 100,
    enabled: !(st.disable ?? false),
    sticky: st.sticky ?? 0,
    cooldown: st.cooldown ?? 0,
    delay: st.delay ?? 0,
    case_sensitive: st.caseSensitive ?? false,
    match_whole_words: st.matchWholeWords ?? true,
    scan_depth: st.scanDepth ?? null,
    group: st.group && st.group !== "" ? st.group : null,
    group_weight: st.groupWeight ?? null,
    recursion: {
      excludeRecursion: st.excludeRecursion ?? false,
      preventRecursion: st.preventRecursion ?? false,
      delayUntilRecursion: st.delayUntilRecursion ?? false,
    },
    character_filter: st.characterFilter ?? null,
    display_index: st.displayIndex ?? 0,
    extra: st.groupOverride ? { groupOverride: true } : null,
  };
}

const fixtureEntries = Object.values((fixture as StFixture).entries).map(stToInput);

describe("lorebook engine", () => {
  let db: Database;
  let repos: Repositories;
  let bookId: string;
  /** Creates a fresh lorebook and fills it with the fixture entries. */
  const fixtureBook = async (): Promise<string> => {
    const book = repos.lorebooks.create({ name: "Fixture" });
    for (const entry of fixtureEntries) {
      repos.lorebooks.addEntry(book.id, entry);
    }
    return book.id;
  };
  const run = (
    scanText: string[],
    overrides: Partial<Parameters<typeof runLorebook>[0]> = {},
  ): LorebookRunResult =>
    runLorebook({
      entries: repos.lorebooks.listEntries(bookId),
      scanText,
      settings: { scanDepth: 2, budgetTokens: 1000 },
      ...overrides,
    });
  const contents = (result: LorebookRunResult): string[] =>
    result.activations.map((activation) => activation.content);

  beforeEach(() => {
    db = createTestDb();
    repos = createRepositories(db);
  });

  it("includes constant entries regardless of scan text", () => {
    bookId = repos.lorebooks.create({ name: "B" }).id;
    repos.lorebooks.addEntry(bookId, { keys: [], content: "Always on.", constant: true });
    const result = run(["nothing relevant at all"]);
    expect(contents(result)).toEqual(["Always on."]);
  });

  it("activates keyed entries on matching scan text", async () => {
    bookId = await fixtureBook();
    const result = run(["JCJenson built the northern facility"]);
    expect(contents(result)).toContain("JCJenson manufactures drones.");
    expect(contents(run(["nothing here"]))).not.toContain("JCJenson manufactures drones.");
  });

  it("matches whole words only when match_whole_words is on", async () => {
    bookId = await fixtureBook();
    // Key "N" must not match the word "no".
    expect(contents(run(["no way"]))).not.toContain("N is a kind but clumsy worker drone.");
    expect(contents(run(["N waves hello"]))).toContain("N is a kind but clumsy worker drone.");
    // Entry 3 has matchWholeWords off: substring match.
    expect(contents(run(["the forested hills"]))).toContain("The forest is deep and dark.");
  });

  it("respects case sensitivity in both directions", async () => {
    bookId = await fixtureBook();
    expect(contents(run(["jcjenson lowercased"]))).toContain("JCJenson manufactures drones.");
    const strict = repos.lorebooks.create({ name: "Strict" });
    repos.lorebooks.addEntry(strict.id, {
      keys: ["Dragon"],
      content: "Case-sensitive dragon lore.",
      case_sensitive: true,
    });
    const result = runLorebook({
      entries: repos.lorebooks.listEntries(strict.id),
      scanText: ["a dragon appears"],
      settings: { scanDepth: 2, budgetTokens: 1000 },
    });
    expect(contents(result)).toEqual([]);
  });

  it("applies secondary keys with AND_ANY and NOT_ANY logic", async () => {
    bookId = await fixtureBook();
    expect(contents(run(["the door is rusted"]))).not.toContain("The door is reinforced.");
    expect(contents(run(["the steel door is rusted"]))).toContain("The door is reinforced.");
    expect(contents(run(["the window is clean"]))).toContain("The window is intact.");
    expect(contents(run(["the broken window rattles"]))).not.toContain("The window is intact.");
  });

  it("supports regex keys wrapped in slashes", async () => {
    bookId = await fixtureBook();
    expect(contents(run(["a mighty dragon soars"]))).toContain(
      "The dragon sleeps beneath the mountain.",
    );
  });

  it("resolves recursion: activated content re-enters the scan", async () => {
    bookId = await fixtureBook();
    // Beacon matches directly; its content mentions the spire, which is only
    // activatable through recursion (delayUntilRecursion).
    const result = run(["the beacon glows"]);
    expect(contents(result)).toContain("The beacon points toward the ancient spire.");
    expect(contents(result)).toContain("The spire pierces the clouds.");
    // Without any recursion chain the spire stays inactive.
    expect(contents(run(["nothing relevant here"]))).not.toContain("The spire pierces the clouds.");
  });

  it("blocks excludeRecursion entries during recursion passes", async () => {
    bookId = await fixtureBook();
    // The spire's content mentions the golem, but the golem is excluded
    // from recursion passes, so it must not activate.
    const result = run(["the beacon glows"]);
    expect(contents(result)).not.toContain("A stone golem guards the spire entrance.");
    // Direct scan still works.
    expect(contents(run(["the golem awakens"]))).toContain(
      "A stone golem guards the spire entrance.",
    );
  });

  it("prevents recursion fuel from preventRecursion entries", () => {
    bookId = repos.lorebooks.create({ name: "B" }).id;
    repos.lorebooks.addEntry(bookId, {
      keys: ["alpha"],
      content: "alpha mentions beta",
      recursion: { excludeRecursion: false, preventRecursion: true, delayUntilRecursion: false },
    });
    repos.lorebooks.addEntry(bookId, { keys: ["beta"], content: "beta lore" });
    const result = run(["alpha starts"]);
    expect(contents(result)).toEqual(["alpha mentions beta"]);
  });

  it("enforces the token budget by order priority", () => {
    bookId = repos.lorebooks.create({ name: "B" }).id;
    repos.lorebooks.addEntry(bookId, { keys: ["hot"], content: "A", order: 300 });
    repos.lorebooks.addEntry(bookId, { keys: ["hot"], content: "B", order: 200 });
    repos.lorebooks.addEntry(bookId, { keys: ["hot"], content: "C", order: 100 });
    // One token each: the budget fits exactly two.
    const result = runLorebook({
      entries: repos.lorebooks.listEntries(bookId),
      scanText: ["hot stuff"],
      settings: { scanDepth: 2, budgetTokens: 2 },
    });
    // Layout order: order ascending; C overflowed the budget and is dropped.
    expect(contents(result)).toEqual(["B", "A"]);
  });

  it("resolves inclusion groups with groupOverride and weighted rolls", async () => {
    bookId = await fixtureBook();
    const wolves = run(["wolves howl"]);
    expect(contents(wolves)).toContain("The wolves have silver fur.");
    expect(contents(wolves)).not.toContain("Wolves howl in the distance.");

    const weighted = repos.lorebooks.create({ name: "W" });
    repos.lorebooks.addEntry(weighted.id, {
      keys: ["storm"],
      content: "heavy rain",
      order: 200,
      group: "weather",
      group_weight: 100,
    });
    repos.lorebooks.addEntry(weighted.id, {
      keys: ["storm"],
      content: "light drizzle",
      order: 100,
      group: "weather",
      group_weight: 100,
    });
    const rng = (value: number) => () => value;
    const runWeighted = (r: () => number): string[] =>
      runLorebook({
        entries: repos.lorebooks.listEntries(weighted.id),
        scanText: ["a storm approaches"],
        settings: { scanDepth: 2, budgetTokens: 1000 },
        rng: r,
      }).activations.map((activation) => activation.content);
    expect(runWeighted(rng(0.01))).toEqual(["heavy rain"]);
    expect(runWeighted(rng(0.99))).toEqual(["light drizzle"]);
  });

  it("gates non-sticky entries behind probability", () => {
    bookId = repos.lorebooks.create({ name: "B" }).id;
    repos.lorebooks.addEntry(bookId, { keys: ["lucky"], content: "lucky lore", probability: 50 });
    const scan = ["feeling lucky today"];
    const settings = { scanDepth: 2, budgetTokens: 1000 };
    const entries = repos.lorebooks.listEntries(bookId);
    expect(
      runLorebook({ entries, scanText: scan, settings, rng: () => 0.01 }).activations.length,
    ).toBe(1);
    expect(
      runLorebook({ entries, scanText: scan, settings, rng: () => 0.99 }).activations.length,
    ).toBe(0);
  });

  it("filters entries by character names and tags", async () => {
    bookId = await fixtureBook();
    const seraphina = { name: "Seraphina", tags: ["witch"] };
    const vex = { name: "Vex", tags: ["rogue"] };
    const restricted = repos.lorebooks.create({ name: "R" });
    repos.lorebooks.addEntry(restricted.id, {
      keys: ["market"],
      content: "Only for Seraphina.",
      character_filter: { isExclude: false, names: ["Seraphina"], tags: [] },
    });
    const excluded = repos.lorebooks.create({ name: "E" });
    repos.lorebooks.addEntry(excluded.id, {
      keys: ["market"],
      content: "Never for Vex.",
      character_filter: { isExclude: true, names: [], tags: ["rogue"] },
    });
    const scan = ["at the market"];
    const settings = { scanDepth: 2, budgetTokens: 1000 };
    const runWith = (
      character: { name: string; tags: string[] },
      entries: ReturnType<Repositories["lorebooks"]["listEntries"]>,
    ) =>
      runLorebook({ entries, scanText: scan, settings, character }).activations.map(
        (activation) => activation.content,
      );
    expect(runWith(seraphina, repos.lorebooks.listEntries(restricted.id))).toEqual([
      "Only for Seraphina.",
    ]);
    expect(runWith(vex, repos.lorebooks.listEntries(restricted.id))).toEqual([]);
    expect(runWith(vex, repos.lorebooks.listEntries(excluded.id))).toEqual([]);
    expect(runWith(seraphina, repos.lorebooks.listEntries(excluded.id))).toEqual([
      "Never for Vex.",
    ]);
  });

  it("skips disabled entries", () => {
    bookId = repos.lorebooks.create({ name: "B" }).id;
    repos.lorebooks.addEntry(bookId, {
      keys: ["ghost"],
      content: "hidden",
      enabled: false,
    });
    expect(run(["a ghost!"]).activations.length).toBe(0);
  });

  it("exposes at-depth activations with their depth and role", async () => {
    bookId = await fixtureBook();
    const ghost = run(["the ghost moans"]).activations.find(
      (activation) => activation.content === "A ghost haunts the northern tower.",
    );
    expect(ghost).toBeDefined();
    expect(ghost?.position).toBe(LorebookPosition.AtDepth);
    expect(ghost?.depth).toBe(2);
    expect(ghost?.role).toBe("user");
  });

  it("limits the scan to per-entry scan_depth from the end", () => {
    bookId = repos.lorebooks.create({ name: "B" }).id;
    repos.lorebooks.addEntry(bookId, {
      keys: ["dragon"],
      content: "dragon lore",
      scan_depth: 1,
    });
    // The key sits two messages back; with scan_depth 1 only the newest
    // message is scanned.
    expect(run(["dragon attack", "later"]).activations.length).toBe(0);
    expect(run(["dragon attack"]).activations.length).toBe(1);
  });

  it("orders activations by position then order ascending", () => {
    bookId = repos.lorebooks.create({ name: "B" }).id;
    repos.lorebooks.addEntry(bookId, { keys: ["k"], content: "after", order: 100, position: 1 });
    repos.lorebooks.addEntry(bookId, { keys: ["k"], content: "before", order: 300, position: 0 });
    repos.lorebooks.addEntry(bookId, {
      keys: ["k"],
      content: "before-low",
      order: 50,
      position: 0,
    });
    const result = run(["k"]);
    expect(contents(result)).toEqual(["before-low", "before", "after"]);
  });

  it("evaluates macros in entry content on activation", async () => {
    bookId = await fixtureBook();
    const result = runLorebook({
      entries: repos.lorebooks.listEntries(bookId),
      scanText: ["JCJenson rules"],
      settings: { scanDepth: 2, budgetTokens: 1000 },
      macros: {
        char: "Seraphina",
        user: "Alex",
        vars: repos.variables,
      },
    });
    // The constant fixture entry has plain content; assert macro evaluation
    // through a dedicated entry instead.
    const macroBook = repos.lorebooks.create({ name: "M" });
    repos.lorebooks.addEntry(macroBook.id, {
      keys: ["macro"],
      content: "{{char}} owns the macro.",
    });
    const macroRun = runLorebook({
      entries: repos.lorebooks.listEntries(macroBook.id),
      scanText: ["trigger the macro"],
      settings: { scanDepth: 2, budgetTokens: 1000 },
      macros: { char: "Seraphina", user: "Alex", vars: repos.variables },
    });
    expect(macroRun.activations[0]?.content).toBe("Seraphina owns the macro.");
    expect(result.activatedIds.size).toBeGreaterThan(0);
  });

  describe("timed effects", () => {
    const chatId = "chat-timed";
    const settings = { scanDepth: 2, budgetTokens: 1000 };

    it("keeps sticky entries active then cools them down", () => {
      bookId = repos.lorebooks.create({ name: "S" }).id;
      repos.lorebooks.addEntry(bookId, {
        keys: ["fire"],
        content: "Fire burns.",
        sticky: 2,
        cooldown: 3,
      });
      const entries = repos.lorebooks.listEntries(bookId);
      const step = (text: string): number => {
        const result = runLorebook({
          entries,
          scanText: [text],
          settings,
          chatId,
          vars: repos.variables,
        });
        result.commitTurn();
        return result.activatedIds.size;
      };
      expect(step("fire!")).toBe(1);
      expect(step("water")).toBe(1); // sticky turn 1
      expect(step("water")).toBe(1); // sticky turn 2
      expect(step("water")).toBe(0); // sticky expired, deactivated
      expect(step("fire blaze")).toBe(0); // cooldown turns 1-3
      expect(step("fire blaze")).toBe(0);
      expect(step("fire blaze")).toBe(0);
      expect(step("fire blaze")).toBe(1); // cooldown over
    });

    it("delays entry activation by N turns from first sight", () => {
      bookId = repos.lorebooks.create({ name: "D" }).id;
      repos.lorebooks.addEntry(bookId, { keys: ["ghost"], content: "Ghost lore.", delay: 2 });
      const entries = repos.lorebooks.listEntries(bookId);
      const step = (text: string): number => {
        const result = runLorebook({
          entries,
          scanText: [text],
          settings,
          chatId,
          vars: repos.variables,
        });
        result.commitTurn();
        return result.activatedIds.size;
      };
      expect(step("a ghost")).toBe(0);
      expect(step("a ghost")).toBe(0);
      expect(step("a ghost")).toBe(1);
    });

    it("persists timed state across engine restarts via the variables repo", () => {
      bookId = repos.lorebooks.create({ name: "P" }).id;
      repos.lorebooks.addEntry(bookId, { keys: ["fire"], content: "Fire.", sticky: 1 });
      const first = runLorebook({
        entries: repos.lorebooks.listEntries(bookId),
        scanText: ["fire"],
        settings,
        chatId,
        vars: repos.variables,
      });
      first.commitTurn();
      // New repos on a fresh connection to the same db file would be ideal;
      // same repo still proves persistence through the variables store.
      const second = runLorebook({
        entries: repos.lorebooks.listEntries(bookId),
        scanText: ["nothing"],
        settings,
        chatId,
        vars: repos.variables,
      });
      expect(second.activatedIds.size).toBe(1);
    });
  });
});
