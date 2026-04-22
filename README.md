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
- [`mc_job_start({ prompt, title? })`](docs/mc_job_start.md) — launch an attached background child-session job for the current session
- [`mc_job_status({ jobId })`](docs/mc_job_status.md) — inspect one tracked job and its latest stable result if available
- [`mc_job_events({ jobId, limit? })`](docs/mc_job_events.md) — inspect the persisted event feed for a job, including lifecycle changes and child progress updates
- [`mc_job_list({ sessionId?, state?, limit? })`](docs/mc_job_list.md) — list tracked jobs with optional filters
- [`mc_job_update({ jobId?, message, notifyParent? })`](docs/mc_job_update.md) — record a progress checkpoint from the child session running the background job
- [`mc_job_permission_reply({ jobId, reply, message? })`](docs/mc_job_permission_reply.md) — approve or reject a pending permission request that blocked a child job
- [`mc_job_question_reply({ jobId, answers })`](docs/mc_job_question_reply.md) — answer a pending question that blocked a child job
- [`mc_job_question_reject({ jobId })`](docs/mc_job_question_reject.md) — reject a pending question for a child job
- [`mc_job_result({ jobId, sendToParent? })`](docs/mc_job_result.md) — fetch the latest stable result snapshot for a job and optionally re-send it to the parent session
- [`mc_job_abort({ jobId })`](docs/mc_job_abort.md) — abort a running tracked job

## Common patterns

### Search sessions

```text
mc_session_search({ query: "retry logic", limit: 5 })

mc_session_search({
  query: "ParentSessionScopeUnavailable",
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
})

mc_job_start({
  title: "Search audit",
  prompt: "Find mentions of global scope behavior.",
})
```

When the current runtime supports parent relay, terminal job outcomes notify the parent automatically. Blocked permission/question input also notifies the parent automatically when Mission Control can resolve the active pending request, and sparse blocked-state fallbacks may send a generic notification before normalized request details are available.

### Handle blocked child jobs

When a child session hits a native permission or question request, Mission Control stores the pending input on the job when it can resolve the active request, relays a concise notification to the parent session, and lets the parent reply with job-scoped tools. If request details are not available yet, Mission Control can still send a generic blocked notification first.

```text
mc_job_status({ jobId: "job_123" })

mc_job_permission_reply({
  jobId: "job_123",
  reply: "once",
})

mc_job_question_reply({
  jobId: "job_123",
  answers: [["src/"]],
})
```

Reject a blocked question explicitly when needed:

```text
mc_job_question_reject({ jobId: "job_123" })
```

### Monitor child progress

Use the persisted job event feed to inspect lifecycle changes and periodic child progress checkpoints:

```text
mc_job_events({ jobId: "job_123", limit: 25 })
```

From the child session itself, publish a progress checkpoint without auto-relaying every note:

```text
mc_job_update({ message: "Finished scanning the last 4 files." })

mc_job_update({
  message: "Need parent attention before I continue.",
  notifyParent: true,
})
```

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
- how blocked parent replies and progress updates work
```
