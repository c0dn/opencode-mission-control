# `mission_control_session_observe`

Returns recent operational events and current status for a session.

## Call

```text
mission_control_session_observe(sessionID, includeChildren?, eventLimit?)
```

## Arguments

- `sessionID` — required session ID
- `includeChildren` — include child-session status and events
- `eventLimit` — maximum number of recent events to return

## Example

```text
mission_control_session_observe(sessionID="ses_123", includeChildren=true, eventLimit=25)
```

## What it returns

- current `status` for the requested session
- `recentEvents` seen by Mission Control
- optional child-session summaries when `includeChildren=true`

## Caveats

- This is a live/recent view backed by the in-memory event buffer.
- It is not a full historical audit log.
- Events are only available if the current Mission Control runtime observed them.
