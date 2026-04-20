export type SearchMode = "lexical" | "semantic" | "hybrid"
export type SemanticProviderName = "disabled" | "jina"
export type SessionDiscoveryScope = "current_directory" | "global_unscoped"

export type ParentResolutionMode =
  | "explicit_parent"
  | "current_session"
  | "scope_latest_session"

export type RelayMode = "never" | "on_idle" | "on_completion" | "manual_only"

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
  relayState: "not_requested" | "pending" | "delivered" | "failed"
}

export interface JobResultSnapshot {
  jobID: string
  childSessionID: string
  state: "idle" | "completed" | "failed" | "aborted"
  headline: string
  summary: string
  blockers: string[]
  keyMessageIDs: string[]
  observedAt: number
}

export interface JobStatusResult {
  job: BackgroundJob
  result?: JobResultSnapshot
}

export interface JobStartArgs {
  title: string
  prompt: string
  parentSessionID?: string
  attach?: "auto" | "explicit_only"
  relayToParent?: RelayMode
}

export interface JobStartResult {
  jobID: string
  parentSessionID: string
  childSessionID: string
  state: "launching" | "running"
}

export interface JobListArgs {
  parentSessionID?: string
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
  sessionID?: string
  summary: string
}

export interface ToolCallerContext {
  sessionID?: string
  directory?: string
  worktree?: string
}

export interface ParentSessionResolution {
  mode: ParentResolutionMode
  sessionID: string
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
  partID?: string
  type: string
  text: string
  toolName?: string
}

export interface SessionTranscriptEntry {
  sessionID: string
  messageID: string
  role: string
  agent?: string
  createdAt: number
  parts: SessionTranscriptPart[]
}

export interface SessionSearchArgs {
  query: string
  sessionID?: string
  global?: boolean
  exact?: boolean
  limit?: number
}

export interface SessionSearchMatch {
  sessionID: string
  messageID: string
  partID?: string
  score: number
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
  sessionID: string
  entries: SessionTranscriptEntry[]
  includedChildSessionIDs: string[]
}

export interface SessionTreeNode {
  sessionID: string
  title?: string
  parentSessionID?: string
  status?: string
  children: SessionTreeNode[]
}

export interface SessionObserveResult {
  sessionID: string
  status?: string
  recentEvents: MissionControlEventRecord[]
  children?: Array<{
    sessionID: string
    status?: string
    title?: string
  }>
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
