# `mission_control_session_read`

Reads a session transcript.

## Call

```text
mission_control_session_read(sessionID, beforeMessageID?, limit?, includeChildren?, includeToolOutputs?)
```

## Arguments

- `sessionID` — required session ID
- `beforeMessageID` — optional transcript boundary; only material strictly before that message is returned
- `limit` — optional cap on returned transcript entries
- `includeChildren` — include child sessions in the returned transcript view
- `includeToolOutputs` — include raw tool-output parts in the transcript

## Examples

```text
mission_control_session_read(sessionID="ses_123")
mission_control_session_read(sessionID="ses_123", beforeMessageID="msg_42")
mission_control_session_read(sessionID="ses_123", includeChildren=true, limit=50)
mission_control_session_read(sessionID="ses_123", includeToolOutputs=true)
```

## What it returns

A transcript result containing:

- the requested `sessionID`
- normalized transcript `entries`
- `includedChildSessionIDs`

## Caveats

- This is the tool to use when you want to inspect raw tool outputs. Search does not index tool outputs by default.
- `includeChildren=true` merges child-session transcript content into one result.
- `beforeMessageID` is applied before transcript normalization/filtering, so it remains a hard boundary even if the boundary message itself would be hidden by `includeToolOutputs=false`.
- `limit` is applied after the `beforeMessageID` boundary is enforced.
- If the session cannot be resolved or the runtime cannot load messages, the tool returns an error.
