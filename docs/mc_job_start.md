# `mc_job_start`

Starts a background job as an attached child session.

## Call

```text
mc_job_start({
  prompt,
  sessionId?,
  title?,
  relay?,
})
```

## Arguments

- `prompt` — task brief sent to the child session
- `sessionId` — optional explicit parent session to attach to; if omitted, Mission Control tries the caller session first
- `title` — optional child session title; if omitted, Mission Control uses a generic default title
- `relay` — one of:
  - `manual`
  - `on_idle`
  - `on_completion`

## Examples

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

## Relay mode guide

- `manual` — store the result only; good when the parent will inspect status later or manually send the result
- `on_idle` — relay when the child settles after useful work; good for normal delegated research and audit tasks
- `on_completion` — relay on idle, failure, or abort completion paths; good when the parent must always hear back

## What it returns

- `jobId`
- `sessionId` — the resolved parent session
- `childSessionId`
- initial job `state`

## Caveats

- A blank `sessionId` is rejected.
- If the caller session cannot be resolved and latest-session fallback is disabled, job launch fails instead of guessing.
- If more than one plausible fallback root session exists in scope, job launch fails with `AmbiguousParentSession` instead of picking one automatically.
- Jobs are attached child sessions, not detached daemons.
- Job launch can fail if the concurrency limit is reached.
