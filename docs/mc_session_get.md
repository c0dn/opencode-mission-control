# `mc_session_get`

Returns normalized metadata for one session ID.

## Call

```text
mc_session_get({
  sessionId,
})
```

## Arguments

- `sessionId` — required OpenCode session ID

## Example

```text
mc_session_get({ sessionId: "ses_123" })
```

## Behavior

- Looks up a single session by ID within the session data exposed to Mission Control.
- Returns normalized session metadata such as ID, title, timestamps, parent/child linkage, and directory/scope information when available.
- Does **not** return transcript messages or tool outputs.

Use `mc_session_read` or `mc_session_tail` when you need transcript content.
