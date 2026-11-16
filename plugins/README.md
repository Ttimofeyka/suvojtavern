# plugins/

Server-side plugins live here — **one folder per plugin**, with an
`index.ts` entry that exports a `definePlugin(...)` result from
`@suvoj/plugin-sdk`:

```
plugins/
  example-plugin/   ← the annotated walkthrough plugin
    index.ts
```

Drop a new folder in (or delete one), then press **Reload** in
Settings → Plugins — no server restart needed. Newly discovered plugins
start disabled — nothing runs until you enable them; toggle and configure
them from the same screen.

The full SDK reference — hooks, settings, memory strategies, pipeline
stages, UI contributions, and the example walkthrough — lives in
[`docs/PLUGINS.md`](../docs/PLUGINS.md).
