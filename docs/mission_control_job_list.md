# `mission_control_job_list`

Lists tracked background jobs.

## Call

```text
mission_control_job_list(parentSessionID?, state?, limit?)
```

## Arguments

- `parentSessionID` — optional filter by parent session
- `state` — optional filter by job state
- `limit` — optional maximum number of jobs to return

## Example

```text
mission_control_job_list(parentSessionID="ses_123", state="running", limit=20)
```

## What it returns

A list of tracked jobs sorted by most recently updated first.

## Caveats

- This lists Mission Control’s tracked job store, not every child session in OpenCode.
