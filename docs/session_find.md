# `session_find`

Finds sessions by exact title and returns normalized metadata candidates.

## Call

```text
session_find({ title, scope?, limit? })
```

## Arguments

- `title` — required exact session title to match
- `scope` — discovery scope: `"local"` (default) or `"global"`
- `limit` — cap the number of returned candidates

## Examples

```text
session_find({ title: "Search audit", limit: 5 })

session_find({ title: "Search audit", scope: "global", limit: 10 })
```

## Behavior

- Exact title lookup only — not transcript/content search.
- Returns normalized metadata candidates: ID, title, timestamps, parent/child linkage, directory.
- Titles can be ambiguous; treat results as candidates and select by metadata (timestamp, directory, parentSessionId).
- Does **not** return transcript messages or tool outputs.

Use `session_search` for indexed transcript content, or `session_read` / `session_tail` for transcript retrieval.
