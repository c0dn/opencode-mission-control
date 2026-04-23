import type { SourceSessionRecord } from "../source-db.js"
import type { SessionChunk, SessionDiscoveryScope } from "../types.js"

export interface SearchIndexDocument {
  version: number
  builtAt: number
  snapshotAt: number
  discovery: {
    scope: SessionDiscoveryScope
    directory?: string
  }
  settings: {
    includeToolOutputsForIndexing: boolean
  }
  sessions: SourceSessionRecord[]
  cursors: SearchIndexSessionCursor[]
  chunks: SessionChunk[]
  semantic?: {
    signature: string
    builtAt: number
    fingerprints: Record<string, string>
    vectors: Record<string, number[]>
    queries?: Record<
      string,
      {
        text: string
        vector: number[]
        updatedAt: number
      }
    >
  }
}

export interface SearchIndexSessionCursor {
  sessionID: string
  sessionUpdatedAt: number
  indexedAt: number
}

export interface LoadedIndexCandidate {
  scope: SessionDiscoveryScope
  path: string
  index: SearchIndexDocument | undefined
}

export interface DirtySessionStore {
  version: number
  sessions: Record<string, number>
}

export const DIRTY_SESSION_STORE_VERSION = 1
