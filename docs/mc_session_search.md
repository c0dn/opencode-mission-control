# `mc_session_search`

Searches indexed session content.

## Call

```text
mc_session_search({
  query,
  sessionId?,
  scope?,
  exact?,
  limit?,
})
```

## Arguments

- `query` — required search string
- `sessionId` — optional session scope; when set, search is narrowed to that session subtree
- `scope` — search discovery scope: `"local"` (default) or `"global"`
- `exact` — when `true`, force lexical matching
- `limit` — cap the number of returned matches

## Examples

```text
mc_session_search({ query: "retry logic", limit: 5 })

mc_session_search({
  query: "ParentSessionScopeUnavailable",
  scope: "global",
  exact: true,
  limit: 10,
})

mc_session_search({
  query: "relay failure",
  sessionId: "ses_123",
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
  - `requestedMode`
  - `effectiveMode`
  - `discoveryScope`
  - `indexedSessionCount`
  - `indexPath`
- Each match includes `matchType`, so callers can distinguish an exact lexical hit from a ranked candidate.

## Search behavior

- `exact: true` forces lexical search.
- If `exact: true` finds only ranked lexical candidates and no exact lexical hits, Mission Control warns about that instead of pretending the result set is exact.
- Without `exact: true`, Mission Control auto-selects lexical search for obvious exact queries such as acronyms, quoted phrases, and path-like tokens.
- Semantic search is optional. If it is not configured or available, search falls back to lexical mode.
- When semantic search is active, Mission Control caches chunk embeddings and recent query embeddings inside the scope-specific search cache so repeated semantic or hybrid searches can avoid unnecessary embeddings API calls.

## When to use read instead

Tool outputs are **not indexed by default**. That keeps the cache smaller and avoids persisting a lot of noisy or sensitive output.

If you need raw tool outputs from a session, use:

```text
mc_session_read({ sessionId: "ses_123", offset: 0, limit: 25, withToolOutputs: true })
```

## Cache location

By default, the search cache is stored under:

```text
~/.cache/opencode-mission-control/<scope-hash>/search-index.current_directory.json
~/.cache/opencode-mission-control/<scope-hash>/search-index.global_unscoped.json
```

Current-directory and global discovery use separate cache files so they do not overwrite each other’s session snapshots or semantic vectors.

## Caveats

- This tool indexes data exposed by the OpenCode session API, not every row in `opencode.db`.
- `scope: "global"` still depends on what the session API returns.
- The cache is reused until Mission Control decides it is stale and rebuilds it.
