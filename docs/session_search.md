# `session_search`

Searches session transcripts in the current project/directory using hybrid semantic + lexical retrieval. Requires a Jina API key to be configured.

## Call

```text
session_search({ query, limit? })
```

## Arguments

- `query` — required search string
- `limit` — cap the number of returned matches (default 10, max 50)

## Examples

```text
session_search({ query: "retry logic", limit: 5 })

session_search({ query: "SessionLookupUnavailable" })
```

## How it works

- Always uses hybrid retrieval: lexical (FTS5/BM25) + semantic (Jina embeddings) fused with reciprocal rank fusion (RRF).
- The index is built or refreshed on demand.
- Per-session indexing checkpoints mean unchanged sessions are reused rather than re-read on every rebuild.
- Results include `effectiveMode`, `discoveryScope`, `indexedSessionCount`, and `indexPath`.

## When to use read instead

Tool outputs are **not indexed by default**. To read raw tool output from a session use:

```text
session_read({ sessionId: "ses_123", withToolOutputs: true })
```

## See also

- `session_search_global` — same but searches all projects globally
- `session_find` — exact title lookup
- `session_tail` — latest messages from a known session
- `session_read` — full transcript inspection

## Cache location

```text
~/.cache/opencode-mission-control/<scope-hash>/search-index.current_directory.sqlite3
```
