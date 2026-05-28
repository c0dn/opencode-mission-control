export type SearchMode = "lexical" | "semantic" | "hybrid"
export type SemanticProviderName = "disabled" | "jina"
export type SessionDiscoveryScope = "current_directory" | "global_unscoped"
export type VectorBackendName = "vec1" | "sqlite-vec" | "blob-scan"
export type VectorBackendPreference = "auto" | VectorBackendName
export type NativeVectorBackendName = Exclude<VectorBackendName, "blob-scan">

export type MissionControlToolSurface = "full" | "inspect-only"

export type MissionControlErrorCode =
  | "SessionNotFound"
  | "SearchIndexUnavailable"
  | "SemanticSearchDisabled"
  | "GlobalSessionDiscoveryUnavailable"
  | "IndexScopeMismatch"
  | "CurrentSessionUnavailable"
  | "SessionLookupUnavailable"
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
    vectorBackend: VectorBackendPreference
    vectorExtensionPaths?: Partial<Record<NativeVectorBackendName, string>>
    vectorSearchLimit: number
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
  tools: {
    surface: MissionControlToolSurface
  }
  debug: {
    enabled: boolean
    filePath?: string
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
    sessionGet: boolean
    sessionFind: boolean
    sessionRead: boolean
    sessionTail: boolean
    sessionTree: boolean
    indexedRetrieval: boolean
    semanticRetrieval: boolean
  }
  observe: {
    liveEvents: boolean
    recentBuffer: boolean
  }
  terminals?: {
    zellij: boolean
    syntheticNotifications: boolean
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
  workspaceID?: string
  createdAt?: number
  updatedAt?: number
  observedAt: number
}

export interface MissionControlIndexStatus {
  path: string
  builtAt?: number
  discoveryScope?: SessionDiscoveryScope
  discoveryDirectory?: string
  discoveryWorkspaceID?: string
  indexedSessionCount?: number
  includeToolOutputsForIndexing: boolean
  semanticSignature?: string
  dirtySessionCount: number
}

export interface MissionControlStatus {
  name: string
  startedAt: number
  directory: string
  workspaceID?: string
  implemented: {
    sessionRead: boolean
    sessionGet: boolean
    sessionFind: boolean
    sessionTail: boolean
      sessionTree: boolean
      sessionObserve: boolean
       sessionSearch: boolean
       terminalTools?: boolean
  }
  config: MissionControlConfig
  counters: {
    totalEvents: number
    byType: Record<string, number>
  }
  capabilities: MissionControlCapabilityMatrix
  index: MissionControlIndexStatus
  recentEvents: MissionControlEventRecord[]
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
  scope?: "local" | "global"
  exact?: boolean
  limit?: number
}

export interface SessionMetadata {
  sessionId: string
  title: string
  directory?: string
  workspaceID?: string
  parentSessionId?: string
  createdAt?: number
  updatedAt?: number
  status?: string
}

export interface SessionGetArgs {
  sessionId: string
}

export interface SessionGetResult {
  session: SessionMetadata
}

export interface SessionFindArgs {
  title: string
  scope?: "local" | "global"
  limit?: number
}

export interface SessionFindResult {
  title: string
  scope: "local" | "global"
  candidates: SessionMetadata[]
  ambiguous: boolean
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
  discoveryWorkspaceID?: string
  indexedSessionCount: number
  warnings: string[]
  matches: SessionSearchMatch[]
}

export interface MissionControlPluginOptions {
  search?: Partial<MissionControlConfig["search"]> & {
    jinaApiKey?: string
  }
  observe?: Partial<MissionControlConfig["observe"]>
  tools?: Partial<MissionControlConfig["tools"]>
  debug?: Partial<MissionControlConfig["debug"]>
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
  offset: number
  hasMore: boolean
  nextOffset?: number
  totalEntries: number
  totalEntriesExact: boolean
}

export interface SessionTailEntry {
  sessionId: string
  messageId: string
  role: string
  agent?: string
  createdAt: number
  text: string
}

export interface SessionTailResult {
  sessionId: string
  entries: SessionTailEntry[]
  includedChildSessionIds: string[]
  offset: number
  hasMore: boolean
  nextOffset?: number
  totalEntries: number
  totalEntriesExact: boolean
}

export interface SessionTreeNode {
  sessionId: string
  title?: string
  parentSessionId?: string
  workspaceID?: string
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

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export { fail, ok } from "./types/tool-result.js"
