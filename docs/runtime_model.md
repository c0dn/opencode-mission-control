# Runtime model and behavioral guarantees

This document covers Mission Control behavior that spans multiple tools. Tool-specific arguments and examples still live in the individual `docs/mc_*.md` files.

## Runtime scope

Mission Control supports:

- normal OpenCode runtime with the plugin loaded
- session metadata lookup, content search, and observation using the live runtime plus persisted sidecar data
- session discovery and indexing within the scope exposed by the active OpenCode client
- ambient OpenCode workspaces when the plugin context exposes a workspace ID at construction time

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

## Ambient workspace scope

When OpenCode provides an ambient workspace ID, Mission Control captures it once while constructing the plugin server. That workspace ID is propagated to OpenCode session/list/message API calls and exposed as metadata fields such as `workspaceID` or `discoveryWorkspaceID`.

Workspace IDs observed later in events or session payloads are metadata only. They do not re-key a running server or move an existing cache. Mission Control does not expose user-selectable workspace arguments on `mc_session_*` tools.

Cache and index paths are partitioned by a short SHA-1 workspace key. Without an ambient workspace, existing no-workspace cache paths are unchanged.

## Configuration invariants

Mission Control exposes its session, search, observe, and Zellij terminal tools unconditionally. The retired `tools.surface` option is ignored when present for compatibility with older configs.

## Transcript inspection

- Mission Control tool responses include OpenCode plugin result titles (for example, `Session Transcript` or `Mission Control Status`) while preserving the JSON output and metadata payload.
- `mc_session_get` returns normalized metadata for one session ID; it does not return transcript messages.
- `mc_session_find` returns normalized metadata candidates for exact title lookup; exact titles can be ambiguous, so callers should select from candidates using metadata.
- `mc_session_read` is the exact transcript inspection tool and supports newest-relative paging with `offset` and `limit`.
- `mc_session_tail` is the compact recent-message view and omits tool outputs, reasoning, and step markers.
- limited `mc_session_read` / `mc_session_tail` calls use raw OpenCode session-message paging when the runtime exposes the raw request client.
- that raw paged path fetches only enough recent message pages to satisfy the requested page plus one older-entry probe for `hasMore`.
- anchored reads (`beforeMessageId`) and runtimes without the raw request client still use the exact full-history path.
- because the upstream session-message API does not expose a total-count field, `totalEntriesExact` is `false` and `totalEntries` is only a lower bound whenever `hasMore` is `true` on the raw paged path.

## Session abort

- `mc_session_abort` calls OpenCode's public `POST /session/{sessionID}/abort` API through the active client scope.
- The tool is intended primarily for cancelling background subagents by subagent session ID.
- Foreground subagents can block the parent tool loop, so cancellation is most reliable when another active tool loop can issue the abort request.
- Mission Control does not mutate OpenCode storage directly when aborting; the only mutation is the public OpenCode API call.

## Subagent IDs during compaction

- Mission Control records observed parent/child session links from `session.created` and `session.updated` events in the live runtime state.
- When OpenCode exposes `experimental.session.compacting`, Mission Control appends a compact context block listing known child/subagent session IDs for the session being compacted.
- This context is intended to preserve IDs for running or recently launched background subagents so later turns can inspect or cancel them with `mc_session_abort`.
- The injection is best-effort and in-memory. Without a persisted sidecar, IDs observed before plugin startup or after plugin restart may be missing.
- `session.compacted` is too late to affect the summary currently being generated; compaction context must be injected through the pre-compaction experimental hook.

## Event handling model

Mission Control listens to OpenCode events and maps them to runtime state updates.

Important mappings:

| Event | Effect |
|---|---|
| `session.created` | cache session metadata and parent/child linkage |
| `session.updated` | refresh cached session metadata and timestamps |
| `session.deleted` | remove live status/metadata, unlink children, and mark indexed content dirty for removal |
| `session.status` | update live session status |
| `session.idle` | record idle state for recent session activity |
| `session.error` | record error state for recent session activity |
| `message.updated` / `message.part.updated` | refresh index candidates and recent activity |
| `message.part.removed` / `message.removed` | invalidate stale indexed content |
| `permission.asked` / `permission.replied` | record recent permission activity for session events |
| `question.asked` / `question.replied` / `question.rejected` | record recent question activity for session events |
| `session.next.*` | record active next-runtime activity as `running`, except failed step/tool events which become `error` |
| `todo.updated` | record the event without changing session running state |

`mc_session_events` is backed by an in-memory recent-event buffer. It is a live and recent view, not a full audit log.

## Zellij terminal model

Mission Control terminal tools use Zellij as the terminal backend. The plugin creates or reuses a background Zellij session for the owning OpenCode session and opens command panes inside it.

Rules:

1. Mission Control invokes the `zellij` CLI with argv arrays; it does not own terminal child processes directly.
2. A terminal record stores both Zellij session name and pane id. Pane ids are treated as session-local.
3. Terminal registry state is in-memory and scoped to the running plugin server.
4. Known running terminals are polled for completion/cancel/error state; there is no explicit wait tool.
5. Completion/cancel/error notifications are injected into the owning OpenCode session as best-effort synthetic text using `<terminal id="..." state="completed|cancelled|error">`.
6. Zellij panes are not closed by default so scrollback remains available.

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
- workspace-scoped runtimes use isolated cache/index partitions; no-workspace runtimes keep the legacy partitions.
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
- a Mission Control wait API for terminals
