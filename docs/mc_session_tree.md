# `mc_session_tree`

Returns a session’s parent/child tree.

## Call

```text
mc_session_tree({ sessionId, depth? })
```

## Arguments

- `sessionId` — required session ID
- `depth` — optional tree depth; default is `1`

## Example

```text
mc_session_tree({ sessionId: "ses_123", depth: 2 })
```

## What it returns

A tree node containing:

- `sessionId`
- `title`
- `parentSessionId`
- `status`
- `children`

## Caveats

- Larger depths require more session lookups.
- This reflects the current session graph available through the OpenCode session API.
