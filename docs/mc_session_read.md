# `mc_session_read`

Reads a session transcript.

## Call

```text
mc_session_read({
  sessionId,
  beforeMessageId?,
  limit?,
  withChildren?,
  withToolOutputs?,
})
```

## Arguments

- `sessionId` — required session ID
- `beforeMessageId` — optional transcript boundary; only material strictly before that message is returned
- `limit` — optional cap on returned transcript entries
- `withChildren` — include child sessions in the returned transcript view
- `withToolOutputs` — include raw tool-output parts in the transcript

## Examples

```text
mc_session_read({ sessionId: "ses_123" })

mc_session_read({
  sessionId: "ses_123",
  beforeMessageId: "msg_42",
})

mc_session_read({
  sessionId: "ses_123",
  withChildren: true,
  limit: 50,
})

mc_session_read({
  sessionId: "ses_123",
  withToolOutputs: true,
})
```

## What it returns

A transcript result containing:

- the requested `sessionId`
- normalized transcript `entries`
- `includedChildSessionIds`

## Caveats

- Use this when you need exact transcript inspection or raw tool outputs. Search does not index tool outputs by default.
- `withChildren: true` merges child-session transcript content into one result.
- `beforeMessageId` is applied before transcript normalization/filtering, so it remains a hard boundary even if the boundary message itself would be hidden by `withToolOutputs: false`.
- `limit` is applied after the `beforeMessageId` boundary is enforced.
- If the session cannot be resolved or the runtime cannot load messages, the tool returns an error.
