# opencode-mission-control

OpenCode Mission Control adds session-aware retrieval and lightweight orchestration to OpenCode. It can read transcripts, inspect session trees, watch recent session activity, search indexed session content, and launch attached background jobs as child sessions under a parent session.

## Install

```bash
opencode plugin -g opencode-mission-control
```

## Tools

Detailed behavior and caveats live under `docs/`.

- [`runtime_model.md`](docs/runtime_model.md) — cross-cutting runtime behavior, lifecycle rules, persistence, and non-goals
- [`mc_status()`](docs/mc_status.md) — runtime health, config, counters, and capability probe
- [`mc_session_read({ sessionId, beforeMessageId?, limit?, withChildren?, withToolOutputs? })`](docs/mc_session_read.md) — read a transcript, optionally including child sessions and raw tool outputs
- [`mc_session_tree({ sessionId, depth? })`](docs/mc_session_tree.md) — inspect a session’s parent/child tree
- [`mc_session_events({ sessionId, withChildren?, limit? })`](docs/mc_session_events.md) — view recent live events and current status
- [`mc_session_search({ query, sessionId?, scope?, exact?, limit? })`](docs/mc_session_search.md) — search indexed session content; `scope: "global"` widens discovery and `exact: true` forces lexical matching
- [`mc_job_start({ prompt, sessionId?, title?, relay? })`](docs/mc_job_start.md) — launch an attached background child-session job
- [`mc_job_status({ jobId })`](docs/mc_job_status.md) — inspect one tracked job and its latest stable result if available
- [`mc_job_list({ sessionId?, state?, limit? })`](docs/mc_job_list.md) — list tracked jobs with optional filters
- [`mc_job_result({ jobId, sendToParent? })`](docs/mc_job_result.md) — fetch the latest stable result snapshot for a job and optionally relay it to the parent session
- [`mc_job_abort({ jobId })`](docs/mc_job_abort.md) — abort a running tracked job

## Common patterns

### Search sessions

```text
mc_session_search({ query: "retry logic", limit: 5 })

mc_session_search({
  query: "AmbiguousParentSession",
  scope: "global",
  exact: true,
  limit: 10,
})

mc_session_search({
  query: "relay failure",
  sessionId: "ses_123",
  limit: 10,
})
```

Use `mc_session_search` when you want indexed transcript content.

Use `mc_session_read` when you need exact transcript boundaries or raw tool outputs:

```text
mc_session_read({ sessionId: "ses_123", withToolOutputs: true })
```

### Start background jobs

```text
mc_job_start({
  prompt: "Summarize blockers in this session.",
  relay: "on_completion",
})

mc_job_start({
  sessionId: "ses_123",
  title: "Search audit",
  prompt: "Find mentions of global scope behavior.",
  relay: "manual",
})
```

### Choose a relay mode

- `manual` — store the result only; the parent can inspect it later or call `mc_job_result({ sendToParent: true })`
- `on_idle` — relay when the child settles after useful work; good for normal delegated research/check tasks
- `on_completion` — relay on idle, failure, or abort completion paths; good when the parent must always hear back

## Optional local skills

This plugin does **not** install native OpenCode skills automatically. `opencode plugin` installs the plugin package and updates config, but it does not copy `SKILL.md` files into `.opencode/skills/`.

If you want reusable local skills for your own workspace, the simplest path is to ask OpenCode to generate them from these docs:

- `@docs/mc_session_search.md`
- `@docs/mc_job_start.md`
- `@docs/mc_job_result.md`
- `@docs/runtime_model.md`

Example prompt:

```text
Create .opencode/skills/mission-control-search/SKILL.md and .opencode/skills/mission-control-jobs/SKILL.md from @docs/.

Use the Mission Control docs as the source of truth.
Include examples for:
- searching sessions
- starting background jobs
- when to use manual vs on_idle vs on_completion
```
