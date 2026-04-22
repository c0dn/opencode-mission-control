# `mc_job_start`

Starts a background job as an attached child session.

## Call

```text
mc_job_start({
  prompt,
  sessionId?,
  title?,
})
```

## Arguments

- `prompt` — task brief sent to the child session
- `sessionId` — optional explicit parent session to attach to; if omitted, Mission Control tries the caller session first
- `title` — optional child session title; if omitted, Mission Control uses a generic default title

## Examples

```text
mc_job_start({
  prompt: "Summarize blockers in this session.",
})

mc_job_start({
  sessionId: "ses_123",
  title: "Search audit",
  prompt: "Find mentions of global scope behavior.",
})
```

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
- Automatic parent notifications depend on the current runtime supporting parent relay.
- Native child permission/question requests are tracked as blocked job input and relayed back to the parent session as concise notifications.
