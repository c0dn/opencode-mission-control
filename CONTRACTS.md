# Contracts

This document defines the initial contracts for `opencode-mission-control`.

The contracts are intentionally conservative: they reflect what is practical with the current OpenCode plugin/runtime model, especially for session-backed background work.

---

## 1. Runtime support contract

### Guaranteed target

Mission-control supports:

- normal OpenCode runtime with the plugin loaded
- session search and observation using the live runtime plus persisted session data
- background agents only while the same OpenCode runtime is active
- session discovery and indexing within the scope exposed by the active plugin SDK client

### Not guaranteed by contract

- detached execution after OpenCode exits
- background work across machine restarts without an additional daemon
- implicit current-session resolution in every possible tool invocation context
- true cross-project/global session discovery unless mission-control uses an unscoped session client on purpose

### Discovery-scope contract

```ts
type SessionDiscoveryScope =
  | "current_directory"
  | "global_unscoped";

interface SessionDiscoveryState {
  scope: SessionDiscoveryScope;
  directory?: string;
  note?: string;
}
```

Rules:

1. If mission-control uses the plugin-provided SDK client, session discovery is assumed to be directory-scoped unless proven otherwise.
2. An omitted `directory` argument must **not** be treated as proof of global scope.
3. Mission-control must not describe a search as "global" unless session enumeration itself was unscoped.
4. In the current SDK integration, global discovery may be implemented by an explicit empty-directory override at the adapter layer; that behavior is internal and must not leak into the public tool API.
5. Index metadata should record which discovery scope produced the current index.

---

## 2. Parent-session attachment contract

```ts
type ParentResolutionMode =
  | "explicit_parent"
  | "current_session"
  | "scope_latest_session";

interface ParentSessionResolution {
  mode: ParentResolutionMode;
  sessionID: string;
  confidence: "explicit" | "high" | "best_effort";
}
```

### Resolution rules

1. If `parentSessionID` is provided, use it, and fail with `ParentSessionNotFound` if it cannot be resolved.
2. If omitted, try to resolve the currently active session in the current TUI/session scope.
3. If configured to allow fallback, use the latest active root session in the same scope.
4. If more than one candidate is plausible, fail with `AmbiguousParentSession`.

### Failure contract

```ts
type ParentResolutionErrorCode =
  | "ParentSessionNotFound"
  | "AmbiguousParentSession"
  | "ParentSessionScopeUnavailable";
```

---

## 3. Plugin configuration contract

```ts
interface MissionControlConfig {
  search: {
    lexicalEnabled: boolean;
    semanticEnabled: boolean;
    defaultMode: "lexical" | "semantic" | "hybrid";
    indexPath?: string;
    defaultResultLimit: number;
    maxResultLimit: number;
  };
  observe: {
    eventBufferSize: number;
    includeToolCalls: boolean;
    includeReasoningLabels: boolean;
  };
  jobs: {
    enabled: boolean;
    maxConcurrent: number;
    autoAttachToCurrentSession: boolean;
    allowLatestSessionFallback: boolean;
    autoRelayToParent: "never" | "on_idle" | "on_completion" | "manual_only";
    titlePrefix: string;
    keepChildSessionOnCompletion: boolean;
  };
  safety: {
    requireExplicitParentOnAmbiguousAttach: boolean;
    autoApprovePermissions: false;
    autoAnswerQuestions: false;
  };
}
```

### Required behavior

- `autoApprovePermissions` must remain `false` in the MVP.
- `autoAnswerQuestions` must remain `false` in the MVP.
- `maxConcurrent` must be enforced by the scheduler.
- The runtime config layer must ignore attempts to override `autoApprovePermissions` or `autoAnswerQuestions` away from `false`.

---

## 4. Core entity contracts

### Session chunk

