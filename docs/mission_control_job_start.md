# `mission_control_job_start`

Starts a background job as an attached child session.

## Call

```text
mission_control_job_start(title, prompt, parentSessionID?, attach?, relayToParent?)
```

## Arguments

- `title` — child session title / job label
- `prompt` — task brief sent to the child session
- `parentSessionID` — optional explicit parent session to attach to
- `attach` — `auto` allows Mission Control to use the current tool session, then the latest root session in scope if fallback is enabled
- `relayToParent` — one of:
  - `never`
  - `on_idle`
  - `on_completion`
  - `manual_only`

## Example

```text
mission_control_job_start(
  title="Review challenge writeup",
  prompt="Summarize the writeup and list blockers.",
  parentSessionID="ses_123",
  relayToParent="on_completion"
)

mission_control_job_start(
  title="Background audit",
  prompt="Inspect the current session and summarize issues.",
  attach="auto"
)
```

## What it returns

- `jobID`
- `parentSessionID`
- `childSessionID`
- initial job `state`

## Caveats

- A blank `parentSessionID` is rejected.
- `attach="auto"` still depends on the caller session context exposed by the tool runtime.
- If the current session cannot be resolved and latest-session fallback is disabled, job launch fails instead of guessing.
- If more than one plausible fallback root session exists in scope, job launch fails with `AmbiguousParentSession` instead of picking one automatically.
- Jobs are attached child sessions, not detached daemons.
- Job launch can fail if the concurrency limit is reached.
