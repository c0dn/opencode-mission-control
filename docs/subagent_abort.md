# `subagent_abort`

Requests cancellation of an OpenCode session by session ID. Primarily used to cancel background subagents.

## Call

```text
subagent_abort({ sessionId })
```

## Arguments

- `sessionId` — required OpenCode session ID to abort

## Example

```text
subagent_abort({ sessionId: "ses_subagent_123" })
```

## What it returns

- `ok: true` when the OpenCode abort request was accepted by the runtime client
- `data.sessionId` for the requested session
- `data.requestAccepted: true`
- `data.aborted` when OpenCode returns a boolean abort result
- `data.result` with any response returned by OpenCode, or `null`

## Caveats

- Calls OpenCode's public `POST /session/{sessionID}/abort` API.
- Works best for background subagents when you know the subagent session ID.
- Foreground subagents can block the parent tool loop, so the parent may not be able to call this until the foreground subagent returns.
- Mission Control does not mutate OpenCode storage directly; it only sends the public abort request.
