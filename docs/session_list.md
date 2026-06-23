# `session_list`

Lists sessions with optional filters for scope, timestamp floor, and title substring.

## Call

```text
session_list({ scope?, start?, search?, limit? })
```

## Arguments

- `scope` — `"local"` (default) or `"global"`
- `start` — Unix timestamp (ms) floor; only sessions updated at or after this time are included
- `search` — title substring filter (case-insensitive)
- `limit` — max sessions to return (default 20, max 100)

## Examples

```text
session_list({})

session_list({ scope: "global", limit: 50 })

session_list({ search: "CTF", scope: "global" })

session_list({ start: Date.now() - 86_400_000 })
```

## What it returns

- `scope` — the discovery scope used
- `sessions` — array of `SessionMetadata` sorted by most-recently-updated
- `total` — total matching sessions before the limit is applied

## See also

- `session_find` — exact title lookup returning ambiguity metadata
- `session_get` — metadata for a single known session ID
- `session_search` — full-text content search
