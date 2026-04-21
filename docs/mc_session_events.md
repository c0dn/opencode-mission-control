# `mc_session_events`

Returns recent operational events and current status for a session.

## Call

```text
mc_session_events({ sessionId, withChildren?, limit? })
```

## Arguments

- `sessionId` — required session ID
- `withChildren` — include child-session status and events
- `limit` — maximum number of recent events to return

## Example

```text
mc_session_events({
  sessionId: "ses_123",
  withChildren: true,
  limit: 25,
})
```

## What it returns

- current `status` for the requested session
- `recentEvents` seen by Mission Control
- optional child-session summaries when `withChildren: true`

## Caveats

- This is a live and recent view backed by the in-memory event buffer.
- It is not a full historical audit log.
- Events are only available if the current Mission Control runtime observed them.
