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

The updated tracked `job` record.

## Caveats

- This only works when `mc_job_status` shows `job.pendingInput.kind === "question"`.
- This must be called from the parent session that launched the job.
- Rejecting the question moves the job to a failed terminal path.
