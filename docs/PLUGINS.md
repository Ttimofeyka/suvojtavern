# Plugins

SuvojTavern plugins extend the server without touching its source. A plugin
is **one folder inside the repo's `plugins/` directory** whose `index.ts`
exports a `definePlugin(...)` result from `@suvoj/plugin-sdk`. Bun executes
TypeScript directly, so plugins are plain `.ts` files — no build step, no
bundling.

```
plugins/
  example-plugin/
    index.ts        ← entry: export default definePlugin({ ... })
    README.md       ← optional per-plugin notes
  theme-plugin/     ← appearance reference (themes + globalCss)
    index.ts
```

Manage plugins from **Settings → Plugins**: enable/disable toggles, per-
plugin settings forms, each plugin's own controls, and a **Reload** button
that rescans the folder (new plugins appear, removed ones disappear, edited
source re-imports — no restart).

- Reference example: [`plugins/example-plugin/index.ts`](../plugins/example-plugin/index.ts)
  (richly commented — it doubles as a living tutorial)
- Appearance reference: [`plugins/theme-plugin/index.ts`](../plugins/theme-plugin/index.ts)
  (two complete palettes plus a global stylesheet)
- SDK source: [`packages/@suvoj/plugin-sdk/src/index.ts`](../packages/@suvoj/plugin-sdk/src/index.ts)

---

## Table of contents

