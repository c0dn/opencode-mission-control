# `session_search_global`

Searches session transcripts across all projects globally using hybrid semantic + lexical retrieval. Requires a Jina API key to be configured.

## Call

```text
session_search_global({ query, limit? })
```

## Arguments

- `query` — required search string
- `limit` — cap the number of returned matches (default 10, max 50)

## Examples

```text
session_search_global({ query: "authentication bug fix" })

session_search_global({ query: "deploy pipeline", limit: 10 })
```

## How it works

Same as `session_search` but discovers sessions across all projects rather than only the current directory.

- Switches discovery to global unscoped mode.
- Uses a separate cache file so global and local indexes do not overwrite each other.

## See also

- `session_search` — same but scoped to the current project
- `session_list` — browse sessions with filters
