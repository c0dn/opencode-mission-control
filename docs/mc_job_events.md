# `mc_job_events`

Returns the persisted event feed for one tracked background job.

## Call

```text
mc_job_events({ jobId, limit? })
```

## Arguments

- `jobId` — required job ID
- `limit` — optional maximum number of most-recent events to return

## Example

```text
mc_job_events({ jobId: "job_123", limit: 25 })
```

## What it returns

- `jobId`
- `events` — most-recent-first persisted job events

Events may include:

- lifecycle transitions such as `job.created`, `job.launched`, `session.idle`, and `job.relay_delivered`
- blocked-input events such as `permission.asked`, `question.asked`, `permission.replied`, and `question.rejected`
- child progress checkpoints recorded through `mc_job_update`

## Caveats

- This is Mission Control’s persisted job event store, not the full child transcript.
- The persisted feed is retained as a recent history window, not an unbounded forever-log.
- Persistence is still best-effort; if a sidecar write fails after a successful reply/progress action, the newest event may not survive an immediate restart.
- For the current job snapshot and any pending blocked input, use `mc_job_status`.
