# `mc_job_question_reject`

Rejects a pending question request for a blocked child background job.

## Call

```text
mc_job_question_reject({ jobId })
```

## Example

```text
mc_job_question_reject({ jobId: "job_123" })
```

## What it returns

A compact acknowledgement containing the updated job state.

## Caveats

- This only works when `mc_job_status` shows `job.pendingKind === "question"` and `mc_job_pending_input` returns the question details.
- This must be called from the parent session that launched the job.
- Rejecting the question moves the job to a failed terminal path.
