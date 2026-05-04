# `mc_job_pending_input`

Returns the detailed blocked permission or question payload for one tracked job.

## Call

```text
mc_job_pending_input({ jobId })
```

## Example

```text
mc_job_pending_input({ jobId: "job_123" })
```

## What it returns

- `jobId`
- `state`
- `pendingInput`

`pendingInput` is one of:

- permission details (`requestId`, `permission`, `patterns`, `always`, optional `reason`)
- question details (`requestId`, `questions`)

## Caveats

- This only succeeds when Mission Control has actionable blocked-input details for the job.
- Use `mc_job_status` first to confirm the job is blocked.
