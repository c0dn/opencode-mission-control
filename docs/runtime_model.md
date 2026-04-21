# Runtime model and behavioral guarantees

This document covers Mission Control behavior that spans multiple tools. Tool-specific arguments and examples still live in the individual `docs/mc_*.md` files.

## Runtime scope

Mission Control supports:

- normal OpenCode runtime with the plugin loaded
- session search and observation using the live runtime plus persisted sidecar data
- background jobs only while the same OpenCode runtime is active
- session discovery and indexing within the scope exposed by the active OpenCode client

Not guaranteed:

- detached execution after OpenCode exits
- background work across machine restarts without an external daemon
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

## Parent-session attachment

Background jobs resolve their parent in this order:

1. explicit `sessionId`
2. current tool caller session
3. latest root session in scope, if fallback is enabled

Failure rules:

- unresolved explicit parent → `ParentSessionNotFound`
- ambiguous fallback roots → `AmbiguousParentSession`
- unavailable scope inspection → `ParentSessionScopeUnavailable`

MVP safety invariant:

- ambiguous automatic attachment must fail instead of guessing

## Configuration invariants

The runtime enforces these MVP-safe rules even if config overrides try to disable them:

- `safety.requireExplicitParentOnAmbiguousAttach = true`
- `safety.autoApprovePermissions = false`
- `safety.autoAnswerQuestions = false`

`jobs.maxConcurrent` is scheduler-enforced.

## Background job lifecycle

Primary states:

- `queued`
- `launching`
- `running`
- `waiting_permission`
- `waiting_question`
- `idle`
- `completed`
- `failed`
- `aborted`
- `orphaned`

Allowed transitions:

```text
queued -> launching -> running
running -> waiting_permission
running -> waiting_question
running -> idle
running -> failed
running -> aborted

waiting_permission -> running | aborted | failed
waiting_question -> running | aborted | failed

idle -> running | completed

completed -> (terminal)
failed -> (terminal)
aborted -> (terminal)
orphaned -> (terminal unless explicitly recovered later)
```

Semantics:

- `idle` means the child became idle, but Mission Control may still need to relay or finalize the result
- `completed` means Mission Control captured a stable result snapshot and finished any configured completion work
- `orphaned` means Mission Control lost live control before the job reached a clean terminal state in the current runtime

Restart behavior:

- active in-flight jobs are not resumed transparently across restart
- unresolved idle jobs that were still pending finalization/relay are treated as orphaned on restart
- previously captured result snapshots remain readable when they already exist

## Child-session reporting contract

Attached child sessions are prompted to end with these headings:

- `Status`
- `Summary`
- `Key Findings`
- `Blockers`
- `Recommended Next Step`

Mission Control uses event/state tracking as the source of truth for lifecycle state, but it also parses those headings when present to improve stored summaries and relays.

## Event handling model

Mission Control listens to OpenCode events and maps them to runtime state updates.

Important mappings:

| Event | Effect |
|---|---|
| `session.created` | cache session metadata and parent/child linkage |
| `session.updated` | refresh cached session metadata and timestamps |
| `session.status` | update live session/job state |
| `session.idle` | move a running child job to idle and begin finalization |
| `session.error` | move a job to failed |
| `message.updated` / `message.part.updated` | refresh index candidates and recent job activity |
| `message.part.removed` / `message.removed` | invalidate stale indexed content |
| `permission.asked` / `permission.replied` | track permission-blocked jobs |
| `question.asked` / `question.replied` / `question.rejected` | track question-blocked jobs |

`mc_session_events` is backed by an in-memory recent-event buffer. It is a live and recent view, not a full audit log.

## Persistence model

Mission Control writes JSON sidecars under:

```text
~/.cache/opencode-mission-control/<scope-hash>/
```

Current sidecars:

- `search-index.<scope>.json` — normalized searchable chunks, per-session cursors, and optional semantic/query-vector cache
- dirty invalidation sidecars — persisted transcript/index invalidations
- `jobs.json` — background jobs, lifecycle events, and stable result snapshots

Persistence rules:

- OpenCode storage is treated as read-only
- directory-scoped and global-unscoped indexes stay distinguishable
- sidecar writes are best-effort and aim to be idempotent where practical
- unchanged sessions are incrementally reused through persisted cursors/checkpoints

## Parent relay semantics

Parent relays carry:

- `jobId`
- `childSessionId`
- `title`
- `state`
- `summary`
- `blockers`
- optional `recommendedNextStep`

Delivery rules:

- at-most-once by default per finalized stored snapshot
- explicit redelivery is allowed through `mc_job_result({ jobId, sendToParent: true })`
- relay failure must not erase the stored result snapshot

Public relay modes:

- `manual` stores the result without automatic parent delivery
- `on_idle` relays when the child session settles after useful work
- `on_completion` relays on idle and also on stable failure or abort completion paths

## Semantic search

Semantic search is optional.

- lexical mode remains the fallback and must still be useful by itself
- `exact=true` forces lexical retrieval
- hybrid/semantic modes are relevance modes, not exact-match guarantees
- chunk embeddings and recent query embeddings are cached in the scope-specific search index

## Error guidance

Important user-facing errors include:

- `AmbiguousParentSession`
- `ParentSessionNotFound`
- `ParentSessionScopeUnavailable`
- `JobNotFound`
- `JobLaunchFailed`
- `SearchIndexUnavailable`
- `GlobalSessionDiscoveryUnavailable`
- `IndexScopeMismatch`
- `CurrentSessionUnavailable`

Mission Control should return errors with actionable next steps, especially for ambiguous parent selection, blocked jobs, and scope mismatches.

## Non-goals

Explicitly unsupported in this plugin-only MVP:

- autonomous background execution after OpenCode exits
- silent permission approval
- silent question answering
- hidden mutation of OpenCode internals
