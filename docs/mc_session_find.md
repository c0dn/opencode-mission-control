# `mc_session_find`

Finds sessions by exact title and returns normalized metadata candidates.

## Call

```text
mc_session_find({
  title,
  scope?,
  limit?,
})
```

## Arguments

- `title` — required exact session title to match
- `scope` — discovery scope: `"local"` (default) or `"global"`
- `limit` — cap the number of returned candidates

## Examples

```text
mc_session_find({ title: "Search audit", limit: 5 })

mc_session_find({
  title: "Search audit",
  scope: "global",
  limit: 10,
})
```

## Behavior

- Performs exact title lookup only; it is not transcript/content search.
- Returns normalized metadata candidates such as ID, title, timestamps, parent/child linkage, and directory/scope information when available.
- Exact titles can be ambiguous because multiple sessions may share the same title. Treat results as candidates and choose by metadata such as timestamp, directory, or parent/child relationship.
- Does **not** return transcript messages or tool outputs.

Use `mc_session_search` for indexed transcript content, and `mc_session_read` or `mc_session_tail` for transcript retrieval.
