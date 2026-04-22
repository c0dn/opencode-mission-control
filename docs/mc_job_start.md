# `mc_job_start`

Starts a background job as an attached child session.

## Call

```text
mc_job_start({
  prompt,
  title?,
})
```

## Arguments

- `prompt` — task brief sent to the child session
- `title` — optional child session title; if omitted, Mission Control uses a generic default title

## Examples

```text
mc_job_start({
  prompt: "Summarize blockers in this session.",
})

mc_job_start({
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

- The public `mc_job_start` tool always attaches to the current caller session; it no longer accepts an explicit parent session override.
- If the current caller session cannot be resolved, job launch fails instead of guessing or falling back to another session in scope.
- Jobs are attached child sessions, not detached daemons.
- Job launch can fail if the concurrency limit is reached.
- Automatic parent notifications depend on the current runtime supporting parent relay.
- Native child permission/question requests are tracked as blocked job input and relayed back to the parent session as concise notifications.