1. [Quick start](#quick-start)
2. [The definition](#the-definition)
3. [Runtime hooks](#runtime-hooks)
4. [Settings](#settings)
5. [Controls](#controls)
6. [Memory strategies](#memory-strategies)
7. [Pipeline stages](#pipeline-stages)
8. [Tracker mechanisms](#tracker-mechanisms)
9. [UI contributions](#ui-contributions)
10. [Themes](#themes)
11. [Global stylesheet](#global-stylesheet)
12. [Chat drawer tabs](#chat-drawer-tabs)
13. [Lifecycle & persistence](#lifecycle--persistence)
14. [Error isolation guarantees](#error-isolation-guarantees)
15. [Management API](#management-api)
16. [Example plugin walkthrough](#example-plugin-walkthrough)

---

## Quick start

```bash
mkdir plugins/my-plugin
```

```ts
// plugins/my-plugin/index.ts
import { definePlugin } from "@suvoj/plugin-sdk";

export default definePlugin({
  id: "my-plugin",           // kebab-case, unique, stable
  name: "My Plugin",
  version: "0.1.0",
  description: "What it does",

  setup(ctx) {
    ctx.log("hello");        // → console: [plugin:my-plugin] hello
    return {
      onResponse(event) {
        return `${event.content}\n\n— My Plugin`;
      },
    };
  },
});
```

Press **Reload** in Settings → Plugins — the plugin appears there, disabled
(plugins are opt-in: nothing runs until the user allows it). Flip its toggle
to enable it, and its `onResponse` now signs every reply.

That is the whole floor of the API. From here a plugin can also declare
[settings](#settings) (typed form fields the UI renders), [controls](#controls)
(app-level values prompt text reads through `{{ui:plugin:<id>:<control>}}`),
[memory strategies](#memory-strategies), [pipeline stages](#pipeline-stages),
[tracker mechanisms](#tracker-mechanisms), [UI contributions](#ui-contributions),
[themes](#themes) and [drawer tabs](#chat-drawer-tabs) — all declarative, on the
definition.

> `@suvoj/plugin-sdk` resolves because the repo root links it into
> `node_modules` (declared as a root devDependency). If you move plugins to
> another location outside the repo, use a relative import of
> `packages/@suvoj/plugin-sdk/src/index` instead — Bun resolves either way
> since everything is executed from source.

`definePlugin` is a **typed identity function**: it returns exactly what you
pass, adding only compile-time checking of the shape (wrong hook name,
wrong event field — TypeScript tells you before the server ever loads the
folder).

---

## The definition

```ts
import { definePlugin } from "@suvoj/plugin-sdk";

export default definePlugin({
  // Required ---------------------------------------------------------------
  id: string,        // kebab-case ^[a-z0-9-]+$, unique, never change it
  name: string,      // display name
  version: string,   // semver-ish, e.g. "0.1.0"
  setup(ctx) { ... } // runs on activation; returns the runtime hooks

  // Optional ----------------------------------------------------------------
  description?: string,
  author?: string,
  ui?: { sidebarItems?: Array<{ label: string; href: string; icon?: string }> },
  settings?: SettingField[],          // typed settings form, see below
  controls?: PluginControl[],          // app-level values, see below
  memoryStrategies?: MemoryStrategy[], // registered while enabled
  pipelineStages?: PipelineStage[],    // appended while enabled
  trackerMechanisms?: TrackerMechanism[], // selectable tracker generators
  drawerTabs?: DrawerTab[],             // extra tabs in the chat drawer
  themes?: PluginTheme[],               // Appearance palettes, see below
  globalCss?: string,                   // raw stylesheet applied while enabled
});
```

The module may export the definition as the **default export or as a named
`plugin` export** (default wins when both exist). A `package.json` with a
`main` field may replace `index.ts` as the entry.

### `setup(ctx)`

Called once whenever the plugin is **activated** — at server start, when
you enable it, or after a folder reload. It receives a `PluginContext`:

```ts
interface PluginContext {
  pluginId: string;
  settings: {
    get<T = unknown>(key: string): T | undefined; // stored value or schema default
    all(): Record<string, unknown>;               // every setting merged
  };
  controls: {
    get<T = string>(id: string): T | null;        // this plugin's OWN control, by BARE id
    all(): Record<string, string>;                // every own control, bare id → option id
    set(id: string, value: string): void;         // persist + fire onControlChange
  };
  log(...args: unknown[]): void; // console logging with the [plugin:<id>] prefix
}
```

Settings and control reads are **live**: changes made in the Settings UI apply
to the next hook call without reloading the plugin. See
[Controls](#controls) for the full `controls` contract.

`setup` returns the runtime hooks (or nothing, for a plugin that only
contributes settings/UI/strategies). Close over whatever you need — the
returned hooks keep that state alive.

> **Compatibility note.** `PluginContext` and `PanelDataEvent` each gained a
> **required** member: `PluginContext.controls` and `PanelDataEvent.controls`.
> If you type your context or a hand-built event as a narrower structural shape
> and pass it through, add the member — a built event object (in tests, say)
> must include `controls` to satisfy the type.

---

## Runtime hooks

All hooks are optional. **Returning a value is how you change data;
returning nothing (or throwing — see [isolation](#error-isolation-guarantees))
leaves it alone.**

### `onBeforeGenerate(event)` — read/rewrite the prompt

Fires after prompt assembly (lorebook, memory, persona, history, macros —
all done) and before the gateway call.

```ts
interface BeforeGenerateEvent {
  chat: Chat;
  character: Character;
  persona: Persona | null;
  messages: PromptMessage[];   // { role, content, name? }
  sampling: Record<string, unknown>;
  controls: ControlValues;     // the merged control map, see below
}
```

The `controls` map is the **resolved values for this request**: preset-declared
controls under their bare id (`"pov"`) and every enabled plugin's controls
namespaced `plugin:<pluginId>:<controlId>`. Plugin keys are namespaced, so a
preset control can never collide with a plugin one. It is the same map
[`PanelDataEvent`](#onpaneldataevent--feed-a-drawer-tab) and
[`ControlChangeEvent`](#oncontrolchangeevent--observe-a-control-change) carry.

> **Read the subtlety, not just the type.** Every value in this map is the
> **display text** the control expands to in prompt text — for a preset
> control the chosen option's `value`/label/id, for a plugin control exactly
> what `{{ui:plugin:<id>:<control>}}` renders. It is **not** the option id.
> `ctx.controls.get("<control>")` returns the **option id**; the map carries
> the **text**. `"plugin:example-plugin:verbosity"` might be `"balanced detail"`
> while `ctx.controls.get("verbosity")` is `"balanced"`. Use the map when you
> want to see what the model will read; use `ctx.controls` when you need to
> branch on the actual choice.

**Return a new array** to replace the prompt messages — every later plugin
and the model itself see your version. This is where prompt styling,
injected instructions, or moderation layers plug in.

### `onResponse(event)` — edit the final reply

Fires once when the model reply completes, **before it is persisted**.

```ts
interface ResponseEvent {
  chatId: string;
  content: string;                          // the model's reply
  metadata: Record<string, unknown> | null; // e.g. reasoning capture
}
```

**Return a string** to replace the content that is stored in the chat and
sent in the `done` SSE event. Streamed deltas have already gone out
unmodified (see `onDelta`); the replacement applies to the persisted
message and the client's final state.

### `onDelta(event)` — observe the stream

Fires for every streamed content chunk. Observation only — the return
value is ignored, deltas reach the client unmodified.

```ts
interface DeltaEvent { chatId: string; content: string }
```

Use it for live side effects: token counters, mood trackers, "the model is
typing X" detectors.

### `onChatEvent(event)` — message lifecycle

Fires for message insert/edit/delete (aligned with the repositories' hook
bus, plus an `event` discriminator). Observation only.

```ts
interface ChatEvent {
  event: "beforeInsert" | "afterInsert" | "beforeEdit" | "afterEdit" | "beforeDelete";
  chatId: string;
  message?: Message;   // the full row (id, seq, metadata, ...)
  previous?: Message;  // pre-edit row, for edit events
}
```

This is the foundation for trackers, external archives, or analytics.

### `onControlChange(event)` — observe a control change

Fires whenever a control value changes — a preset control via
`PUT /api/presets/:id/controls`, or a plugin control via
`PUT /api/plugins/:id/controls` or the plugin's own `ctx.controls.set`.

```ts
interface ControlChangeEvent {
  source: "preset" | "plugin"; // which kind of control changed
  ownerId: string;             // the preset id, or the plugin id
  controlId: string;           // the control's own id (bare, in both cases)
  value: string;               // the newly chosen OPTION id
  values: ControlValues;       // the resolved map AFTER the change
}
```

Two fields reward a second look:

- **`value` is the OPTION id**, not the display text. For a preset control
  that is what the option's id names in the preset JSON; for a plugin control
  it is what `ctx.controls.get` would return. If you want the text the model
  reads, look it up in `values`, which carries the same display map as
  [`BeforeGenerateEvent.controls`](#onbeforegenerateevent--readrewrite-the-prompt).
- **`values` is the whole resolved map** — the changed preset control under
  its bare id, every plugin control namespaced
  `plugin:<pluginId>:<controlId>`. It is computed **after** the write, so one
  batch of changes sees a single consistent post-write state.

The hook fires for **preset controls too**, not only your own: filter on
`event.source === "plugin" && event.ownerId === ctx.pluginId` to react only to
your own, or watch preset controls to react to the user's narration choice.

Like every observation hook it is **fire-and-forget**: the value is already
persisted when the event fires, and a throwing handler is logged
`[plugin:<id>] onControlChange failed` and skipped —
[error isolation](#error-isolation-guarantees) still holds, generation never
fails because of it.

> **Cascade cap.** A handler that writes another control re-enters
> `onControlChange` synchronously. The host allows up to 16 nested levels and
> then stops *notifying* (the write itself still persists) — a natural cascade
> is fine, a mutual-write loop cannot hang the server.

### `onPanelData(event)` — feed a drawer tab

Fires when the web client opens one of the plugin's
[drawer tabs](#chat-drawer-tabs) and requests its data — once per open, no
polling. Derive the tab's data root from the chat context and return it.

```ts
interface PanelDataEvent {
  pluginId: string;             // your plugin's id
  chatId: string;               // the chat whose drawer is open
  tab: DrawerTab;               // the tab being opened (its declaration)
  chat: Chat | null;            // the chat row (title, links)
  character: Character | null;  // the chat's character, when known
  persona: Persona | null;      // the user's active persona, when known
  messages: PromptMessage[];    // the chat's active history, seq-ordered
  hiddenSeqs: number[];         // positions currently covered by a summary row
  controls: ControlValues;      // the merged control map (see onBeforeGenerate)
}
```

`hiddenSeqs` and `controls` are the two fields a tab needs to render the same
picture the model sees: `hiddenSeqs` lists the chat positions prompt building
hides behind the summary block instead of sending verbatim, and `controls` is
the merged display map described on
[`BeforeGenerateEvent`](#onbeforegenerateevent--readrewrite-the-prompt) — so a
tab can render control-dependent data without a second hook or route.

**Return an object** (or a promise of one) — the web client renders the
tab's `htmlTemplate` with it as the data root. The template itself ships
from the tab's declaration (the data route delivers it alongside the
hook's result), so the hook never needs to echo it — it returns plain
data. Returning nothing renders the tab's empty state. Unlike the
generation hooks, a throw here surfaces to the user as a failed data
fetch (HTTP 500) — it still can't break generation.

### `onUnload()` — cleanup

Called when the plugin is deactivated: you disable it, the folder is
reloaded, or the server shuts down cleanly. Stop timers, close watchers,
flush buffers. Declared registrations (strategies, stages, chat-hook
wiring) are disposed automatically — `onUnload` is for YOUR state.

---

## Settings

A plugin's `settings` array is a schema of typed form fields the Settings
UI renders automatically — no frontend code needed.

```ts
import type { SettingField } from "@suvoj/plugin-sdk";

const settings: SettingField[] = [
  { key: "enabled",  label: "Append signature", type: "boolean", default: false,
    hint: "Adds the signature to every reply." },
  { key: "signature", label: "Signature text", type: "string", default: "— me" },
  { key: "notes", label: "Notes", type: "textarea", default: "",
    placeholder: "Anything you want to remember…" },
  { key: "temperature", label: "Override temperature", type: "number",
    default: 1, min: 0, max: 2 },
  { key: "style", label: "Style", type: "select", default: "concise",
    options: [
      { label: "Concise", value: "concise" },
      { label: "Verbose", value: "verbose" },
    ] },
  { key: "tags", label: "Tags", type: "multiselect", default: ["draft"],
    options: [
      { label: "Draft", value: "draft" },
      { label: "Final", value: "final" },
    ] },
];
```

| Field part | Meaning |
|---|---|
| `key` | Storage key; unique within the plugin. |
| `label` / `hint` / `placeholder` | Presentation (`placeholder` applies to `string` and `textarea`). |
| `type` | `boolean` \| `string` \| `number` \| `select` \| `textarea` \| `multiselect` |
| `default` | Value when the user never touched it — must match `type`: a `string[]` for `multiselect`, otherwise a single value. |
| `options` | Selectable values (required for `select`/`multiselect`). |
| `min` / `max` | Number bounds, enforced on write. |

The two richer types:

- **`textarea`** is a `string` with a larger multi-line editor — same storage,
  same validation. Use it for notes, free-form prompts, or signatures.
- **`multiselect`** stores a `string[]` of the chosen option `value`s. Options
  with a **numeric** `value` are filtered out client-side: only a string can
  occupy a `string[]` slot, so the panel renders the string-valued subset and
  the server rejects anything else. Give a `multiselect` a `string[]` default
  (it may be empty) and string-valued options.

Read them in `setup`/hooks via `ctx.settings.get(key)` / `ctx.settings.all()`.

**Storage.** Values persist under the settings key
`plugin:<id>:settings` as a plain JSON object (only schema keys are
writable — the API rejects unknown keys and type mismatches; selects must
match an option, multiselects must be an array of valid string options,
numbers respect min/max). Enabled state persists under
`plugin:<id>:enabled`. Control choices live under a separate key — see
[Controls](#controls).

> **Compatibility note.** `type` is validated against a fixed set at load: an
> unrecognized value is now a **load error** (the plugin is listed with an
> `error` and contributes nothing). Previously an unknown `type` slipped
> through and let any value into the store. If your plugin carried an
> experimental type string, switch it to one of the six above — the old
> silent-accept behavior is gone.

---

## Controls

A **control** is a named, mutually-exclusive choice with a small switcher UI.
Plugins and presets both declare them, but they are different things, and the
difference is worth stating plainly:

| | Preset control | Plugin control |
|---|---|---|
| Owned by | a preset's `settings` JSON | the plugin's definition |
| Stored under | `settings.controls` / `settings.control_values` | `plugin:<id>:control_values` |
| What it switches | the preset's own prompt rows' `enabled` flags | nothing — it is a pure value |
| Has `prompts`? | yes (`ControlOption.prompts`) | **no** — [see below](#why-a-plugin-control-has-no-prompts) |
| Read by prompt text | `{{ui:<controlId>}}` | `{{ui:plugin:<pluginId>:<controlId>}}` |
| Read by code | not by plugins | `ctx.controls` and the `controls` map on events |
| Rendered in | the Presets page card | the plugin's card in Settings → Plugins |

A plugin control is an **app-level value the plugin owns**: "verbosity",
"target language", "answer style". The plugin decides what the value means.
Preset controls, by contrast, exist to switch a preset's prompt rows on and
off; a plugin has no such rows, so there is nothing for a plugin control to
toggle.

```ts
import { definePlugin, type PluginControl } from "@suvoj/plugin-sdk";

const controls: PluginControl[] = [
  {
    id: "verbosity",              // kebab-case, unique per plugin
    label: "Verbosity",
    description: "How much detail the plugin asks the model for.",
    type: "select",               // "select" (dropdown) or "toggle" (switch)
    default: "balanced",          // option id when the user never chose
    options: [
      // `value` is the text {{ui:…}} expands to; empty → label, else id.
      { id: "terse", label: "Terse", value: "be terse" },
      { id: "balanced", label: "Balanced", value: "balanced detail" },
      { id: "rich", label: "Rich", value: "rich detail" },
    ],
  },
];

export default definePlugin({
  id: "my-plugin",
  name: "My Plugin",
  version: "1.0.0",
  controls,
  setup: (ctx) => {
    ctx.log(`verbosity: ${ctx.controls.get("verbosity")}`); // → "balanced"
    return {};
  },
});
```

### The two types

- **`select`** renders a dropdown; it may declare any number of options.
- **`toggle`** renders a two-position switch and therefore declares **exactly
  two options**, in `[on, off]` order: the first option is the "checked"
  state, the second the unchecked one. The switch binds to those ids — it does
  not guess which option means "on". A `toggle` with a different option count
  is rejected at load.

Every control needs at least two options; option ids are unique within the
control (they ARE the stored values), and `default` must name a real option
(or be `""`, meaning "the first option"). The loader enforces all of this and
a violation is a **load error** — the plugin is listed with an `error` and
contributes nothing.

### Resolution: stored → `default` → first option

At every read the effective choice is resolved the same way, and it is
deliberately identical to a preset control's chain:

1. the **stored** option id, when it names a real option of this control;
2. else the control's **`default`**, when it names a real option;
3. else the **first** option.

A garbage or missing stored value never throws — the declaration is the
authority. That means `ctx.controls.get(id)` returns a usable id for any
declared control, and it returns `null` only for an id the plugin does not
declare.

### Where values persist, and how prompt text reads them

Values live under the settings key **`plugin:<id>:control_values`**, a
`Record<controlId, optionId>`. It is a separate key from
`plugin:<id>:settings` on purpose: replacing settings must never clear control
choices, and vice versa — the same split presets use for
`controls` / `control_values`.

Prompt text reads the current choice through the **namespaced macro**:

```
{{ui:plugin:<pluginId>:<controlId>}}
```

So a system prompt can say `Answer with {{ui:plugin:my-plugin:verbosity}}.`
The text it expands to is the chosen option's `value`, else its `label`, else
its id — exactly core's rule for preset controls. Plugin keys are namespaced,
so a plugin macro can never collide with a preset control's bare id.

> A **disabled** plugin contributes nothing: its control values do not enter
> the merged map, so its macro expands to nothing (the literal
> `{{ui:plugin:…}}` stays in the text). Enablement is what makes a
> contribution real — the same rule themes and strategies follow.

### Reading and writing

Inside the plugin, `ctx.controls` addresses **bare** control ids (the plugin
namespace is implied):

```ts
interface PluginControlsReader {
  get<T = string>(id: string): T | null; // resolved OPTION id; null if undeclared
  all(): Record<string, string>;          // every own control, bare id → option id
  set(id: string, value: string): void;   // persist + fire onControlChange
}
```

Reads are **live** — the stored map is read per call, so a write is visible to
the next read. `set` speaks **option ids** (not the `{{ui:…}}` display text)
and:

- **persists** under `plugin:<id>:control_values`,
- **fires** [`onControlChange`](#oncontrolchangeevent--observe-a-control-change)
  for every active plugin, including yours, so a write from code and a write
  from Settings behave identically;

and **throws** when `id` names no declared control or `value` is not one of
that control's option ids. What that throw means depends on where you call it:

- **inside a hook**, the host wraps the hook, logs
  `[plugin:<id>] <hook> failed: …` and continues — a bad write can never break
  generation. (The logged name is the hook you were in, e.g.
  `onBeforeGenerate failed`, not always `onControlChange`.)
- **outside a hook** (a `setTimeout`, an interval, your own code path), nothing
  wraps it, so the throw is yours to catch.

Reading through prompt text or the event map is the other half of the story:
[`BeforeGenerateEvent.controls`](#onbeforegenerateevent--readrewrite-the-prompt)
and [`PanelDataEvent.controls`](#onpaneldataevent--feed-a-drawer-tab) carry the
resolved values namespaced, with the **display text** (what `{{ui:…}}` renders)
rather than the option id. Between `ctx.controls.get` (the id) and the event
map (the text) you have both sides of every choice.

### Where controls render

The plugin's card in **Settings → Plugins** renders its declared controls
below the settings form: a caption naming the count, a dropdown per `select`, a
switch plus an "option in effect" caption per `toggle`. Changes save
immediately (through `PUT /api/plugins/:id/controls`) — a control is a single
choice, not a form field, so there is no Save button for it. A plugin with no
controls renders no controls block at all.

### Why a plugin control has no `prompts`

`PluginControlOption` deliberately lacks the preset option's `prompts: string[]`
field. A preset option lists the pipeline rows it switches on; a plugin has no
pipeline rows — its options are pure values. Dropping the field keeps the
shape honest: there is no half-implemented "switch these rows" surface a plugin
author could fill in and never see take effect.

> **Set a control programmatically** with `ctx.controls.set(id, value)`,
> exactly like the Settings UI does through the route below — both persist and
> both notify.

---

## Memory strategies

Plugins can add history-compaction strategies to the Memory settings. While
the plugin is enabled, its strategies are registered and selectable (by
id) in Settings → Memory and via a preset's `memory.strategy`; disabling
the plugin unregisters them.

```ts
import { definePlugin, type MemoryStrategy } from "@suvoj/plugin-sdk";

const keepLast: MemoryStrategy = {
  id: "keep-last-20",
  name: "Keep last 20 messages",
  apply: async (history, budget) => {
    const trimmed = history.slice(-20);
    return {
      history: trimmed,
      // Optional summary rendered after the history (and before the
      // tracker state block):
      summary: history.length > trimmed.length
        ? { seqFrom: history[0]!.seq, seqTo: history[history.length - trimmed.length - 1]!.seq,
            text: "[Earlier conversation elided]" }
        : undefined,
    };
  },
};

export default definePlugin({
  id: "memory-pack",
  name: "Memory Pack",
  version: "1.0.0",
  memoryStrategies: [keepLast],
  setup: () => undefined,
});
```

A strategy receives the seq-ordered active history, a **token budget** for
it (context minus the response reservation), and a context (`chatId`, the
resolved `config`, the summaries repository, a gateway-backed
`summarizeFn` when available, `rng`). It returns the surviving `history`
plus an optional `summary` block. The built-ins are `trim` and `summaries`
— study [`packages/@suvoj/core/src/engine/memory/trim.ts`](../packages/@suvoj/core/src/engine/memory/trim.ts)
for a complete example, including `configSchema` (zod) for strategy
options.

> **Reserved ids.** The strategy ids `trim` and `summaries` belong to the
> built-ins; a plugin declaring either is rejected at load with an error
> entry. Unregistration removes by id, so a plugin reusing a built-in id
> would take the built-in down with it when the plugin unloads — a preset
> selecting that id would then find nothing.

---

## Pipeline stages

Context-pipeline stages run before prompt assembly and can rewrite the
build context — history, lorebook result, macro inputs. While the plugin is
enabled, its stages are **appended after the built-in stages**
(`lorebook → memory → persona → history → tracker`), in declaration order.

```ts
import { definePlugin, type PipelineStage } from "@suvoj/plugin-sdk";

const moodStage: PipelineStage = {
  id: "mood-injector",
  async run(ctx) {
    // ctx: PromptContext — chat, character, persona, preset, history,
    // lorebook, summary, macros, repos, options...
    ctx.macros.persona = `${ctx.macros.persona}\n(Current mood: focused)`;
  },
};

export default definePlugin({
  id: "mood-tracker",
  name: "Mood Tracker",
  version: "0.1.0",
  pipelineStages: [moodStage],
  setup: () => undefined,
});
```

Use stages when you want to influence assembly **inputs** (what the
assembler sees), and `onBeforeGenerate` when you want to rewrite the
**final** prompt (what the model sees). The `PromptContext` shape is
defined in [`packages/@suvoj/core/src/engine/pipeline.ts`](../packages/@suvoj/core/src/engine/pipeline.ts).

> **Reserved ids.** The stage ids `lorebook`, `memory`, `persona`,
> `history`, and `tracker` belong to the built-in pipeline (the `tracker`
> stage fills `ctx.tail` with the selected swipe's newest tracker snapshots,
> which the assembler renders after the chat history and the memory summary).
> A plugin declaring one is rejected at load with an error entry, for the same
> reason as reserved strategy ids — unregistration removes the first stage
> matching the id, so a plugin stage reusing a built-in's would remove the
> built-in on unload.

---

## Tracker mechanisms

The [tracker](./TRACKER.md) periodically asks an AI for a structured JSON
snapshot of the scene and injects the selected swipe's newest one into the
prompt. A **tracker mechanism** is the pluggable pair of functions behind
that generation: how the tracker's prompt is built, and how the raw model
output is parsed. While the plugin is enabled, its mechanisms are registered
and selectable (by id) as the tracker's **mechanism** in the tracker
settings; disabling the plugin unregisters them again.

````ts
import { definePlugin, type TrackerMechanism } from "@suvoj/plugin-sdk";

const sceneDigest: TrackerMechanism = {
  id: "scene-digest",
  name: "Scene Digest",
  description: "Flat one-shot digest; regex-parses the reply.",

  buildGenerationMessages(input) {
    // input.messages is already windowed per the user's "message window"
    // setting (0 = the whole chat) — use it as your source material.
    const messages = [...input.messages];

    // The earlier positions' selected-swipe snapshots (oldest → newest)
    // keep the digest stable:
    for (const tracker of input.previousTrackers) {
      messages.push({
        role: "system",
        content:
          "Previous digest (keep consistent and build on it):\n" +
          "```json\n" + JSON.stringify(tracker, null, 2) + "\n```",
      });
    }

    messages.push({
      role: "system",
      content:
        "You maintain a compact scene digest. Reply with ONE ```json fenced " +
        'block of the shape {"summary": string, "tags": string[]} and nothing else.',
    });
    return messages;
  },

  parseResponse(raw) {
    const match = raw.match(/\{[\s\S]*\}/); // first top-level {...} span
    if (!match) throw new Error("no JSON object found in the tracker reply");
    const parsed = JSON.parse(match[0]) as { summary?: unknown; tags?: unknown };
    if (typeof parsed.summary !== "string") {
      throw new Error("digest reply is missing a string `summary`");
    }
    return {
      summary: parsed.summary,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    };
  },
};

export default definePlugin({
  id: "scene-digest-plugin",
  name: "Scene Digest",
  version: "0.1.0",
  trackerMechanisms: [sceneDigest], // ← the registration
  setup: () => undefined,
});
````

The server calls the two functions whenever a snapshot is due — per the
tracker's auto mode (after reply / before reply), or on manual generation:

1. **`buildGenerationMessages(input)`** — build the messages for the
   tracker's generation call. They are sent to the tracker's **own
   connection profile** (separate from the chat's profile; falls back to
   the default profile when unset).
2. **`parseResponse(raw, input)`** — turn the raw model output into the
   snapshot (a `TrackerData`: a plain JSON object). **Throw to signal
   failure** — the message is surfaced as an HTTP 502 and nothing is saved;
   a successful return is stored as the new snapshot.

### Multi-request mechanisms (optional)

A mechanism can opt into **parallel generation** — one AI request per group
of top-level schema fields — by declaring a second pair of methods
**together**:

- **`buildGenerationRequests(input)`** — return one `{ messages }` per
  request. The server runs every request **in parallel** through the same
  tracker profile and sampling.
- **`parseResponses(raws, input)`** — `raws` aligns with the request array;
  return the merged `TrackerData`. **Throw to fail the whole snapshot** —
  nothing is saved (atomic), even if the other replies parsed fine.

Declaring **only one** of the two is rejected at load: a lone
`buildGenerationRequests` has no parser for its replies, and a lone
`parseResponses` has no requests to parse.

The resolved plan is on `input.parts` — one `TrackerSchemaPart` per request
(`index`, `fields`, and the subset `schema`). The preset's "Generation
requests" control resolves it; single-request mechanisms can ignore it.
Built-in `suvoj-tracker` is a complete example: it prefixes each part's JSON
prompt with a `PART i OF n` header and shallow-merges the replies.

```ts
buildGenerationRequests(input) {
  return input.parts.map((part) => ({
    messages: [
      { role: "system", content: `Generate ONLY: ${part.fields.join(", ")}` },
      { role: "system", content: JSON.stringify(part.schema) },
    ],
  }));
},
parseResponses(raws, input) {
  return Object.assign({}, ...raws.map((raw) => JSON.parse(raw)));
},
```

`TrackerGenerationInput` gives you everything the built-in gets:

| Field | Meaning |
|---|---|
| `chat` | The chat row the snapshot belongs to. |
| `character` | The chat's character, or `null`. |
| `persona` | The user's active persona, or `null`. |
| `messages` | Windowed active history — per the user's message-window setting (`0` = all). |
| `previousTrackers` | The selected-swipe snapshots of positions before the target's, **oldest → newest** (the target's own position is excluded, so a regenerated swipe starts from zero). |
| `config` | The full tracker configuration (windows, retention, system prompt, …). |
| `schema` | The **active schema preset object** — when your mechanism is schema-driven like the built-in. |
| `parts` | The **resolved generation plan** — one entry per request (`index`, `fields`, `schema`); always at least one. Single-request mechanisms can ignore it. |

If the configured mechanism id is missing (its plugin got disabled), the
server falls back to the built-in `suvoj-tracker` mechanism with a logged
warning, so tracker generation keeps working.

> **Reserved id.** The mechanism id `suvoj-tracker` is the built-in; a plugin
> declaring it is rejected at load with an error entry — same reasoning as
> reserved [strategy](#memory-strategies) and [stage](#pipeline-stages)
> ids: unregistration removes by id, and a plugin must never take a
> built-in down with it.

The built-in itself — a schema-driven prompt with a repair parser — is a
complete reference implementation:
[`packages/@suvoj/core/src/tracker/mechanism-suvoj-tracker.ts`](../packages/@suvoj/core/src/tracker/mechanism-suvoj-tracker.ts).

---

## UI contributions

UI is contributed declaratively on the definition; the web client renders
it (server plugins never ship their own frontend code):

```ts
ui: {
  sidebarItems: [
    { label: "Example", href: "/settings#plugins", icon: "Sparkles" }, // lucide icon name
  ],
},
```

`sidebarItems` entries appear in the app sidebar while the plugin is
enabled. Chat-drawer tabs, [themes](#themes), and the
[global stylesheet](#global-stylesheet) all follow the same
declare-on-the-definition pattern.

---

## Themes

A plugin can contribute full colour palettes. While the plugin is enabled,
its themes join the built-ins in **Settings → Appearance**, grouped under
**Dark** / **Light**; the user picks one exactly like `midnight` or
`daylight`. Selecting a plugin theme applies it only for as long as the
plugin stays enabled — disable it and the picker falls back to a built-in,
because a disabled plugin contributes nothing.

```ts
import { definePlugin, type PluginTheme } from "@suvoj/plugin-sdk";

const moss: PluginTheme = {
  id: "moss",              // kebab-case; must not collide with a built-in
  name: "Moss",            // the name shown in the picker
  kind: "dark",            // "dark" | "light" — drives color-scheme
  vars: {
    "--bg": "#121a16",         // required, concrete #rrggbb hex
    "--bg-elev": "#1b2620",    // required, concrete #rrggbb hex
    "--bg-subtle": "#0c1210",  // required, concrete #rrggbb hex
    "--fg": "#e8efe9",
    "--fg-muted": "#a3b6a8",
    // … the remaining required tokens (see the contract below)
  },
};

export default definePlugin({
  id: "moss-theme",
  name: "Moss",
  version: "1.0.0",
  themes: [moss],
  setup: () => undefined,
});
```

### The `PluginTheme` shape

| Field | Meaning |
|---|---|
| `id` | Unique kebab-case (`^[a-z0-9-]+$`). May not reuse a built-in — see reserved ids below. |
| `name` | Display name in the Appearance picker. |
| `kind` | `"dark"` or `"light"`; becomes the rule's `color-scheme`. |
| `vars` | Every CSS custom property of the palette, keyed by token name (`"--bg"`, …). |

### The token contract

`vars` must define all **24 required tokens** (the same contract the eight
built-ins honour in
[`packages/web/src/styles/themes.css`](../packages/web/src/styles/themes.css)):

```
--bg --bg-elev --bg-subtle --fg --fg-muted --fg-faint
--accent --accent-hover --accent-fg --focus
--border --border-strong --danger --success --warning
--msg-quote --msg-em --msg-underline
--badge-bg --badge-fg
--shadow-card --shadow-deep --scrim --scrollbar
```

`PLUGIN_THEME_REQUIRED_TOKENS` exports this list from the SDK; a theme
missing any of them is rejected at load with an error entry (a half-defined
theme would otherwise silently inherit `midnight`'s values).

Three of those tokens — `--bg`, `--bg-elev`, `--bg-subtle`
(`PLUGIN_THEME_HEX_TOKENS`) — **must be concrete 6-digit `#rrggbb` hex.**
The web client parses them out of the computed style to derive the
accent/badge WCAG contrast math, so a gradient or a colour keyword there
would silently break it. Every other token may be any CSS colour,
`color-mix(...)`, or — for `--shadow-card` / `--shadow-deep` — a full
multi-layer shadow value.

`--bg-image` is the one **optional, decorative** token. It is how a palette
paints a page wash (a `radial-gradient(...)`, as the built-in `nebula` and
`lagoon` do) without putting a gradient in `--bg`. Keep the stops within a
few percent of `--bg` so body copy keeps its contrast against the wash.

> **Reserved ids.** The eight built-in ids — `midnight`, `coffee`, `aurora`,
> `nebula`, `daylight`, `paper`, `mist`, `lagoon`
> (`PLUGIN_THEME_RESERVED_IDS`) — are reserved: the web client ships those
> palettes itself, so a plugin reusing one would shadow (or never reach) the
> built-in. A plugin declaring a reserved id, or declaring the same id twice
> within one definition, is rejected at load with an error entry — same
> reasoning as reserved [strategy](#memory-strategies) /
> [stage](#pipeline-stages) / [mechanism](#tracker-mechanisms) ids. Unlike
> those, a theme id is released the moment its plugin is disabled, so a
> different plugin can then claim it.

### How a theme is applied

The web client injects a single `<style>` element holding one
`:root[data-theme="<id>"] { color-scheme: <kind>; …vars }` rule per
contributed theme — the same shape as the built-in blocks, so the cascade
treats them identically. Applying a theme is purely a matter of the
`data-theme` attribute already on `<html>`: selecting it in the picker sets
that attribute to the plugin's id, and the matching rule takes over.

---

## Global stylesheet

A plugin can ship a raw stylesheet alongside its themes via `globalCss`:

```ts
export default definePlugin({
  id: "moss-theme",
  name: "Moss",
  version: "1.0.0",
  themes: [moss],
  globalCss: `
    ::selection {
      background: color-mix(in srgb, var(--accent) 32%, transparent);
      color: var(--fg);
    }
  `,
  setup: () => undefined,
});
```

The string is injected into a `<style>` element on the host document while
the plugin is enabled, and removed when it is disabled. It derives its
colours from the theme variables so it follows whatever palette is active.

> **`globalCss` is trusted, unscoped CSS.** Unlike a drawer tab's `css`
> (which is scoped to the tab), it targets the whole page and can restyle
> anything — because plugins are trusted local code, the same trust model
> described in [Error isolation guarantees](#error-isolation-guarantees).
> Keep it tasteful and reversible: scope it to markup you own, or derive
> from theme vars, rather than reaching into the app's own class names.

---

## Chat drawer tabs

The chat drawer (the panel sliding in from the right of a chat) hosts the
built-in **tracker** and **summaries** tabs. Plugins add their own tabs the
same declarative way as sidebar items: a `DrawerTab` on the definition,
plus an `onPanelData` hook producing the tab's data.

```ts
import { definePlugin, type DrawerTab } from "@suvoj/plugin-sdk";

const quotesTab: DrawerTab = {
  id: "quotes",           // unique; `tracker` and `summaries` are reserved
  label: "Quotes",
  icon: "Quote",          // lucide icon name (falls back to Puzzle)
  htmlTemplate: `
    {{#if headline}}<h3>{{headline}}</h3>{{/if}}
    <ul class="quotes">
      {{#each quotes}}
        <li class="quote">
          <span class="index">{{@index}}</span>
          <span class="who">{{this.who}}</span>
          “{{this.line}}”
        </li>
      {{/each}}
    </ul>
    <p class="cast">{{join cast ", "}}</p>
  `,
  css: ".quotes { list-style: none; padding: 0 }",
};

export default definePlugin({
  id: "quotes-plugin",
  name: "Quotes",
  version: "0.1.0",
  drawerTabs: [quotesTab],
  setup: () => ({
    onPanelData(event) {
      // event.chat / event.character / event.persona / event.messages …
      const quotes = event.messages
        .filter((message) => message.role === "user")
        .slice(-5)
        .map((message) => ({
          who: event.persona?.name ?? "You",
          line: message.content.slice(0, 80),
        }));
      return {
        headline: event.chat?.title,
        quotes,
        cast: [event.character?.name, event.persona?.name].filter(
          (name): name is string => typeof name === "string",
        ),
      };
    },
  }),
});
```

### The data flow

While the plugin is enabled, its tabs appear in every chat's drawer. When
the user opens one, the web client fetches its data **once** — on open, no
polling:

```
GET /api/plugins/:pluginId/tabs/:tabId/data?chatId=<id>
```

- the server invokes the plugin's `onPanelData` hook and answers with the
  render envelope:

  ```json
  { "htmlTemplate": "<the tab's declared DrawerTab.htmlTemplate>",
    "css": "<the tab's declared css, or \"\">",
    "data": { "…": "the onPanelData hook result" } }
  ```

  the web renders the DECLARED `htmlTemplate` with `data` (the hook
  result) as the template's data root — hooks return plain data and never
  need to echo templates;
- unknown plugin or tab id → **404**; a throwing hook → **500** (the tab
  shows its error state — generation is never affected).

### `onPanelData(event)`

The event carries the full chat context:

| Field | Meaning |
|---|---|
| `pluginId` | Your plugin's id. |
| `chatId` | The chat whose drawer is open. |
| `tab` | The `DrawerTab` being opened (your own declaration). |
| `chat` | The chat row — `title`, character/persona links, … (`null` when unknown). |
| `character` | The chat's character (`name`, `description`, …) or `null`. |
| `persona` | The user's active persona or `null`. |
| `messages` | The chat's active history as prompt messages, seq-ordered. |

### Template syntax

Tab templates use the same tiny template language as the tracker's HTML
presets ([TRACKER.md](./TRACKER.md)); the data root is the route's `data`
field — the `onPanelData` JSON:

| Syntax | Meaning |
|---|---|
| `{{path.to.value}}` | Dot-path interpolation, **HTML-escaped**. |
| `{{{path}}}` | Unescaped — use with care (only for markup you generate). |
| `{{#each array}} … {{/each}}` | Iterate; inside use `{{this}}`, `{{this.field}}`, `{{@index}}`. |
| `{{#if path}} … {{else}} … {{/if}}` | Truthiness check. |
| `{{join array ", "}}` | Join an array of strings/numbers. |

```html
<h2>{{chat.title}}</h2>                                    <!-- escaped -->
{{#if character}}<p>Playing with {{character.name}}</p>{{/if}}
{{#each messages}}
  <div class="row row-{{@index}}">{{this.role}}: {{this.content}}</div>
{{/each}}
<p>Cast: {{join castNames ", "}}</p>
```

### Rendering sandbox

Tab HTML renders inside a **sandboxed iframe** — scripts are disabled and
there is no same-origin access; the template plus the data root are the
only inputs. Because `{{ }}` interpolations are HTML-escaped, text coming
from chats or models can't inject markup into the panel. The `css` string
is scoped to the tab's own content.

> **Reserved ids.** The tab ids `tracker` and `summaries` belong to the
> built-in drawer tabs; a plugin declaring either is rejected at load with
> an error entry — same reasoning as reserved
> [strategy](#memory-strategies) / [stage](#pipeline-stages) /
> [mechanism](#tracker-mechanisms) ids.

---

## Lifecycle & persistence

| Moment | What happens |
|---|---|
| **Discovery** | Server start / **Reload** scans `plugins/*/`, imports each entry, validates id/name/version/setup shape. |
| **Activation** | Enabled plugins run `setup(ctx)`; declared registrations apply — strategies/stages/mechanisms/tabs register, themes join the Appearance picker, `globalCss` is injected; `onChatEvent` subscribes to the bus. |
| **New plugin** | Defaults to **disabled** — installing is dropping a folder in and pressing Reload; enable it from the list to activate it. |
| **Disable** | `onUnload()` runs, all registrations disposed (strategies/mechanisms unregistered, stages removed, tabs withdrawn, themes and `globalCss` removed, bus unsubscribed), flag persisted. |
| **Enable** | Flag persisted, plugin re-activates (`setup` runs again). |
| **Reload** | Everything unloads, the folder rescans, still-enabled plugins re-activate with **fresh module source** (edited code is re-imported). |
| **Removal** | Delete the folder + Reload; its settings keys (`plugin:<id>:*`) can be dropped manually if desired. |

Enabled state survives restarts; a plugin the user enabled stays enabled
across reloads and restarts, and a disabled one stays disabled.

One cost of Reload's fresh imports: each reload busts Bun's module cache
with a new nonce, so every plugin gets a **fresh module instance** — and
prior instances are not evicted from that cache. At normal scale this is
negligible; restart the server to fully reclaim the memory of many
reloaded plugins.

---

## Error isolation guarantees

The host treats every plugin as **trusted local code with fault
isolation**, with one rule: **a plugin must never take the server down.**

Plugins execute inside the server process with the same permissions as the
server itself — full filesystem and network access included. Install only
plugins you trust: the host isolates crashes and errors, not malicious
behavior. A plugin's `package.json` `main` is resolved as-is and runs at that
same trust level (it must resolve inside the plugin's own folder).

- **Import/validation failure** (syntax error, missing export, bad id,
  missing `setup`): the plugin is *listed* with an `error` string, but
  loads nothing — fix the folder and press **Reload**. Other plugins and
  the rest of the server are unaffected.
- **`setup` throws**: the plugin is *listed* with an `error` string and no
  hooks installed, and keeps its enable toggle — turn it off, or fix the
  plugin and press **Reload** to retry activation.
- **Any runtime hook throws** (`onBeforeGenerate`, `onDelta`,
  `onResponse`, `onChatEvent`, `onSummariesChanged`, `onControlChange`,
  `onUnload`): the failure is logged to the
  console as `[plugin:<id>] <hook> failed: …` and skipped. **Generation
  never fails because of a plugin** — the prompt/reply falls back to what
  the previous plugins (or the engine) produced.
- **`onPanelData` throws**: the tab's data request fails with an HTTP 500
  (the drawer shows the tab's error state). Chat generation is unaffected.
- **Duplicate ids**: the second folder loses — it is listed as an error
  entry; the first plugin keeps working.
- **Appearance contributions** ([themes](#themes), the
  [global stylesheet](#global-stylesheet)): an invalid theme or a
  non-string `globalCss` fails validation and lists the whole plugin with
  an `error`, contributing nothing. A disabled or errored plugin's themes
  never reach the picker and its stylesheet is never injected — the
  Appearance screen keeps working regardless.

Cost of the guarantee: hooks must be side-effect-tolerant. A hook that
mutated shared state and then threw may have applied half its effects —
write hooks defensively (validate before mutating, e.g. clone-then-edit
arrays).

---

## Management API

The Settings UI is built on a small public API (also handy for scripting):

| Method | Path | Body / Result |
|---|---|---|
| `GET` | `/api/plugins` | `{ plugins: [{ id, name, version, description?, enabled, error?, loaded, settingsSchema, settings, controls?, controlValues, ui, themes, globalCss }] }` |
| `POST` | `/api/plugins/reload` | rescans the folder, returns the fresh list |
| `PATCH` | `/api/plugins/:id` | `{ enabled: boolean }` → `{ plugin }` |
| `GET` | `/api/plugins/:id/settings` | `{ settings }` (effective values; `null` without a schema) |
| `PUT` | `/api/plugins/:id/settings` | `{ settings: { key: value, ... } }` — replaces stored settings, validated against the schema (unknown keys and type mismatches are 400s with per-key details) |
| `PUT` | `/api/plugins/:id/controls` | `{ values: { <controlId>: <optionId> } }` → `{ control_values }` — merges the given choices, validated against the declared controls (unknown control/option are 400s with per-key details); returns the plugin's fresh resolved values |
| `GET` | `/api/plugins/:id/tabs/:tabId/data?chatId=<id>` | `{ htmlTemplate, css, data }` — the tab's declared template + stylesheet, `data` being the `onPanelData` hook result (404 unknown plugin/tab; 500 on hook error) |

`GET /api/plugins` reports `controls` only when the plugin declares any, and
`controlValues` is `null` when it does not (an object of resolved
`controlId → optionId` otherwise). The controls route is focused — it merges
over `plugin:<id>:control_values` without touching `plugin:<id>:settings`, so
the two stores never clobber each other.

---

## Example plugin walkthrough

[`plugins/example-plugin/index.ts`](../plugins/example-plugin/index.ts)
is intentionally small and heavily commented. It demonstrates:

1. **Settings** — the boolean/string/number/select types plus the two richer
   ones: `notes` (a `textarea`, default `""`) and `tags` (a `multiselect`,
   default `["example"]`).
2. **A control** — `verbosity` (a `select`) reads from prompt text as
   `{{ui:plugin:example-plugin:verbosity}}` and from code via `ctx.controls`.
3. **`ctx.controls`** — `setup` logs the resolved `verbosity` option id.
4. **`onControlChange`** — logs every change to the plugin's own control
   (from Settings or a writer), with its option id.
5. **`onBeforeGenerate`** — always logs the prompt size; with "Log prompts"
   on, logs every message. It also reads `verbosity` two ways — the option id
   from `ctx.controls` and the display text from `event.controls` — to make
   the distinction concrete.
6. **`onResponse`** — with "Add signature" on, appends the signature text
   to the model's reply (response editing — the replacement is persisted
   and returned in the `done` event).
7. **A custom memory strategy** — `none`, which passes the full history
   through with no trimming; it appears in Settings → Memory while the
   plugin is enabled.
8. **A sidebar item** — `{ label: "Example", href: "/settings#plugins", icon: "Sparkles" }`.

To watch it work: enable it (it ships disabled). Its card in
**Settings → Plugins** now shows the settings form and, below it, the
**Verbosity** control — flip it and the plugin logs the change on the server
console (`[plugin:example-plugin] control changed: verbosity → rich`). Turn on
"Add signature", send a chat message — the reply arrives with the signature
appended (the streamed text shows the raw model output; the final message
includes the signature). Then check the console for
`[plugin:example-plugin] prompt assembled: N messages` and the two
`verbosity=` lines that show the option id beside the text
`{{ui:plugin:example-plugin:verbosity}}` renders.
