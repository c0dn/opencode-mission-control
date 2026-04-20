# `mission_control_job_result`

Returns the latest stable result snapshot for a tracked job.

## Call

```text
mission_control_job_result(jobID, relayToParent?)
```

## Arguments

- `jobID` — required job ID
- `relayToParent` — when `true`, also relay the stored result to the parent session

## Example

```text
mission_control_job_result(jobID="job_123")
mission_control_job_result(jobID="job_123", relayToParent=true)
```

## What it returns

A stable result snapshot containing:

- `headline`
- `summary`
- `blockers`
- `keyMessageIDs`
- `state`
- `observedAt`

## Caveats

- This only succeeds after the job reaches a stable state such as `idle`, `completed`, `failed`, or `aborted`.
- `relayToParent=true` can fail if the job was configured with `relayMode="never"`.
- If a transcript cannot be captured during finalization, Mission Control falls back to a best-effort result snapshot.
