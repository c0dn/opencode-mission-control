# Runtime model and behavioral guarantees

This document covers Mission Control behavior that spans multiple tools. Tool-specific arguments and examples still live in the individual `docs/mc_*.md` files.

## Runtime scope

Mission Control supports:

- normal OpenCode runtime with the plugin loaded
- session metadata lookup, content search, and observation using the live runtime plus persisted sidecar data
- session discovery and indexing within the scope exposed by the active OpenCode client

Not guaranteed:

- implicit current-session resolution in every possible tool-call context
- true cross-project/global discovery unless Mission Control explicitly uses unscoped discovery

## Session discovery scope

Mission Control uses two discovery scopes:

- `current_directory`
- `global_unscoped`

Rules:

1. Normal plugin-backed discovery is treated as directory-scoped unless proven otherwise.
2. An omitted `directory` value is not proof of global scope.
3. Mission Control must not describe results as global unless session enumeration itself was unscoped.
4. The adapter may use an internal empty-directory override to reach global discovery; that is not part of the public tool API.
5. Search index metadata records the discovery scope used to build the current index.

## Configuration invariants

Legacy orchestration-only tool surface values are normalized to the full session inspection/search tool surface because task orchestration is no longer exposed.

## Transcript inspection

- `mc_session_get` returns normalized metadata for one session ID; it does not return transcript messages.
- `mc_session_find` returns normalized metadata candidates for exact title lookup; exact titles can be ambiguous, so callers should select from candidates using metadata.
- `mc_session_read` is the exact transcript inspection tool and supports newest-relative paging with `offset` and `limit`.
- `mc_session_tail` is the compact recent-message view and omits tool outputs, reasoning, and step markers.
- limited `mc_session_read` / `mc_session_tail` calls use raw OpenCode session-message paging when the runtime exposes the raw request client.
- that raw paged path fetches only enough recent message pages to satisfy the requested page plus one older-entry probe for `hasMore`.
- anchored reads (`beforeMessageId`) and runtimes without the raw request client still use the exact full-history path.
- because the upstream session-message API does not expose a total-count field, `totalEntriesExact` is `false` and `totalEntries` is only a lower bound whenever `hasMore` is `true` on the raw paged path.

## Event handling model

Mission Control listens to OpenCode events and maps them to runtime state updates.

Important mappings:

| Event | Effect |
|---|---|
| `session.created` | cache session metadata and parent/child linkage |
| `session.updated` | refresh cached session metadata and timestamps |
| `session.status` | update live session status |
| `session.idle` | record idle state for recent session activity |
| `session.error` | record error state for recent session activity |
| `message.updated` / `message.part.updated` | refresh index candidates and recent activity |
| `message.part.removed` / `message.removed` | invalidate stale indexed content |
| `permission.asked` / `permission.replied` | record recent permission activity for session events |
| `question.asked` / `question.replied` / `question.rejected` | record recent question activity for session events |

`mc_session_events` is backed by an in-memory recent-event buffer. It is a live and recent view, not a full audit log.

## Persistence model

Mission Control writes sidecars under:

```text
~/.cache/opencode-mission-control/<scope-hash>/
```

Current sidecars:

- `search-index.<scope>.sqlite3` — normalized searchable chunks, SQLite FTS/BM25 lexical data, per-session cursors, and optional semantic/query-vector cache
- dirty invalidation sidecars — persisted transcript/index invalidations

Persistence rules:

- OpenCode storage is treated as read-only.
- directory-scoped and global-unscoped indexes stay distinguishable.
- sidecar writes are best-effort and aim to be idempotent where practical.
- unchanged sessions are incrementally reused through persisted cursors/checkpoints.
- legacy JSON search-index sidecars may be imported when present, but the active search cache is SQLite-backed.

## Session search

`mc_session_search` searches indexed transcript content. It does not perform title-only lookup; exact title lookup belongs to `mc_session_find`.

- lexical retrieval uses SQLite FTS5/BM25 and remains the fallback
- `exact=true` forces lexical retrieval
- hybrid retrieval is automatic when a configured Jina semantic provider/API key is available; otherwise search falls back to lexical retrieval
- hybrid retrieval fuses lexical and semantic ranked candidates with RRF
- native vector-table support (`vec1` / `sqlite-vec`) is best-effort; blob-scan vector retrieval is the fallback when extension-backed queries are unavailable or fail
- hybrid/semantic retrieval is a relevance mode, not an exact-match guarantee
- chunk embeddings and recent query embeddings are cached in the scope-specific SQLite search index

## Error guidance

Important user-facing errors include:

- `SearchIndexUnavailable`
- `GlobalSessionDiscoveryUnavailable`
- `IndexScopeMismatch`
- `CurrentSessionUnavailable`
- `SessionLookupUnavailable`

Mission Control should return errors with actionable next steps, especially for scope mismatches and unavailable session lookup paths.

## Non-goals

Explicitly unsupported:

- autonomous or attached task orchestration
- silent permission approval
- silent question answering
- hidden mutation of OpenCode internals
