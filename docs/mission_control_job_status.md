# `mission_control_job_status`

Returns the current lifecycle state for one tracked background job.

## Call

```text
mission_control_job_status(jobID)
```

## Example

```text
mission_control_job_status(jobID="job_123")
```

## What it returns

- `job` — the current tracked job record
- `result` — optional stable result snapshot if one exists

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

- `result` is only present after Mission Control captured a stable snapshot.
