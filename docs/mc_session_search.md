# `mc_session_search`

Searches indexed session content.

## Call

```text
mc_session_search({
  query,
  scope?,
  exact?,
  limit?,
})
```

## Arguments

- `query` — required search string
- `scope` — search discovery scope: `"local"` (default) or `"global"`
- `exact` — when `true`, force lexical matching
- `limit` — cap the number of returned matches

## Examples

```text
mc_session_search({ query: "retry logic", limit: 5 })

mc_session_search({
  query: "SessionLookupUnavailable",
  scope: "global",
  exact: true,
  limit: 10,
})

mc_session_search({
  query: "relay failure",
  limit: 10,
})
```

## How it works

- The index is built or refreshed on demand when you call this tool.
- Default search scope is the current directory.
- `scope: "global"` switches discovery to global and unscoped mode.
- Mission Control persists per-session indexing checkpoints so unchanged sessions can usually be reused instead of re-read on every stale rebuild.
- Message-level invalidations are also persisted, so a session marked dirty before restart can still be rebuilt on the next search even if its `updatedAt` timestamp did not move.
- Results include metadata such as:
  - `effectiveMode`
  - `discoveryScope`
  - `discoveryWorkspaceID` when indexed from an ambient workspace
  - `indexedSessionCount`
  - `indexPath`
- Each match includes `matchType`, so callers can distinguish an exact lexical hit from a ranked candidate.

## Search behavior

- `mc_session_search` searches indexed content only. It does not perform title-only lookup; use `mc_session_find` for exact title lookup.
- `exact: true` forces lexical search.
- If `exact: true` finds only ranked lexical candidates and no exact lexical hits, Mission Control warns about that instead of pretending the result set is exact.
- Without `exact: true`, Mission Control uses hybrid retrieval automatically when a Jina semantic provider/API key is configured and available; otherwise it falls back to lexical search.
- Lexical retrieval uses SQLite FTS5/BM25 as the primary source.
- Hybrid retrieval fuses lexical and semantic ranked candidates with reciprocal rank fusion (RRF).
- Native vector-table support (`vec1` / `sqlite-vec`) is best-effort. If extension-backed vector queries are unavailable or fail, Mission Control falls back to blob-scan vector retrieval so search keeps working.
- When semantic search is active, Mission Control caches chunk embeddings and recent query embeddings in the scope-specific SQLite search cache so repeated hybrid searches can avoid unnecessary embeddings API calls.

## When to use read instead

Tool outputs are **not indexed by default**. That keeps the cache smaller and avoids persisting a lot of noisy or sensitive output.

If you need raw tool outputs from a session, use:

```text
mc_session_read({ sessionId: "ses_123", offset: 0, limit: 25, withToolOutputs: true })
```

## Cache location

By default, the search cache is stored under:

```text
~/.cache/opencode-mission-control/<scope-hash>/search-index.current_directory.sqlite3
~/.cache/opencode-mission-control/<scope-hash>/search-index.global_unscoped.sqlite3
```

Current-directory and global discovery use separate cache files so they do not overwrite each other’s session snapshots, FTS data, or semantic vectors.

When an ambient workspace ID is present, Mission Control also partitions the cache by workspace key. Configured SQLite paths receive a `.workspace-<key>` suffix before any global scope suffix.

## Caveats

- This tool indexes data exposed by the OpenCode session API, not every row in `opencode.db`.
- `scope: "global"` still depends on what the session API returns.
- The cache is reused until Mission Control decides it is stale and rebuilds it.
- Legacy JSON search-index sidecars may be imported when present, but the active cache is SQLite-backed.
