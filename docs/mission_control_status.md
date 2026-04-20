# `mission_control_status`

Returns the current Mission Control runtime summary.

## Use it for

- confirming the plugin is loaded
- checking whether search/jobs are enabled
- checking whether semantic retrieval is available
- quick debugging of runtime config/counters
- seeing which search index snapshot is currently active

## Call

```text
mission_control_status()
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

The `index` object includes:

- `path`
- `builtAt`
- `discoveryScope`
- `discoveryDirectory`
- `indexedSessionCount`
- `includeToolOutputsForIndexing`
- `semanticSignature`
- `dirtySessionCount`

## Caveats

- It is still a runtime health/capability probe first; it does not return search matches.
- `dirtySessionCount` is scoped to the sessions in the current index snapshot, not every dirty session Mission Control has seen.
- If no search has been built yet, `builtAt`, `discoveryScope`, and `indexedSessionCount` may be absent until the first indexed search runs.
