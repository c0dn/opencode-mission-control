# opencode-mission-control

OpenCode Mission Control adds session-aware retrieval and inspection to OpenCode. It can read transcripts, inspect session trees, watch recent session activity, and search indexed session content.

## Install

```bash
opencode plugin -g opencode-mission-control
```

## Tools

Detailed behavior and caveats live under `docs/`.

- [`runtime_model.md`](docs/runtime_model.md) — cross-cutting runtime behavior, lifecycle rules, persistence, and non-goals
- [`mc_status()`](docs/mc_status.md) — runtime health, config, counters, and capability probe
- [`mc_session_read({ sessionId, beforeMessageId?, limit?, withChildren?, withToolOutputs? })`](docs/mc_session_read.md) — read a transcript, optionally including child sessions and raw tool outputs
- [`mc_session_get({ sessionId })`](docs/mc_session_get.md) — get normalized metadata for one session ID
- [`mc_session_find({ title, scope?, limit? })`](docs/mc_session_find.md) — find exact-title metadata candidates; titles can be ambiguous
- [`mc_session_tail({ sessionId, offset?, limit?, withChildren? })`](docs/mc_session_tail.md) — view recent text-only messages
- [`mc_session_tree({ sessionId, depth? })`](docs/mc_session_tree.md) — inspect a session’s parent/child tree
- [`mc_session_abort({ sessionId })`](docs/mc_session_abort.md) — request cancellation of a session, primarily background subagents by subagent session ID
- [`mc_session_events({ sessionId, withChildren?, limit? })`](docs/mc_session_events.md) — view recent live events and current status
- [`mc_session_search({ query, scope?, exact?, limit? })`](docs/mc_session_search.md) — search indexed session content; `scope: "global"` widens discovery and `exact: true` forces lexical matching

## Common patterns

### Search sessions

```text
mc_session_search({ query: "retry logic", limit: 5 })

mc_session_search({
  query: "SessionLookupUnavailable",
  scope: "global",
  exact: true,
  limit: 10,
})
```

Use `mc_session_search` when you want indexed transcript content. Search is content-only; use `mc_session_find` for exact title lookup and `mc_session_get` when you already have a session ID.

Semantic/hybrid search is automatic when a Jina semantic provider/API key is configured and available. Otherwise search falls back to SQLite FTS/BM25 lexical retrieval; `exact: true` always uses lexical retrieval.

### Look up and read sessions

Exact title lookup can return multiple candidates because titles are not unique:

```text
mc_session_find({ title: "Search audit", limit: 5 })

mc_session_get({ sessionId: "ses_123" })
```

Use `mc_session_read` when you need exact transcript boundaries or raw tool outputs:

```text
mc_session_read({ sessionId: "ses_123", withToolOutputs: true })
```

Use `mc_session_tail` for a compact latest-message view:

```text
mc_session_tail({ sessionId: "ses_123", limit: 10 })
```

### Observe session activity

```text
mc_session_events({ sessionId: "ses_123", withChildren: true, limit: 25 })

mc_session_tree({ sessionId: "ses_123", depth: 2 })
```

## Optional local skills

This plugin does **not** install native OpenCode skills automatically. `opencode plugin` installs the plugin package and updates config, but it does not copy `SKILL.md` files into `.opencode/skills/`.

If you want reusable local skills for your own workspace, the simplest path is to ask OpenCode to generate them from these docs:

- `@docs/mc_session_search.md`
- `@docs/mc_session_get.md`
- `@docs/mc_session_find.md`
- `@docs/mc_session_read.md`
- `@docs/runtime_model.md`

Example prompt:

```text
Create .opencode/skills/mission-control-search/SKILL.md from @docs/.

Use the Mission Control docs as the source of truth.
Include examples for searching sessions, looking up sessions by ID or exact title, reading transcripts, and checking recent session events.
```
