# `mc_job_permission_reply`

Approves or rejects a pending permission request that blocked a child background job.

## Call

```text
mc_job_permission_reply({ jobId, reply, message? })
```

## Arguments

- `jobId` — required job ID
- `reply` — one of:
  - `once`
  - `always`
  - `reject`
- `message` — optional note sent with the permission reply

## Example

```text
mc_job_permission_reply({ jobId: "job_123", reply: "once" })

mc_job_permission_reply({
  jobId: "job_123",
  reply: "reject",
  message: "Do not run that command.",
})
```

## What it returns

The updated tracked `job` record.

## Caveats

- This only works when `mc_job_status` shows `job.pendingInput.kind === "permission"`.
- This must be called from the parent session that launched the job.
- Mission Control replies through the native OpenCode permission API; it does not fake the reply with transcript text.
