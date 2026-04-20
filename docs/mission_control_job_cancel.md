# `mission_control_job_cancel`

Cancels a tracked job and aborts its child session if it is still active.

## Call

```text
mission_control_job_cancel(jobID)
```

## Example

```text
mission_control_job_cancel(jobID="job_123")
```

## Caveats

- Closed jobs cannot be cancelled again.
- Cancelling a tracked job marks it as `aborted` and stores an aborted result snapshot.
