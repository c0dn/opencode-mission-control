export type SearchMode = "lexical" | "semantic" | "hybrid"
export type SemanticProviderName = "disabled" | "jina"
export type SessionDiscoveryScope = "current_directory" | "global_unscoped"

export type ParentResolutionMode =
  | "explicit_parent"
  | "current_session"
  | "scope_latest_session"

export type RelayMode = "manual" | "on_idle" | "on_completion"

export type JobState =
  | "queued"
  | "launching"
  | "running"
  | "waiting_permission"
  | "waiting_question"
  | "idle"
  | "completed"
  | "failed"
  | "aborted"
  | "orphaned"

export type MissionControlErrorCode =
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
  | "CurrentSessionUnavailable"
  | "NotImplemented"

export interface MissionControlConfig {
  search: {
    lexicalEnabled: boolean
    semanticEnabled: boolean
    includeToolOutputsForIndexing: boolean
    semanticProvider: SemanticProviderName
    semanticModel: string
    semanticDimensions?: number
    semanticNormalized: boolean
    semanticEndpoint: string
    semanticRequestTimeoutMs: number
    defaultMode: SearchMode
    indexPath?: string
    defaultResultLimit: number
    maxResultLimit: number
  }
  observe: {
    eventBufferSize: number
    includeToolCalls: boolean
    includeReasoningLabels: boolean
  }
  jobs: {
    enabled: boolean
    maxConcurrent: number
    autoAttachToCurrentSession: boolean
    allowLatestSessionFallback: boolean
    autoRelayToParent: RelayMode
    titlePrefix: string
    keepChildSessionOnCompletion: boolean
  }
  safety: {
    requireExplicitParentOnAmbiguousAttach: boolean
    autoApprovePermissions: false
    autoAnswerQuestions: false
  }
}

export interface SessionChunk {
  chunkID: string
  sessionID: string
  messageID: string
  partID?: string
  parentSessionID?: string
  role: "user" | "assistant" | "system" | "tool" | "unknown"
  partType: "text" | "tool" | "reasoning" | "step-start" | "step-finish" | "unknown"
  agent?: string
  toolName?: string
  text: string
  createdAt: number
}

export interface BackgroundJob {
  jobID: string
  parentSessionID: string
  parentDirectory?: string
  childSessionID?: string
  childDirectory?: string
  title: string
  prompt: string
  relayMode: RelayMode
  state: JobState
  createdAt: number
  updatedAt: number
  launchedAt?: number
  completedAt?: number
  failureReason?: string
  lastObservedEvent?: string
  lastSourceUpdatedAt?: number
  relayState: "not_requested" | "pending" | "delivered" | "failed"
}

export interface JobResultSnapshot {
  jobID: string
  childSessionID: string
  state: "idle" | "completed" | "failed" | "aborted"
  headline: string
  summary: string
  blockers: string[]
  recommendedNextStep?: string
  keyMessageIDs: string[]
  observedAt: number
}

export interface JobLifecycleEvent {
  eventID: string
  jobID: string
  parentSessionID: string
  childSessionID?: string
  type: string
  state: JobState
  previousState?: JobState
  at: number
  detail?: string
}

export interface ParentRelayPayload {
  jobID: string
  childSessionID: string
  title: string
  state: "idle" | "completed" | "failed" | "aborted"
  summary: string
  blockers: string[]
  recommendedNextStep?: string
}

export interface JobStatusResult {
  job: MissionControlJob
  result?: MissionControlJobResult
}

export interface JobStartArgs {
  prompt: string
  sessionId?: string
  title?: string
  relay?: RelayMode
}

export interface JobStartResult {
  jobId: string
  sessionId: string
  childSessionId: string
  state: "launching" | "running"
}

export interface JobListArgs {
  sessionId?: string
  state?: JobState
  limit?: number
}

export interface MissionControlErrorShape {
  code: MissionControlErrorCode
  message: string
  suggestion?: string
}

export interface ToolSuccess<T> {
  ok: true
  data: T
}

export interface ToolFailure {
  ok: false
  error: MissionControlErrorShape
}

export type ToolResult<T> = ToolSuccess<T> | ToolFailure

export interface MissionControlCapabilityMatrix {
  search: {
    sessionRead: boolean
    sessionTree: boolean
    indexedRetrieval: boolean
    semanticRetrieval: boolean
  }
  observe: {
    liveEvents: boolean
    recentBuffer: boolean
  }
  jobs: {
    childSessionLaunch: boolean
    asyncPrompt: boolean
    resultRelay: boolean
  }
}

