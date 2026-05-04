# `mc_job_status`

Returns the current lifecycle state for one tracked background job.

## Call

```text
mc_job_status({ jobId })
```

## Example

```text
mc_job_status({ jobId: "job_123" })
```

## What it returns

- `job` — the compact current tracked job view
- `job.pendingKind` — whether the child is currently blocked on `permission` or `question`
- `job.hasResult` — whether a stable result snapshot is available through `mc_job_result`

Possible job states include:

- `queued`
- `launching`
- `running`
- `waiting_permission`
- `waiting_question`
- `idle`
- `completed`
- `failed`
- `aborted`
- `orphaned`

## Caveats

- This does not inline the stored result snapshot.
- Use `mc_job_pending_input` for full blocked permission/question details.
- Use `mc_job_result` for the stored terminal summary.