```ts
interface SessionChunk {
  chunkID: string;
  sessionID: string;
  messageID: string;
  partID?: string;
  parentSessionID?: string;
  role: "user" | "assistant" | "system" | "tool" | "unknown";
  partType: "text" | "tool" | "reasoning" | "step-start" | "step-finish" | "unknown";
  agent?: string;
  toolName?: string;
  text: string;
  createdAt: number;
}
```

### Background job

```ts
type JobState =
  | "queued"
  | "launching"
  | "running"
  | "waiting_permission"
  | "waiting_question"
  | "idle"
  | "completed"
  | "failed"
  | "aborted"
  | "orphaned";

interface BackgroundJob {
  jobID: string;
  parentSessionID: string;
  childSessionID?: string;
  title: string;
  prompt: string;
  state: JobState;
  createdAt: number;
  updatedAt: number;
  launchedAt?: number;
  completedAt?: number;
  failureReason?: string;
  lastObservedEvent?: string;
  relayState: "not_requested" | "pending" | "delivered" | "failed";
}
```

### Job result snapshot

```ts
interface JobResultSnapshot {
  jobID: string;
  childSessionID: string;
  state: "idle" | "completed" | "failed" | "aborted";
  headline: string;
  summary: string;
  blockers: string[];
  keyMessageIDs: string[];
  observedAt: number;
}
```

---

## 5. Job lifecycle contract

### Allowed transitions

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
orphaned -> (terminal unless recovered)
```

### Semantics

- `idle` means the child session became idle, but mission-control has not necessarily finalized delivery/reporting yet.
- `completed` means mission-control captured a stable result snapshot and, if configured, completed parent relay work.
- `orphaned` means the plugin lost live control over a job before reaching a terminal state.

---

## 6. Background-agent prompt contract

Each child session should receive a system or preamble block describing its job contract.

### Required content

- job ID
- parent session ID
- mission title
- task brief
- reporting rules
- blocker rules
- stop condition

### Suggested template

```md
You are running as an attached background session for OpenCode Mission Control.

- Job ID: <jobID>
- Parent Session ID: <parentSessionID>
- Mission: <title>

Rules:
1. Work autonomously until you complete the task or become blocked.
2. If blocked by missing information, permissions, or a question, state the blocker clearly.
3. End with a short final report using these headings:
   - Status
   - Summary
   - Key Findings
   - Blockers
   - Recommended Next Step
```

This is a contract, not a guarantee. The plugin still needs event-based status tracking rather than trusting model text alone.

---

## 7. Tool surface contract

Tool names can still change, but the contract below is the intended MVP surface.

## 7.1 Session search

```ts
interface SessionSearchArgs {
  query: string;
  sessionID?: string;
  global?: boolean;
  exact?: boolean;
  limit?: number;
}

