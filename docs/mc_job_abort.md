# `mc_job_abort`

Cancels a tracked job and aborts its child session if the job has not already reached a closed terminal state.

## Call

```text
mc_job_abort({ jobId })
```

## Example

```text
mc_job_abort({ jobId: "job_123" })
```

## Caveats

- Closed jobs cannot be aborted again.
- This must be called from the parent session that launched the job.
- Aborting a tracked job marks it as `aborted` and stores an aborted result snapshot.
