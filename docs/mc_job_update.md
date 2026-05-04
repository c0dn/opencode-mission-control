# `mc_job_update`

Records a progress checkpoint from the child session running a background job.

## Call

```text
mc_job_update({ jobId?, message, notifyParent? })
```

## Arguments

- `jobId` — optional explicit job ID; if omitted, Mission Control infers the job from the caller child session
- `message` — required progress note
- `notifyParent` — when `true`, also relay this checkpoint to the parent session

## Examples

```text
mc_job_update({ message: "Finished scanning the last 4 files." })

mc_job_update({
  message: "Need the parent to look at this before I continue.",
  notifyParent: true,
})
```

## What it returns

- `jobId`
- updated compact `state`
- appended `eventId`

## Caveats

- This should normally be called from the background child session itself.
- Mission Control rejects progress updates that do not come from the tracked child session for the job.
- Progress updates do not create a stable result snapshot and do not finalize the job.
- `notifyParent` is opt-in so normal checkpoints stay in the event feed without spamming the parent session.