interface SessionSearchResult {
  query: string;
  requestedMode: "lexical" | "semantic" | "hybrid";
  effectiveMode: "lexical" | "semantic" | "hybrid";
  builtAt: number;
  indexPath: string;
  discoveryScope: "current_directory" | "global_unscoped";
  discoveryDirectory?: string;
  indexedSessionCount: number;
  warnings: string[];
  matches: Array<{
    sessionID: string;
    messageID: string;
    partID?: string;
    score: number;
    title?: string;
    snippet: string;
    role: string;
    partType: string;
    createdAt: number;
  }>;
}
```

Contract:

- must work in `lexical` mode even if semantic mode is disabled
- when `sessionID` is supplied, the simplified tool should search that session subtree by default
- must return readable snippets, not raw full payloads by default

### Search-scope semantics

- `sessionID` narrows the search to a specific session subtree by default.
- `global=true` requests unscoped/cross-project session discovery rather than the default current-directory discovery path.
- `global=false` (or omitted) means "all indexed sessions in the current directory scope," **not** "all sessions everywhere."
- Any adapter-level empty-directory override used to reach global discovery is an internal implementation detail, not part of the public search contract.
- Search/status output should make it clear whether results come from current-directory scope or true global scope.

### Search-exactness semantics

- `exact=true` must force lexical retrieval.
- `lexical` is the authoritative mode for acronym/exact-term lookups such as `HTX`, `TISC`, or other short identifiers.
- `semantic` and `hybrid` are relevance modes, not exact-match guarantees, and may return typo-adjacent or conceptually similar results.
- Mission-control may auto-select lexical retrieval for obviously exact-looking queries (quoted strings, acronyms, identifiers, paths).
- Mission-control should surface `requestedMode`, `effectiveMode`, and warnings whenever fallback or approximate retrieval semantics matter.
- Users should be able to distinguish "ranked candidate" results from "exact lexical hit" results.

## 7.2 Session read

```ts
interface SessionReadArgs {
  sessionID: string;
  beforeMessageID?: string;
  limit?: number;
  includeChildren?: boolean;
  includeToolOutputs?: boolean;
}
```

Contract:

- returns ordered transcript material
- defaults to bounded output
- may optionally include child-session summaries instead of full expansion
- `beforeMessageID` is a hard boundary applied before transcript-part filtering such as `includeToolOutputs=false`

## 7.3 Session tree

```ts
interface SessionTreeArgs {
  sessionID: string;
  depth?: number;
}
```

Contract:

- returns parent/child hierarchy using actual OpenCode session relationships

## 7.4 Session observe

```ts
interface SessionObserveArgs {
  sessionID: string;
  includeChildren?: boolean;
  eventLimit?: number;
}

interface SessionObserveResult {
  sessionID: string;
  status?: string;
  recentEvents: Array<{
    type: string;
    at: number;
    summary: string;
  }>;
  children?: Array<{
    sessionID: string;
    status?: string;
    title?: string;
  }>;
}
```

Contract:

- observer output is a recent operational view, not a permanent audit log

## 7.5 Background job start

```ts
interface JobStartArgs {
  title: string;
  prompt: string;
  parentSessionID?: string;
  attach?: "auto" | "explicit_only";
  relayToParent?: "never" | "on_idle" | "on_completion" | "manual_only";
}

