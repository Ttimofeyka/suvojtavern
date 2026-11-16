# Theme Plugin

Reference plugin for the **appearance contributions** of the SuvojTavern
plugin API: custom `themes` and a global `globalCss` stylesheet. It adds two
palettes — **Evergreen** (dark) and **Blush** (light) — to Settings →
Appearance, plus a small selection-highlight stylesheet.

It ships disabled (like every newly discovered plugin). Enable it in
**Settings → Plugins**, then pick a theme in **Settings → Appearance**;
disabling it withdraws both palettes and the stylesheet.

The full contract — the 24 required tokens, the hex rule for the three
surface tokens, reserved ids, and the trust note on `globalCss` — lives in
[`docs/PLUGINS.md`](../../docs/PLUGINS.md#themes).
