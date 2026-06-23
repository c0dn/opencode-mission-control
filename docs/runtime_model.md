# Runtime model and behavioral guarantees

This document covers Mission Control behavior that spans multiple tools. Tool-specific arguments and examples live in the individual `docs/*.md` files.

## Requirements

A Jina API key must be configured (`search.jinaApiKey`) for the plugin to register any tools. Without a key the plugin returns an inert object with no tools.

## Runtime scope

Mission Control supports:

- normal OpenCode runtime with the plugin loaded
- session metadata lookup, content search, and read using the live runtime plus persisted sidecar data
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

When OpenCode provides an ambient workspace ID, Mission Control captures it once while constructing the plugin server. That workspace ID is propagated to OpenCode session/list/message API calls.

Cache and index paths are partitioned by a short SHA-1 workspace key.

## Transcript inspection

- `session_get` returns normalized metadata for one session ID; it does not return transcript messages.
- `session_find` returns normalized metadata candidates for exact title lookup; exact titles can be ambiguous, so callers should select from candidates using metadata.
- `session_list` browses and filters sessions by scope, timestamp floor, and title substring. Returns all sessions (parents and children) sorted by most-recently-updated.
- `session_read` is the exact transcript inspection tool and supports newest-relative paging with `offset` and `limit`.
- `session_tail` is the compact recent-message view and omits tool outputs, reasoning, step markers, `agent-switched`, and `model-switched` entries. Compaction summaries are included.
- All message reads use the V2 session API (`/api/session/{id}/message`). There is no classic fallback; servers older than the V2 routes are not supported.
- Limited `session_read` / `session_tail` calls use the V2 cursor-based paging API. The first page is fetched with `order: "desc"` (newest first); follow-up pages use the opaque `cursor.next` value without an explicit order parameter.
- Each page is reversed to ascending order before processing so newest-relative offset/limit semantics are preserved.
- Anchored reads (`beforeMessageId`) and unlimited reads use the V2 full-history path: paginate `order: "asc"` to completion following `cursor.next`.
- `totalEntriesExact` is `false` whenever `hasMore` is `true` on the paged path.

## Session abort

- `subagent_abort` calls OpenCode's public `POST /session/{sessionID}/abort` API through the active client scope.
- Intended primarily for cancelling background subagents by subagent session ID.
- Mission Control does not mutate OpenCode storage directly when aborting.

## Inter-session messaging

- `subagent_send_async` and `subagent_send_interrupt` deliver a message from the current subagent to a **peer subagent** (a sibling with the same parent session).
- Both use OpenCode's public `POST /session/{sessionID}/prompt_async` API, which creates a real reply-generating user message and returns immediately.
- `subagent_send_async` queues the message; the target acts on it at its next loop boundary.
- `subagent_send_interrupt` issues a best-effort `POST /session/{sessionID}/abort` first, then queues the message, so it is picked up immediately.
- The delivered message is wrapped in an `<inter_agent_message from="...">` envelope.

### Peer-only guard

- Allowed: sender and target share the same parent session (siblings).
- Rejected with end-loop guidance: the target is the sender's own calling/parent session. To return a result to your parent, **finish and end your loop** — results auto-return automatically.
- Rejected: target is from a different orchestration tree.

## Session search

`session_search` and `session_search_global` search indexed transcript content.

- Always uses hybrid retrieval: lexical FTS5/BM25 + Jina semantic embeddings fused with RRF.
- A Jina API key is required; without one, the plugin does not load.
- Lexical scoring remains a silent runtime fallback if the Jina API call fails.
- Chunk embeddings and recent query embeddings are cached in the scope-specific SQLite search index.

## Subagent IDs during compaction

- Mission Control records observed parent/child session links from `session.created` and `session.updated` events in live runtime state.
- When OpenCode exposes `experimental.session.compacting`, Mission Control appends a compact context block listing known child/subagent session IDs for the session being compacted.
- This context is best-effort and in-memory. IDs observed before plugin startup or after plugin restart may be missing.

## Event handling model

Mission Control listens to OpenCode events and maps them to runtime state updates.

| Event | Effect |
|---|---|
| `session.created` | cache session metadata and parent/child linkage |
| `session.updated` | refresh cached session metadata and timestamps |
| `session.deleted` | remove live status/metadata, unlink children, and mark indexed content dirty |
| `session.status` | update live session status |
| `session.idle` | record idle state for recent session activity |
| `session.error` | record error state for recent session activity |
| `message.updated` / `message.part.updated` | refresh index candidates and recent activity |
| `message.part.removed` / `message.removed` | invalidate stale indexed content |
| `permission.asked` / `permission.replied` | record recent permission activity |
| `question.asked` / `question.replied` / `question.rejected` | record recent question activity |
| `session.next.*` | record active next-runtime activity |
| `todo.updated` | record the event without changing session running state |

## Persistence model

Mission Control writes sidecars under:

```text
~/.cache/opencode-mission-control/<scope-hash>/
```

Current sidecars:

- `search-index.<scope>.sqlite3` — normalized searchable chunks, SQLite FTS5/BM25 lexical data, per-session cursors, and semantic/query-vector cache
- dirty invalidation sidecars — persisted transcript/index invalidations

Persistence rules:

- OpenCode storage is treated as read-only.
- Directory-scoped and global-unscoped indexes stay distinguishable.
- Workspace-scoped runtimes use isolated cache/index partitions.
- Indexes with a `version` field that does not match the current internal version are discarded and rebuilt entirely.

## Error guidance

Important user-facing errors:

- `SearchIndexUnavailable`
- `GlobalSessionDiscoveryUnavailable`
- `IndexScopeMismatch`
- `CurrentSessionUnavailable`
- `SubagentPromptRejected`
- `SessionLookupUnavailable`

## Non-goals

Explicitly unsupported:

- autonomous or attached task orchestration
- silent permission approval
- silent question answering
- hidden mutation of OpenCode internals
