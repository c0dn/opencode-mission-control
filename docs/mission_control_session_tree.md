# `mission_control_session_tree`

Returns a session’s parent/child tree.

## Call

```text
mission_control_session_tree(sessionID, depth?)
```

## Arguments

- `sessionID` — required session ID
- `depth` — optional tree depth; default is `1`

## Example

```text
mission_control_session_tree(sessionID="ses_123", depth=2)
```

## What it returns

A tree node containing:

- `sessionID`
- `title`
- `parentSessionID`
- `status`
- `children`

## Caveats

- Larger depths require more session lookups.
- This reflects the current session graph available through the OpenCode session API.
