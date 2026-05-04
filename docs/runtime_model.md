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

The public `mc_job_start` tool attaches background jobs to the current tool caller session only.

Mission Control resolves the parent session from the active tool caller context, preferring message ownership checks when a current message ID is available.

Failure rules:

- unresolved current caller session → `ParentSessionScopeUnavailable`

MVP safety invariant:

- job launch must fail instead of guessing another parent session

## Configuration invariants

The runtime enforces these MVP-safe rules even if config overrides try to disable them:

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
launching -> failed
launching -> orphaned
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
- `completed` means Mission Control captured a stable result snapshot and finished final relay/finalization work
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

For long-running work, attached child sessions may also call `mc_job_update({ message, notifyParent? })` to append progress events without ending the job.

## Transcript inspection

- `mc_session_read` is the exact transcript inspection tool and supports newest-relative paging with `offset` and `limit`
- `mc_session_tail` is the compact recent-message view and omits tool outputs, reasoning, and step markers
- limited `mc_session_read` / `mc_session_tail` calls now use raw OpenCode session-message paging when the runtime exposes the raw request client
- that raw paged path fetches only enough recent message pages to satisfy the requested page plus one older-entry probe for `hasMore`
- anchored reads (`beforeMessageId`) and runtimes without the raw request client still use the exact full-history path
- because the upstream session-message API does not expose a total-count field, `totalEntriesExact` is `false` and `totalEntries` is only a lower bound whenever `hasMore` is `true` on the raw paged path

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
- some reply/progress mutations can succeed in memory even if the sidecar write fails, so an immediate restart can still lose the newest job-event or blocked-state mutation
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
- terminal completion, failure, and abort outcomes notify the parent automatically
- blocked permission/question requests are relayed to the parent session as concise notifications with the relevant reply tool path when Mission Control can resolve the active pending request
- sparse blocked-state fallbacks may still send a generic blocked notification before normalized pending input is available
- child progress updates are stored in the job event feed and only relay to the parent when `notifyParent: true`

## Blocked child input bridge

When a tracked child session emits `permission.asked` or `question.asked`:

- Mission Control stores a normalized pending request on the job when request details are available
- the job moves to `waiting_permission` or `waiting_question`
- a concise notification is relayed to the parent session when Mission Control can resolve the active pending request
- if request details are not available yet, Mission Control may send a generic blocked notification first and attach normalized pending input later
- the parent can respond with `mc_job_permission_reply`, `mc_job_question_reply`, or `mc_job_question_reject`

This is a Mission Control relay and reply bridge, not a mirrored native approval UI.

## Job event feed

Mission Control persists a per-job event stream in `jobs.json`.

The feed includes:

- lifecycle events such as `job.created`, `job.launched`, `session.idle`, and `job.relay_delivered`
- blocked-input events such as `permission.asked`, `question.asked`, and their reply/reject outcomes
- child progress events recorded through `mc_job_update`

`mc_job_events` reads this persisted feed. Unlike `mc_session_events`, it survives runtime restart as long as the same Mission Control cache scope is reused.

The persisted job-event feed is retained as a recent history window, not an unbounded forever-log.

## Semantic search

Semantic search is optional.

- lexical mode remains the fallback and must still be useful by itself
- `exact=true` forces lexical retrieval
- hybrid/semantic modes are relevance modes, not exact-match guarantees
- chunk embeddings and recent query embeddings are cached in the scope-specific search index

## Error guidance

Important user-facing errors include:

- `ParentSessionNotFound`
- `ParentSessionScopeUnavailable`
- `JobNotFound`
- `JobLaunchFailed`
- `SearchIndexUnavailable`
- `GlobalSessionDiscoveryUnavailable`
- `IndexScopeMismatch`
- `CurrentSessionUnavailable`

Mission Control should return errors with actionable next steps, especially for blocked jobs and scope mismatches.

## Non-goals

Explicitly unsupported in this plugin-only MVP:

- autonomous background execution after OpenCode exits
- silent permission approval
- silent question answering
- hidden mutation of OpenCode internals
