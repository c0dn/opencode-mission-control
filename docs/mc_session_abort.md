# `mc_session_abort`

Requests cancellation of an OpenCode session by session ID.

## Call

```text
mc_session_abort({ sessionId })
```

## Arguments

- `sessionId` — required OpenCode session ID to abort

## Example

```text
mc_session_abort({
  sessionId: "ses_subagent_123",
})
```

## What it returns

- `ok: true` when the OpenCode abort request was accepted by the runtime client
- `data.sessionId` for the requested session
- `data.requestAccepted: true`
- `data.aborted` when OpenCode returns a boolean abort result
- `data.result` with any response returned by OpenCode, or `null`

## Caveats

- This calls OpenCode's public `POST /session/{sessionID}/abort` API.
- It works best for background subagents when you know the subagent session ID.
- Foreground subagents can block the parent tool loop, so the parent may be unable to call this tool until the foreground subagent returns.
- Mission Control does not mutate OpenCode storage directly; it only sends the public abort request.
