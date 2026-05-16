# `mc_status`

Returns the current Mission Control runtime summary.

## Use it for

- confirming the plugin is loaded
- checking whether search is enabled
- checking whether semantic retrieval is available
- quick debugging of runtime config and counters
- seeing which search index snapshot is currently active

## Call

```text
mc_status()
```

## Output

The payload currently includes:

- `name`
- `startedAt`
- `directory`
- `implemented`
- `config`
- `counters`
- `capabilities`
- `index`

The `index` object includes fields such as:

- `path`
- `builtAt`
- `discoveryScope`
- `discoveryDirectory`
- `indexedSessionCount`
- `includeToolOutputsForIndexing`
- `semanticSignature`
- `dirtySessionCount`

## Caveats

- This is a runtime health and capability probe first; it does not return search matches.
- `dirtySessionCount` is scoped to the sessions in the current index snapshot, not every dirty session Mission Control has seen.
- If no search has been built yet, `builtAt`, `discoveryScope`, and `indexedSessionCount` may be absent until the first indexed search runs.