interface JobStartResult {
  jobID: string;
  parentSessionID: string;
  childSessionID: string;
  state: "launching" | "running";
}
```

Contract:

- creates a child session
- launches asynchronously
- returns immediately without waiting for completion

## 7.6 Background job status

```ts
interface JobStatusArgs {
  jobID: string;
}
```

Contract:

- returns current lifecycle state plus child/parent linkage

## 7.7 Background job list

```ts
interface JobListArgs {
  parentSessionID?: string;
  state?: JobState;
  limit?: number;
}
```

## 7.8 Background job cancel

```ts
interface JobCancelArgs {
  jobID: string;
}
```

Contract:

- aborts the child session if still active
- marks the job `aborted`

## 7.9 Background job result

```ts
interface JobResultArgs {
  jobID: string;
  relayToParent?: boolean;
}
```

Contract:

- returns the latest stable child-session result snapshot
- may optionally deliver or redeliver that snapshot to the parent session

---

## 8. Event handling contract

Mission-control listens to OpenCode events and maps them to internal state updates.

### Required event mapping

| OpenCode event | Mission-control effect |
|---|---|
| `session.created` | cache session metadata; bind child to parent if relevant |
| `session.updated` | refresh session metadata and timestamps |
| `session.status` | update live state for observer/job tracking |
| `session.idle` | move running child job to `idle` pending finalization |
| `session.error` | move job to `failed` |
| `message.updated` | refresh transcript/index candidates |
| `message.part.updated` | capture text/tool changes and recent activity |
| `message.part.removed` | invalidate stale chunks/snippets |
| `permission.asked` | mark job `waiting_permission` |
| `permission.replied` | allow transition back to `running` |
| `question.asked` | mark job `waiting_question` |
| `question.replied` / `question.rejected` | transition back to `running` or `failed` depending on outcome |

### Event-buffer contract

Mission-control may keep an in-memory ring buffer of recent events for fast observe calls. This buffer is not the long-term source of truth.

---

## 9. Persistence contract

Mission-control owns a sidecar store.

### Minimum tables or logical collections

```text
mc_session_chunk      searchable normalized text/tool chunks
mc_session_cursor     incremental indexing checkpoints
mc_job                background job registry
mc_job_event          normalized job lifecycle events
mc_job_result         stable result snapshots
mc_embedding          optional vector cache
```

Current MVP note:

- The shipping implementation uses JSON sidecars under `~/.cache/opencode-mission-control/<scope-hash>/` rather than a relational sidecar DB.
- `search-index.<scope>.json` currently covers the `mc_session_chunk` store, per-session cursors, and optional semantic/query-vector cache.
- `jobs.json` currently covers `mc_job` and `mc_job_result` snapshots.
- The search index now includes persisted per-session cursor/checkpoint state so unchanged sessions can be incrementally reused during rebuilds.
- Dirty transcript invalidations are persisted separately so message-part edits can still force a rebuild after restart even when a session's `updatedAt` marker is unchanged.
- `mc_job_event` remains deferred; the current MVP still does not persist a normalized lifecycle-event log.

### Persistence rules

- OpenCode DB/storage is read-only from mission-control
- sidecar writes must be idempotent where practical
- chunk identity should be stable across reindexing where possible
- the sidecar should record index build scope, build time, semantic signature, and whether tool-output indexing was enabled
- index artifacts built from directory-scoped discovery must remain distinguishable from artifacts built from true global discovery
- Missing deferred collections must be treated as an MVP limitation, not as an implemented guarantee.

---

## 10. Parent relay contract

When relay is enabled, the plugin may post a structured parent-session update.

### Parent relay payload

```ts
interface ParentRelayPayload {
  jobID: string;
  childSessionID: string;
  title: string;
  state: "idle" | "completed" | "failed" | "aborted";
  summary: string;
  blockers: string[];
  recommendedNextStep?: string;
}
```

### Delivery semantics

- at-most-once by default per finalized snapshot
- explicit redelivery allowed through a tool
- failed delivery must not erase the result snapshot

---

## 11. Semantic search contract

Semantic search is optional.

### Rules

- the plugin must still be fully useful when semantic mode is disabled
- semantic indexing must be opt-in
- lexical mode remains the safety fallback
- hybrid mode may rerank lexical candidates or run parallel retrieval

### Backend contract

```ts
interface EmbeddingBackend {
  name: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
```

---

## 12. MVP-safe error contract

```ts
type MissionControlErrorCode =
  | "AmbiguousParentSession"
  | "ParentSessionNotFound"
  | "ParentSessionScopeUnavailable"
  | "JobNotFound"
  | "JobLaunchFailed"
  | "JobBlockedOnPermission"
  | "JobBlockedOnQuestion"
  | "SearchIndexUnavailable"
  | "SemanticSearchDisabled"
  | "GlobalSessionDiscoveryUnavailable"
  | "IndexScopeMismatch"
  | "CurrentSessionUnavailable";
```

Errors should be returned in a way that tells the user what to do next, especially for parent-session ambiguity and blocked background jobs.

Additional guidance:

- `GlobalSessionDiscoveryUnavailable` should be used when the user asked for a global/cross-project search but mission-control only has a directory-scoped client/index.
- `IndexScopeMismatch` should be used when a request assumes a broader scope than the currently built index actually covers.

---

## 13. Non-goal contract

For this plugin generation, the following are explicitly unsupported:

- autonomous background execution after OpenCode exits
- silent permission approvals
- silent question answering
- hidden mutation of OpenCode internals

If those capabilities are needed later, they should be introduced as a deliberate follow-on design, likely with an external daemon/service contract rather than stretching the plugin-only model.
