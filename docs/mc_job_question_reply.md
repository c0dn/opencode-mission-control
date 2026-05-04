# `mc_job_question_reply`

Answers a pending question request that blocked a child background job.

## Call

```text
mc_job_question_reply({ jobId, answers })
```

## Arguments

- `jobId` — required job ID
- `answers` — answers in question order; each answer is an array of selected labels

## Example

```text
mc_job_question_reply({
  jobId: "job_123",
  answers: [["src/"], ["tests/"]],
})
```

## What it returns

A compact acknowledgement containing the updated job state.

## Caveats

- This only works when `mc_job_status` shows `job.pendingKind === "question"` and `mc_job_pending_input` returns the question details.
- This must be called from the parent session that launched the job.
- Match the labels from the pending question options when selecting answers.