export interface MissionControlEventRecord {
  type: string
  at: number
  sessionId?: string
  summary: string
}

export interface RuntimeSessionMetadata {
  sessionId: string
  parentSessionId?: string
  title?: string
  directory?: string
  createdAt?: number
  updatedAt?: number
  observedAt: number
}

export interface ToolCallerContext {
  sessionId?: string
  directory?: string
  worktree?: string
}

export interface ParentSessionResolution {
  mode: ParentResolutionMode
  sessionId: string
  directory?: string
  confidence: "explicit" | "high" | "best_effort"
}

export interface MissionControlIndexStatus {
  path: string
  builtAt?: number
  discoveryScope?: SessionDiscoveryScope
  discoveryDirectory?: string
  indexedSessionCount?: number
  includeToolOutputsForIndexing: boolean
  semanticSignature?: string
  dirtySessionCount: number
}

export interface MissionControlStatus {
  name: string
  startedAt: number
  directory: string
  implemented: {
    sessionRead: boolean
    sessionTree: boolean
    sessionObserve: boolean
    sessionSearch: boolean
    jobStart: boolean
  }
  config: MissionControlConfig
  counters: {
    totalEvents: number
    byType: Record<string, number>
  }
  capabilities: MissionControlCapabilityMatrix
  index: MissionControlIndexStatus
}

export interface SessionTranscriptPart {
  partId?: string
  type: string
  text: string
  toolName?: string
}

export interface SessionTranscriptEntry {
  sessionId: string
  messageId: string
  role: string
  agent?: string
  createdAt: number
  parts: SessionTranscriptPart[]
}

export interface SessionSearchArgs {
  query: string
  sessionId?: string
  scope?: "local" | "global"
  exact?: boolean
  limit?: number
}

export interface SessionSearchMatch {
  sessionId: string
  messageId: string
  partId?: string
  score: number
  matchType: "exact" | "candidate"
  title?: string
  snippet: string
  role: string
  partType: string
  createdAt: number
}

export interface SessionSearchResult {
  query: string
  requestedMode: SearchMode
  effectiveMode: SearchMode
  builtAt: number
  indexPath: string
  discoveryScope: SessionDiscoveryScope
  discoveryDirectory?: string
  indexedSessionCount: number
  warnings: string[]
  matches: SessionSearchMatch[]
}

export interface MissionControlPluginOptions {
  search?: Partial<MissionControlConfig["search"]> & {
    jinaApiKey?: string
  }
  observe?: Partial<MissionControlConfig["observe"]>
  jobs?: Partial<MissionControlConfig["jobs"]>
  safety?: Partial<MissionControlConfig["safety"]>
}

export interface MissionControlRuntimeSecrets {
  search: {
    jinaApiKey?: string
  }
}

export interface SessionReadResult {
  sessionId: string
  entries: SessionTranscriptEntry[]
  includedChildSessionIds: string[]
}

export interface SessionTreeNode {
  sessionId: string
  title?: string
  parentSessionId?: string
  status?: string
  children: SessionTreeNode[]
}

export interface SessionObserveResult {
  sessionId: string
  status?: string
  recentEvents: MissionControlEventRecord[]
  children?: Array<{
    sessionId: string
    status?: string
    title?: string
  }>
}

export interface MissionControlJob {
  jobId: string
  sessionId: string
  parentDirectory?: string
  childSessionId?: string
  childDirectory?: string
  title: string
  prompt: string
  relay: RelayMode
  state: JobState
  createdAt: number
  updatedAt: number
  launchedAt?: number
  completedAt?: number
  failureReason?: string
  lastObservedEvent?: string
  lastSourceUpdatedAt?: number
  relayState: "not_requested" | "pending" | "delivered" | "failed"
}

export interface MissionControlJobResult {
  jobId: string
  childSessionId: string
  state: "idle" | "completed" | "failed" | "aborted"
  headline: string
  summary: string
  blockers: string[]
  recommendedNextStep?: string
  keyMessageIds: string[]
  observedAt: number
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export const ok = <T>(data: T): ToolSuccess<T> => ({
  ok: true,
  data,
})

export const fail = (
  code: MissionControlErrorCode,
  message: string,
  suggestion?: string,
): ToolFailure => ({
  ok: false,
  error: {
    code,
    message,
    suggestion,
  },
})
