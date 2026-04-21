# `mc_job_abort`

Cancels a tracked job and aborts its child session if it is still active.

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
- Aborting a tracked job marks it as `aborted` and stores an aborted result snapshot.
