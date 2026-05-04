# `mc_job_list`

Lists tracked background jobs.

## Call

```text
mc_job_list({ sessionId?, state?, limit? })
```

## Arguments

- `sessionId` — optional filter by parent session
- `state` — optional filter by job state
- `limit` — optional maximum number of jobs to return

## Example

```text
mc_job_list({ sessionId: "ses_123", state: "running", limit: 20 })
```

## What it returns

A list of compact tracked job cards sorted by most recently updated first.

Each card includes:

- `jobId`
- `title`
- `state`
- optional `childSessionId`
- optional `pendingKind`
- optional `failureReason`
- `hasResult`

## Caveats

- This lists Mission Control’s tracked job store, not every child session in OpenCode.
