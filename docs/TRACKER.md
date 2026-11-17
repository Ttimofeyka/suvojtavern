# Tracker

The tracker is a scene-state memory inspired by zTracker. For every chat,
the AI periodically writes a **structured snapshot of the scene** — who is
present, what they wear, where things stand — as JSON shaped by **your
schema**, and the selected swipe's newest snapshot is injected invisibly
into the prompt so the model keeps the scene in focus hundreds of messages
into a chat.

Each snapshot is attached to the message/swipe it followed, so a chat
position with several swipes can hold a tracker per swipe. The UI still
shows a single RPG-style panel: the **first tab of the chat drawer** (right
side of a chat, before Summaries), which follows the **selected swipe** —
switch to a sibling swipe and the panel swaps to that swipe's tracker.

How a snapshot happens:

1. When one is due (see [auto modes](#generating-snapshots)), the server
   builds a dedicated tracker prompt: your system prompt, a window of
   recent messages, and — for continuity — the selected-swipe snapshots of
   the positions **strictly before** the one being tracked.
2. That prompt goes to the tracker's **own connection profile** — separate
   from the chat's — so snapshots can come from a cheaper or faster model.
3. The model replies with JSON following the active schema preset.
4. The reply is parsed and saved onto the message/swipe it followed. The
   panel now shows it — and the built-in `tracker` pipeline stage injects
   the selected swipe's snapshot (and optionally a few predecessors) into
   every subsequent prompt, right **after the chat history and the memory
   summary**, immediately before the post-history instructions.

A generation never sees the tracker of the swipe it replaces: previous
trackers are read by **position**, and the target's own position — every
swipe sharing it — is skipped. A regenerated or newly added swipe therefore
starts "from zero" and builds forward from earlier positions only. Older
snapshots are pruned to the retention setting, but the newest selected-swipe
trackers survive long enough to feed the next generation as "previous
trackers" — so scene state evolves instead of resetting.

Unlike a trail of annotations attached to the transcript:

- **one panel per chat** — a snapshot describes the whole scene as of that
  moment; the panel reads the selected swipe's card, not a trail of
  annotations;
- **hidden injection** — snapshots ride along in the prompt as invisible
  context; they never appear as chat messages;
- **built-in retention** — old snapshots are pruned automatically, keeping
  the newest tracker per swipe row; no unbounded state pile-up.

---

## Table of contents

1. [Enabling and disabling](#enabling-and-disabling)
2. [Generating snapshots](#generating-snapshots)
3. [Connection profile](#connection-profile)
4. [Invisible mode](#invisible-mode)
5. [Generation indicator](#generation-indicator)
6. [Generation settings](#generation-settings)
7. [Prompt injection](#prompt-injection)
8. [Schema presets](#schema-presets)
9. [The built-in default preset](#the-built-in-default-preset)
10. [Drawer tabs](#drawer-tabs)
11. [Plugin mechanisms and tabs](#plugin-mechanisms-and-tabs)
12. [Troubleshooting](#troubleshooting)

---

## Enabling and disabling

The tracker is enabled by default; the master switch lives in
**Settings → Tracker**. While it is off, no snapshots are generated and
nothing is injected into prompts. Chats, memory, and summaries are never
affected — turn the tracker back on whenever you want, and generation
resumes.

---

## Generating snapshots

| Auto mode | When a snapshot is generated | Where it attaches |
|---|---|---|
| **After reply** (default) | right after the model's reply completes — the snapshot reflects the latest exchange | the persisted reply's own swipe |
| **Before reply** | just before the next generation, so the freshest possible snapshot is in the prompt for that reply | the current tail's active message (the reply does not exist yet) |
| **After user message** | when you send the next message — the previous reply is tracked, so the snapshot reflects the exchange that turn left behind | the previous position's selected swipe (the new user turn is not part of the tracker prompt) |
| **Manual** | never automatically — you decide when | the current tail's active message |

Whatever the mode, the **generate action in the tracker panel** runs a
snapshot on demand, with the same settings the automatic modes use — handy
for refreshing after message edits or retrying a failed generation. It
attaches like `before_reply`: to the current tail's active message.

**`before_reply` and regenerate.** A regenerate streams a new swipe, but a
`before_reply` snapshot has no reply to attach to yet — it lands on the tail
it is about to replace (the swipe being regenerated). Once the new swipe is
active, that old swipe's tracker is no longer the selected one, so the panel
falls back to an older position or the empty state, even though the
just-generated snapshot was fed into the reply's prompt. Use **After reply**
(the default) if you want each swipe to own its tracker.

**`after_user_message` is the lazy cadence.** It produces the same snapshot
`after_reply` would have produced for the previous reply, but only once you
actually continue the conversation — the tracker prompt stops at that reply,
so the message you just sent is never part of it. Regenerating or swiping a
reply therefore costs no tracker calls: only the swipe you settle on gets
tracked, when you send the next message. A reply that already carries a
snapshot on its selected swipe is left alone, so retries and mode switches
never pay twice. In a plain one-reply-per-turn chat the number of calls
matches `after_reply`; the saving comes from discarded swipes,
regenerations, and replies you never continue. The trade-off is latency: the
tracker call runs before the reply is assembled so the fresh snapshot is
included in that prompt (unlike `after_reply`, which tracks after the reply).
The newest reply stays untracked until you send the next message.

---

## Connection profile

The tracker sends its generation requests to its **own connection
profile**, independent of the profile your chats use. Point it at a model
that is cheap and reliable at producing JSON while your roleplay model
stays on the good stuff. When no profile is set, the tracker falls back to
the **default profile**.

---

## Invisible mode

Invisible mode hides the tracker UI — the drawer tab disappears — while
the tracker keeps working: snapshots are still generated and still
injected. Use it when you want the continuity benefits without looking at
the panel. (Injection is stopped by the [enabled](#enabling-and-disabling)
switch or an injection count of `0`, never by invisible mode.)

---

## Generation indicator

While a snapshot is being generated — automatically in `after_reply`,
`before_reply`, or `after_user_message` mode, or from the panel's generate
action — a small status pill appears at the top of the chat, in the chat
header next to the streaming and summarizing pills. It uses the same `.pill` styling and
shows a label (`Tracking…` by default) with an optional pulsing dot. The
indicator is configured in **Settings → Chat**, separate from the tracker
config in **Settings → Tracker**:

| Setting | Default | Meaning |
|---|---|---|
| Show | on | master switch; off hides the pill completely |
| Label | `Tracking…` | pill text; empty shows the dot only (max 40 characters) |
| Pulsing dot | on | animate a small dot beside the label |

The indicator is a **display setting only** — it is stored with the app
settings, not in the tracker config, and never affects generation or
injection. Hiding it does not stop snapshots from being generated.

---

## Generation settings

All settings live in **Settings → Tracker** and are **global** — they
apply to every chat:

| Setting | Default | Meaning |
|---|---|---|
| Enabled | on | master switch for generation and injection |
| Mechanism | `suvoj-tracker` | which generation mechanism runs ([plugins](#plugin-mechanisms-and-tabs)) |
| Auto mode | After reply | when snapshots are generated ([modes](#generating-snapshots)) |
| Connection profile | Default | profile used for tracker calls ([above](#connection-profile)) |
| Message window | 0 (all) | how many recent messages are sent to the tracker |
| Previous trackers | 2 | how many earlier positions contribute selected-swipe snapshots to a generation |
| Retention | 2 | newest positions that carry a snapshot keep their selected-swipe trackers; older ones are pruned |
| Max response tokens | 8192 | response cap for the tracker call |
| System prompt | built-in | the tracker model's instructions |
| Invisible mode | off | hide the tracker UI while it keeps working |

Notes on the fiddly ones:

- **Message window** — `0` sends the whole chat; larger windows cost more
  tokens per snapshot but give the tracker more to work with.
- **Previous trackers** — each previous snapshot is drawn from the
  **selected swipe** of a position strictly before the target's; up to this
  many positions contribute (oldest → newest) so the scene evolves smoothly
  instead of resetting. The target's own position is never included, not
  even a sibling swipe's tracker.
- **Retention** — when a new snapshot is saved, the **newest tracker of each
  swipe row** is kept across this many newest chat positions **that carry a
  snapshot**; snapshots on older tracked positions are pruned, and unattached
  legacy rows (`message_id` empty) are removed. Only positions that actually
  have a snapshot count toward the window, so in the default `after_reply`
  mode `keep_last = 2` keeps the two most recent *tracked* positions — the
  previous turn's tracker survives instead of only the newest assistant
  reply's. A snapshot attached to a since-deleted message is invisible (its
  row is gone) and removed by the next prune — there is no FK cascade.
- **Max response tokens** — bounds the tracker reply; complex schemas or
  verbose models may need more, bigger caps cost more.
- **System prompt** — the built-in is scene-tracking instructions (copy
  unchanged fields verbatim, treat pronouns as facts, cap the off-stage list,
  record knowledge as a licence, never invent); the JSON-output rules come
  from the schema prompt the mechanism appends. Edit it freely;
  **reset to default** restores the built-in prompt if your edits go
  sideways.

---

## Prompt injection

The part that changes what the model sees. The built-in `tracker` pipeline
stage runs right **after the chat history** and renders the selected swipe's
newest snapshots — one per newest message position — into the prompt's
**state block**: transient text that sits after the live conversation and
the memory summary, immediately before the post-history instructions. It is
rendered into every subsequent request but never persisted as chat messages,
and it is never treated as trimmable history. Hidden sibling swipes are
never injected: a position contributes only the snapshot attached to its
`active` row.

Placing the block at the tail is deliberate. A stable prompt PREFIX (the
system prompt, the card, the lorebook, and the conversation so far) is what
providers reuse through prefix caching, and a long context's attention is
weakest in the middle — so the freshest scene state belongs at the end, not
interleaved with the canon.

| Setting | Default | Meaning |
|---|---|---|
| Count | 1 | how many of the newest **positions'** selected-swipe snapshots are injected, oldest → newest; **0 disables injection** |
| Role | `system` | role of the injected message: `user`, `assistant`, or `system` |
| Format | `Plain text` | how each snapshot is rendered: `Plain text` (the default) emits compact `key: value` lines plus a read-only guard and **no fence**; `JSON` is the opt-in fenced ` ```json ` form — byte-identical to what the tracker generator itself is asked to produce |
| Header | `Tracker:` | label line above the block; empty means no header |

With the defaults, the injected message looks like this — a message the
user never sees in the chat:

````text
Tracker:
Read-only reference state — never repeat, quote, or output this block in your reply, and never emit scene-state JSON in your response.
location: back room of the Gilded Boar, a low-ceilinged cellar beneath the taproom, Riverside district, Brindleport
characters:
  - Mira
    pronouns: she/her
    outfit: grey wool dress under a barkeep's apron, scuffed leather boots; plain cotton underthings
    posture: leaning on the bar, watching the stranger's hands; neat but tired
    wants: get the sealed crate off her premises before closing
    knows: the stranger arrived after midnight; Kael locked the cellar door
    voice: dry, clipped, swears like a sailor
  - the stranger
    pronouns: they/them
    outfit: rain-darkened travelling cloak over a charcoal doublet and muddy boots; a leather satchel across the chest
    posture: seated across the table, one hand on the satchel, guarding it
    wants: move the crate quietly tonight
    knows: Mira is lying about the crate; Kael owes them money
    voice: slow, careful, never finishes a sentence
offstage:
  - Kael
    pronouns: he/him
    doing: unloading barrels at the river dock
knownCast: Mira, Kael, the stranger
secrets:
  - Mira hid the sealed crate in the cellar
    knows: Mira
    suspects: Kael
    misled: the stranger
````

Set **Format** to `JSON` to inject the same snapshot as a fenced
` ```json ` block instead — the opt-in alternative shown below (here
rendered from the same data):

````text
Tracker:
```json
{
  "location": "back room of the Gilded Boar, a low-ceilinged cellar beneath the taproom, Riverside district, Brindleport",
  "characters": [
    {
      "name": "Mira",
      "pronouns": "she/her",
      "outfit": "grey wool dress under a barkeep's apron, scuffed leather boots; plain cotton underthings",
      "posture": "leaning on the bar, watching the stranger's hands; neat but tired",
      "wants": "get the sealed crate off her premises before closing",
      "knows": "the stranger arrived after midnight; Kael locked the cellar door",
      "voice": "dry, clipped, swears like a sailor"
    },
    {
      "name": "the stranger",
      "pronouns": "they/them",
      "outfit": "rain-darkened travelling cloak over a charcoal doublet and muddy boots; a leather satchel across the chest",
      "posture": "seated across the table, one hand on the satchel, guarding it",
      "wants": "move the crate quietly tonight",
      "knows": "Mira is lying about the crate; Kael owes them money",
      "voice": "slow, careful, never finishes a sentence"
    }
  ],
  "offstage": [
    { "name": "Kael", "pronouns": "he/him", "doing": "unloading barrels at the river dock" }
  ],
  "knownCast": ["Mira", "Kael", "the stranger"],
  "secrets": [
    {
      "fact": "Mira hid the sealed crate in the cellar",
      "knows": ["Mira"],
      "suspects": ["Kael"],
      "misled": ["the stranger"]
    }
  ]
}
```
````

**Format — plain text is the default; JSON is the opt-in fenced form.**
The default `Plain text` format renders each snapshot as compact
`key: value` lines with a read-only guard line and **no fence**. The guard
declares the block reference state the model must not reproduce, which is
why the default is far less likely to be echoed into a reply. Switch
**Format** to `JSON` to render the same snapshot as a fenced ` ```json `
block — byte-identical to the format the tracker generator itself is asked
to produce (the legacy behaviour, if you need that exact shape). Format
only changes the rendered text: placement, role, count, and the stored
snapshot JSON are untouched.

---

## Schema presets

A preset defines what a snapshot is and how it looks:

| Part | Role |
|---|---|
| **JSON schema** | the shape the tracker model must produce; the built-in mechanism includes it (plus a worked example generated from it) in the tracker prompt |
| **Generation requests** | how many parallel requests generate the schema, and which top-level field each request covers ([below](#splitting-a-schema-across-requests)) |
| **HTML template** | how the panel renders the snapshot JSON (syntax below) |
| **CSS** | scoped styling for the panel |

Presets are edited with **form** editors or **raw** editors — switch
between them as you like. The **live preview** renders the template with
sample data generated from the schema, so you can iterate on a preset
without spending a single tracker call.

One preset is **active**: its schema drives generation, its HTML and CSS
drive rendering.

### Splitting a schema across requests

A large schema with many top-level fields can overwhelm one reply — the
model has to produce everything at once, and one malformed field spoils the
whole snapshot. The **Generation requests** control in the preset editor
splits the work:

- Each **top-level field** is assigned to a request number. The same number
  groups fields together; a request with no fields is skipped.
- The requests run **in parallel** through the tracker's connection profile,
  so a split costs no more wall-clock than its slowest request — not the sum.
- The replies are **merged into one snapshot**, exactly as if a single call
  had produced the whole object.
- Failure is **atomic**: if any request fails, the whole snapshot fails and
  **nothing is saved** — retry from the panel's generate action.

The split applies to the built-in `suvoj-tracker` mechanism and to any plugin
mechanism that supports it (see [PLUGINS.md](./PLUGINS.md)); at most **8
requests** run per generation.

### Template syntax

The HTML template is rendered with the snapshot JSON as the data root, in
a tiny template language (shared with plugin drawer tabs —
[PLUGINS.md](./PLUGINS.md)):

- `{{path.to.value}}` — dot-path interpolation, HTML-escaped
- `{{{path}}}` — unescaped (use with care)
- `{{#each array}} ... {{/each}}` — iterate; inside use `{{this}}`,
  `{{this.field}}`, `{{@index}}`
- `{{#if path}} ... {{else}} ... {{/if}}` — truthiness check
- `{{join array ", "}}` — join an array of strings/numbers

The panel itself renders in a **sandboxed iframe**: no scripts run, and
`{{ }}` interpolations are escaped, so snapshot content can never inject
markup into the UI.

### Theme tokens

The panel follows the active theme — dark or light, built-in or
plugin-contributed. The frame injects these custom properties into the
iframe, each resolved from the theme's own colors, so a stylesheet can
theme itself instead of hardcoding:

| Token | Role |
|---|---|
| `--tf-card-bg`, `--tf-card-fg`, `--tf-card-border` | the card: surface, text, edge |
| `--tf-section-bg`, `--tf-section-border` | collapsible section wells and their hairlines |
| `--tf-label`, `--tf-section-name` | field labels and section headings |
| `--tf-scene-accent` | warm scene accent (section's left border) |
| `--tf-character-accent`, `--tf-character-name` | character card border and name |
| `--tf-topic-fg`, `--tf-topic-bg`, `--tf-topic-border` | topic pills |

Colors you write yourself still win over these tokens, so a preset with its
own palette keeps it under every theme.

---

## The built-in default preset

The tracker ships with the `default` preset:

- **Schema — SceneTracker**: `location`, `characters` (present: `name`,
  `pronouns`, `outfit`, `posture`, `wants`, `knows`, and an optional `voice`),
  `offstage` (up to five: `name`, `pronouns`, `doing`), `knownCast` (names
  only), and `secrets` (`fact`, `knows`, `suspects`, and optional `misled`).
- **Template**: a location + known-cast header, one collapsible card per
  present character (pronouns in the summary; outfit, posture, wants, knows
  and voice inside), a collapsible off-stage section, and one collapsible
  card per secret (the fact in the summary; knows/suspects/misled inside).
- **CSS**: a game-UI look that follows the active theme — the panel reads the
  theme's own colors (dark or light), so it repaints with every palette.

Duplicate it as a starting point for your own presets rather than editing
it in place — the active preset is a live setting.

---

## Drawer tabs

The chat drawer (the panel sliding in from the right of a chat) hosts the
tracker and summaries panels, plus any tabs your plugins contribute. Tabs
can be **reordered** and **hidden** — tuck away what you don't use. The
tracker tab sits **first** by default, before Summaries.

The tracker panel renders the snapshot attached to the **selected swipe**.
Switch to a sibling swipe and the panel refreshes to that swipe's own
tracker — a swipe that was never tracked shows the empty state, and the
generate action then targets the current tail's active message.

### Viewing a message's tracker

Hovering a message (or focusing its action row) reveals a tracker icon
**only when that swipe's row carries a snapshot** — the icon follows the row,
not the panel's current fallback. Clicking it opens a modal with that swipe's
own tracker.

The viewer reads the row directly (`GET /api/messages/:id/tracker`), so it
still works when the tracker's master switch is off, when the injection count
is `0`, or when the snapshot is older than the panel's two-position fallback
window — a persisted snapshot stays viewable. It is read-only: nothing in it
changes generation, injection, or retention.

### Deleting trackers

Two delete actions, with different scopes:

| Action | Scope |
|---|---|
| Panel trash icon (🗑) | deletes only the tracker attached to the **shown** message/swipe (`DELETE /api/messages/:id/tracker`) |
| **Clear all trackers** (bottom of the **Tracker** drawer tab) | deletes every tracker of the chat, across all messages and swipes (`DELETE /api/chats/:id/tracker`) |

The trash icon targets the selected swipe's row, so sibling swipes keep
their trackers. **Clear all trackers** sits at the bottom of the Tracker
tab and is available even when the selected swipe shows no tracker — the
other messages and swipes may still have trackers worth clearing.

Deleting messages drops those messages' snapshots with them — the panel
never shows a deleted message's tracker. The panel then shows the newest
snapshot attached to a **selected swipe**, which is exactly what the prompt
is fed: delete the trailing reply and the panel falls back to the previous
turn's tracker; undo several turns and it still shows the newest surviving
one, however many positions back that sits. It goes empty only when no
selected message carries a snapshot at all.

---

## Plugin mechanisms and tabs

- **Mechanisms** — plugins can register alternative tracker mechanisms:
  their own prompt building and response parsing, selectable in the
  mechanism setting next to the built-in `suvoj-tracker`.
- **Drawer tabs** — plugins can contribute additional drawer panels with
  their own data and templates.

Both are documented for plugin authors in [PLUGINS.md](./PLUGINS.md) —
see the "Tracker mechanisms" and "Chat drawer tabs" sections.

---

## Troubleshooting

**Snapshot generation fails with a 502 (parse failure).** The model's reply
didn't parse into a valid JSON object — nothing is saved. Usually
transient: retry with the panel's generate action. If it keeps happening,
simplify the schema, firm up the system prompt, or give the tracker more
room (message window / previous trackers / max response tokens).

**The model echoes the tracker JSON into its reply.** The default
`Plain text` format adds a read-only guard and no fence, which prevents
this. If you switched [Format](#prompt-injection) to `JSON` and the model
carries the fenced block over, switch it back to `Plain text`.

**The logs show a mechanism fallback warning.** The configured mechanism
is no longer registered — typically, its plugin got disabled. Re-enable
the plugin or switch the mechanism back to `suvoj-tracker`; until then the
built-in keeps the tracker running.

**The drawer shows no tracker tab.** Either invisible mode is on — the
tracker still runs and still influences replies; turn it off in the
tracker settings to bring the panel back — or the tab was hidden via the
drawer's tab management.

**Snapshots never update on their own.** If auto mode is **manual**,
generation only happens when you use the panel's generate action.

**A reply has no tracker until I send the next message.** Expected in
`after_user_message` mode: the previous reply is tracked when the
conversation advances, and the snapshot lands on its selected swipe.
Regenerating or swiping that reply costs nothing — only the swipe you settle
on is tracked, when you continue the chat.

**The card stays dark under a light theme.** What paints the panel is the
active preset's own CSS, and a stylesheet that hardcodes its colors beats the
theme's palette by source order. The shipped `default` preset is theme-aware
(it reads the frame's `--tf-*` tokens); installs that predate that get their
stored copy upgraded once at startup, and a preset you hand-edited is left
alone — restore it with **reset to default**, or read the `--tf-*` tokens in
your own stylesheet.

**The tracker empties after regenerating in `before_reply` mode.** Expected:
the snapshot attaches to the swipe the regenerate replaces, which is no
longer selected once the new swipe activates (see
[generating snapshots](#generating-snapshots)). Use **After reply** (the
default) to give each swipe its own tracker.

**The tracker changes — or empties — when you switch swipes.** That is
expected: the panel follows the selected swipe, and each swipe carries its
own tracker. The newly selected swipe shows the tracker attached to it, or
the empty state when it has none; switch back (or generate) to see the
other swipe's card.
