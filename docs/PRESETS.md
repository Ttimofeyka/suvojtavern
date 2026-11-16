# Presets

A preset is the **prompt pipeline** every generation runs through: an
ordered list of instruction and data blocks the model reads before it
answers. The list order **is** the generation order — the top row is read
first, the bottom row last. There is no separate ordering field, so moving
a row in the editor moves it in the prompt.

Each row is one of two things:

- a **slot** (marker) — a fixed position the engine fills with its own
  data: the character card, the persona, lorebook entries, the chat
  history. Only `main` and `jailbreak` carry editable text of their own.
- a **regular prompt** — a block that sends its own text, under the role
  you pick (`system`, `user`, or `assistant`).

Presets carry **no sampling**. Temperature, model, and every other sampler
belong to the **connection profile** the chat uses, not to the preset — one
preset works across every model. (This is why a preset has no temperature
field to edit.)

One preset is the **default**: new chats start from it. Star it on the
Presets page.

---

## Table of contents

1. [The pipeline and its slots](#the-pipeline-and-its-slots)
2. [Roles](#roles)
3. [Injection position and depth](#injection-position-and-depth)
4. [Generation settings](#generation-settings)
5. [Generation-type gating](#generation-type-gating)
6. [Controls](#controls)
7. [Import and export](#import-and-export)
8. [Designing a lean preset](#designing-a-lean-preset)

---

## The pipeline and its slots

A preset stores its `prompts` as an **ordered array**. At generation time
the assembler walks that array top to bottom; each entry renders at its
position (unless it is an in-chat injection — see
[below](#injection-position-and-depth)). Every rendered text — character
fields, prompt contents, history messages — passes through the macro engine
(`{{char}}`, `{{user}}`, …) and then the configured prompt-placement regex
rules.

The ten slot markers, in their default order:

| Marker | Renders |
|---|---|
| `main` | the preset's own **main prompt** text — the system prompt that leads every generation. The character's `system_prompt` never overrides it. |
| `worldInfoBefore` | lorebook activations whose position is *before the character definitions* |
| `personaDescription` | the active persona's description |
| `charDescription` | the character's description field |
| `charPersonality` | the character's personality field, wrapped in the [personality format](#generation-settings) (`{{personality}}` is substituted) — skipped when the field is empty |
| `scenario` | the character's scenario field, wrapped in the [scenario format](#generation-settings) (`{{scenario}}` is substituted) — skipped when the field is empty |
| `worldInfoAfter` | lorebook activations positioned after the character definitions (including the author's-note positions) |
| `dialogueExamples` | the character's `mes_example`, split into blocks on `<START>`; each block is preceded by the [new example chat prompt](#generation-settings) |
| `chatHistory` | the conversation itself — the [new chat prompt](#generation-settings), the active history, in-chat injections, and lorebook `@depth` entries; then the **dynamic tail**: the memory summary and the tracker state block |
| `jailbreak` | the preset's own **post-history instructions** — the last word after the chat. The character's `post_history_instructions` never overrides it. |

A row switched **off** stays saved but is left out of every generation.

> **The summary and the tracker block render AFTER the conversation.** Inside
> `chatHistory` the order is: new-chat marker → live messages (with depth
> injections) → memory summary → tracker state block. Both tail blocks are
> dynamic — the summary is rewritten when a chunk boundary lands, and the
> tracker block changes every turn — so putting them after the conversation
> keeps everything before them (the system prompt, the card, the lorebook, and
> the history) a stable prefix that providers can cache. It also puts the
> freshest state where a long context's attention is strongest.
>
> **Volatile macros in the prefix cost a cache miss every turn.** `{{time}}`,
> `{{date}}`, `{{isotime}}`, `{{isodate}}`, `{{weekday}}`, `{{idle_duration}}`,
> `{{lastMessage}}`, `{{random}}`, and `{{roll}}` all render a different value
> on every generation. In a row above `chatHistory` that changes the prompt
> prefix, so nothing after it can be reused. The editor flags those rows;
> `{{pick}}` is exempt because it is seeded per chat and text, and renders the
> same value each time.
>
> **A layout without `chatHistory` drops in-chat injections.** Depth
> injections (and lorebook `@depth` entries) have no history to land in, so
> they are silently discarded. The editor warns when the slot is missing.

---

## Roles

Every row is sent under a role — the label the model sees:

| Role | Read by the model as |
|---|---|
| `system` | authoritative instructions and context |
| `user` | text from you |
| `assistant` | text from the character |

A regular prompt's role is what lets an example steer style: an
`assistant`-role block reads as something the character already said. Slots
render under their own row's role too (default `system`), so a slot can be
demoted to a history message if a model treats system content differently.

---

## Injection position and depth

By default a prompt renders **in place** — at its position in the array.
Its **Advanced → Injection** control can instead make it an **in-chat depth
injection**:

| Field | Meaning |
|---|---|
| `injection_position` | `0` = in place (array position), `1` = in-chat depth injection |
| `injection_depth` | how many messages **back from the end** of the chat history it lands (`0` = right after the newest message) |
| `injection_order` | ordering among injections that share a depth; **higher renders closer to the end** |

An injected prompt does **not** render at its array position; it is spliced
into the history at `depth` messages from the end. `LorebookPosition.AtDepth`
lorebook entries join the same insertion pass. The splice order mirrors
SillyTavern: deepest first, and at equal depth the higher `injection_order`
ends up closer to the newest message.

Only **regular prompts** can be injected — a slot is a fixed position and
ignores `injection_position`. Injections are never trimmed by the token
budget (they are prompt blocks, not chat history).

---

## Generation settings

The preset editor's **Generation** section holds the engine settings that
shape assembly but are not rows. They are stored on the preset under
`settings`:

| Setting | Default | Meaning |
|---|---|---|
| World info scan depth (`scan_depth`) | 2 | how many of the newest history messages the lorebook scans for trigger keys |
| World info budget (`wi_budget`) | 1024 | token cap for all lorebook entries activated in one prompt |
| New chat prompt (`new_chat_prompt`) | `[Start a new chat]` | system line inserted at the very start of the chat history, marking where the live conversation begins |
| New example chat prompt (`new_example_chat_prompt`) | `[Example Chat]` | system line inserted before each example-dialogue block |
| Personality format (`personality_format`) | `{{char}}'s personality: {{personality}}` | template wrapping the character's personality field |
| Scenario format (`scenario_format`) | `{{scenario}}` | template wrapping the character's scenario field |

The two **format** fields are templates: the literal `{{personality}}` /
`{{scenario}}` placeholder is replaced with that character field's text
before macro evaluation, so the usual `{{char}}` / `{{user}}` macros still
work around it. An empty single-line prompt value sends nothing.

Memory wiring (`settings.memory`) also lives on the preset, but it is
managed from **Settings → Memory** (`memory_strategy` / `memory_config`
override it globally); the preset editor preserves it untouched.

> The shipped **Suvoj Default** sets `scan_depth` to 4, and renders its
> reasoning checklist as a regular prompt immediately after `chatHistory` —
> so the model reads the tracker's state before the per-turn task. It is not a
> depth injection: it is never trimmed, and it lands after the summary and
> tracker rather than inside the live window.

---

## Conditional blocks: `{{#has:<tag>}}`

A prompt can reference **optional machinery** — a banned-word list, a
graphics protocol, a voice block — without leaving a dangling reference
when that row is switched off. Wrap the reference in a presence
conditional and it renders only when the tag is actually in the prompt:

```text
7. Formatting:{{#has:gfx_protocol}} Is <gfx_protocol> appropriate here?{{/has}}
{{^has:formatting_constraints}} Pick a sensible length for this scene.{{/has}}
```

| Macro | Renders its contents when |
|---|---|
| `{{#has:<tag>}}…{{/has}}` | some **enabled** row defines `<tag>…</tag>` |
| `{{^has:<tag>}}…{{/has}}` | no enabled row defines it |

Two rules make this predictable:

- **A tag is "defined" only by a matched pair** — an opening `<tag>` *and*
  a closing `</tag>`. A bare mention (`<npc_voice>` cited inside an
  instruction, or the escaped `` \`<npc_voice>\` `` form) is a reference,
  never a definition, so one block citing another can't make it look
  enabled. Author comments (`{{// … }}`) and self-closing tags (`<br />`)
  don't count either.
- **The set is the preset's effective rows** — the same ones generation
  renders, after control choices are applied. Switching the defining row
  (or the control that owns it) rewrites every conditional in the prompt.

A block whose condition fails **disappears entirely**, contents included,
so it costs no tokens and the model never reads a reference to something
it was not given. A balanced block costs nothing beyond its own contents;
a block is left **verbatim** when it is unbalanced (no matching
`{{/has}}`) or when the tag set was never resolved, so a typo can never
silently swallow the rest of a prompt. Blocks nest, and macros inside a
kept block still evaluate (`{{char}}` & co.); macros inside a *dropped*
block do not run, so a `{{setvar}}` the model never sees has no effect.

---

## Generation-type gating

Each prompt carries an `injection_trigger` list — SillyTavern's field for
gating a block to particular generation types. The Suvoj server sets one
type per run:

| Suvoj request | `injection_trigger` type |
|---|---|
| a normal send | `normal` |
| **Continue** | `continue` |
| **Regenerate** (including a swipe) | `regenerate` |
| `swipe` | mapped to `regenerate` — in the prompt engine swipes and regenerates are the same action |

An **empty** trigger list means **all generation types** — the default, and
what every row in a freshly created preset carries. A **non-empty** list
means the prompt is sent only when the active type is in it, so a prompt
gated to `continue` is included in a continue run and skipped in a normal
one.

Two SillyTavern trigger values have **no Suvoj equivalent**:

- `quiet`
- `impersonate`

They are **accepted on import but never match**, so a prompt gated only to
them is simply never sent. Unknown trigger strings are likewise kept
verbatim (never an import error) and behave like any other non-matching
value — a future SillyTavern trigger can never break a preset file.

---

## Controls

A **control** is a named switch on the preset that offers a set of mutually
exclusive **options** (Point of View = 1st person / 2nd person / 3rd person /
Hybrid, or a plain on/off flag). It exists so a choice can be made **once for
the whole preset** instead of reaching into the pipeline and hand-managing the
rows it drives.

A preset carries two hidden keys under its `settings` — you will not edit
them by hand, the editor writes them while you build the control:

| Key | Holds |
|---|---|
| `controls` | the control definitions: id, label, description, type, options |
| `control_values` | the chosen option id per control id |

A control is **preset-wide, not chat-wide**: it lives on the preset row, so
flipping it changes how **every chat using that preset** generates. There is
no per-chat override — if one chat needs a different Point of View, give it a
preset that picks that option (a chat resolves its preset like any other
setting).

### `select` vs `toggle`

Every control has a `type` that decides how it renders and how many options
it may carry:

| Type | Renders as | Options |
|---|---|---|
| `select` | a dropdown | two or more — the usual “pick one of these” switcher |
| `toggle` | a switch | exactly two, in `[on, off]` order — an on/off flag |

The distinction is purely how the choice is presented; the switching rules
below are identical for both.

### Each option names the rows it switches

An option lists the **prompt ids** it turns on. Choosing it switches those
rows **on** and switches every **sibling** option's rows **off** — one
control can never leave two of its alternatives on at once. This is the same
“alternatives, not additions” promise a **group** makes (a group is
editor-only metadata that labels a set of rows as one pick-one choice,
without touching `settings`), and it is why a control is a better fit than
four rows you enable by hand.

The switch is **materialized onto the stored rows**, not overlaid on top of
them. When you flip a control — on the preset card, or in the editor — the
chosen option's rows are switched on and its siblings off **inside the
preset**, and every other settings key is left alone. The editor, every
generation, and the exported file therefore read the same flags: there is no
second layer that could disagree, and a preset saved after a flip already
carries that choice in its own rows.

A row named by a control has **no independent switch**. The editor disables
its toggle and names the owning control, because the control — not the row —
decides whether it is sent. Hand-editing the flag in the JSON file could not
take effect either: the next save through the editor normalizes it right
back, and generation would apply the control's choice regardless. Rows **no
option names** are untouched and keep working exactly as before — their
switch is live and is the only thing that turns them on or off.

This is why a preset should drive a given row through **one** mechanism: a
control and a group on the same rows would leave the group's manual switch
looking broken, because the control's choice always decides the row.

### Reading the choice in prompt text: `{{ui:<controlId>}}`

A prompt can read the current choice — for example to restate it in a
sentence the pipeline rows cannot. `{{ui:<controlId>}}` resolves, in order:

1. the chosen option's **`value`** — the phrase the author wrote for it;
2. else the option's **`label`** — the name shown in the switcher;
3. else the option's **id**.

An **unknown control id** — or a malformed macro — is left **verbatim**, like
any other unknown macro, so nothing is silently blanked. An empty `value` is
a deliberate “fall through to the label”, never an error.

### Point of View in the shipped preset

The built-in **Suvoj Default** preset declares one `select` control:

| Control id | Label | Options (id → label) | Default |
|---|---|---|---|
| `pov` | Point of View | `first` → 1st person · `second` → 2nd person · `third` → 3rd person · `hybrid` → Hybrid | `hybrid` |

Each option switches exactly the matching pipeline row — `first` turns on
`1st-person-pov`, `second` `2nd-person-pov`, `third` `3rd-person-pov`,
`hybrid` `hybrid-pov` — and switches the other three off **in the stored
preset**, so the POV block that is sent, the rows the editor shows, and the
exported file always match the dropdown. The default, **Hybrid**, is the same
row the shipped `prompt_order` leaves enabled, so a chat that never touches
the control generates exactly what the ST file describes.

The four rows are **not** tagged with a Point of View *group*: the control
already owns them, and a group on the same rows would be a second, silent
mechanism. The other grouped rows (prose style, NSFW, echo, chain of thought)
are unaffected and still ship as groups.

---

## Import and export

Press **Export** on a preset to download it as a **native Suvoj document**
(`suvoj.preset`, version 1): name, description, the ordered prompts, and
the settings — no ids or timestamps, so it can be re-imported cleanly.

**Import** accepts either shape and detects it automatically:

| Shape | Detection | Behaviour |
|---|---|---|
| **Native `suvoj.preset`** | no `prompt_order`, prompts carry string `id`s | normalized through the engine schema: defaults filled, missing prompt ids healed into slugs that cannot shadow a slot marker |
| **SillyTavern chat-completion preset** | a `prompt_order` array, or prompts carrying `identifier` with no `id` | converted: `main` / `jailbreak` keep ST's content, other ids become readable slugs, the array follows ST's `prompt_order[0].order`, and prompts missing from the order are appended **visible-but-off** |

Duplicate names are handled by the chosen **conflict policy**:

| Policy | On a same-name preset |
|---|---|
| **Fail** (default) | nothing is stored; the clash is reported (HTTP 409) |
| **Keep both** | the import gets a numbered name (`Name 2`, …) |
| **Replace** | the existing preset is overwritten in place |

ST's `new_chat_prompt`, `new_example_chat_prompt`, `personality_format`,
and `scenario_format` carry over into the [generation
settings](#generation-settings); ST sampling fields are ignored (connection
profiles own samplers).

> **`quiet` / `impersonate` and unknown triggers.** An ST preset using them
> imports fine, but those blocks never match a Suvoj run — edit or delete
> them in the preset editor if you want them sent.

---

## Designing a lean preset

The prompt is a budget: every always-on block spends tokens on every turn,
whether or not the scene needs it. A few habits keep a preset sharp:

- **Keep always-on instructions minimal.** The `main` and `jailbreak`
  blocks are read every generation — put a small, stable core there and
  everything situational behind a row you switch on.
- **Use off-by-default toggle rows for optional machinery.** Add a regular
  prompt and switch it off; it stays saved and visible in the pipeline but
  only joins the prompt when you enable it. Pair it with a short
  **header-stub** convention (a one-line label like `[Style: formal]`
  inside the block) so you can see at a glance what is on.
- **Prefer the native [tracker](./TRACKER.md) over in-prompt state
  blocks.** The prompt assembler is stateless: it renders what is stored
  and cannot persist anything the model *writes back* into the prompt. A
  preset block that asks the model to maintain a state section, or that
  prints a macro expecting the model to fill it in, produces **dead
  macros** — placeholders that never resolve to anything the model wrote.
  The tracker exists for exactly this: a separate model call writes a
  structured snapshot and the built-in `tracker` stage injects it, so state
  actually survives into later turns.
