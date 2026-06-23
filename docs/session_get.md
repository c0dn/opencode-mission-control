# `session_get`

Returns normalized metadata for one session ID.

## Call

```text
session_get({ sessionId })
```

## Arguments

- `sessionId` — required OpenCode session ID

## Example

```text
session_get({ sessionId: "ses_123" })
```

## Behavior

- Looks up a single session by ID.
- Returns normalized session metadata: ID, title, timestamps, parent/child linkage, directory.
- Does **not** return transcript messages or tool outputs.

Use `session_read` or `session_tail` when you need transcript content.
