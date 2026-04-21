# `mission_control_session_search`

Searches indexed session content.

## Call

```text
mission_control_session_search(query, sessionID?, global?, exact?, limit?)
```

## Arguments

- `query` — required search string
- `sessionID` — optional session scope; when set, search is narrowed to that session subtree
- `global` — when `true`, use global session discovery instead of current-directory scope
- `exact` — when `true`, force lexical matching
- `limit` — cap the number of returned matches

## Examples

```text
mission_control_session_search(query="CTF")
mission_control_session_search(query="CTF", global=true, limit=50)
mission_control_session_search(query="HTX", exact=true)
mission_control_session_search(query="flag leak", sessionID="ses_123")
```

## How it works

- The index is built or refreshed on demand when you call this tool.
- Default search scope is the current directory.
- `global=true` switches discovery to global/unscoped mode.
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

- `exact=true` forces lexical search.
- If `exact=true` finds only ranked lexical candidates and no exact lexical hits, Mission Control warns about that instead of pretending the result set is exact.
- Without `exact=true`, Mission Control auto-selects lexical search for obvious exact queries such as acronyms, quoted phrases, and path-like tokens.
- Semantic search is optional. If it is not configured or available, search falls back to lexical mode.
- When semantic search is active, Mission Control caches chunk embeddings and recent query embeddings inside the scope-specific search cache so repeated semantic/hybrid searches can avoid unnecessary embeddings API calls.

## Tool-output caveat

Tool outputs are **not indexed by default**. That keeps the cache smaller and avoids persisting a lot of noisy or sensitive output.

If you need to inspect raw tool outputs from a session, use:

```text
mission_control_session_read(sessionID="ses_123", includeToolOutputs=true)
```

## Cache location

By default, the search cache is stored under:

```text
~/.cache/opencode-mission-control/<scope-hash>/search-index.current_directory.json
~/.cache/opencode-mission-control/<scope-hash>/search-index.global_unscoped.json
```

Current-directory and global discovery use separate cache files so they do not overwrite each other's session snapshots or semantic vectors.

## Caveats

- This tool indexes data exposed by the OpenCode session API, not every row in `opencode.db`.
- `global=true` still depends on what the session API returns.
- The cache is reused until Mission Control decides it is stale and rebuilds it.
