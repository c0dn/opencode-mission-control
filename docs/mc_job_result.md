# `mc_job_result`

Returns the latest stable result snapshot for a tracked job.

## Call

```text
mc_job_result({ jobId, sendToParent? })
```

## Arguments

- `jobId` — required job ID
- `sendToParent` — when `true`, re-send the stored result to the parent session that launched the job

## Example

```text
mc_job_result({ jobId: "job_123" })

mc_job_result({
  jobId: "job_123",
  sendToParent: true,
})
```

## What it returns

A stable result snapshot containing:

- `headline`
- `summary`
- `blockers`
- `recommendedNextStep` when the child session reported one
- `state`

## Caveats

- This only succeeds after the job reaches a stable state such as `idle`, `completed`, `failed`, or `aborted`.
- If Mission Control already captured a stable snapshot before a later restart or orphaning event, that stored snapshot can still be returned.
- `sendToParent: true` re-sends the stored result to the parent session. Use it when you need to repeat a result notification explicitly.
- `sendToParent: true` must be called from the parent session that launched the job.
- If a transcript cannot be captured during finalization, Mission Control falls back to a best-effort result snapshot.
