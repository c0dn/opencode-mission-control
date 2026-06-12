import { readFile } from "node:fs/promises"

import { buildSessionChunks } from "./normalize.js"
import type { SourceSessionRecord } from "./source-db.js"
import { openMissionControlSqliteDatabase, type MissionControlSqliteDatabase } from "./storage/sqlite.js"
import { resolveMissionControlSqliteCachePath } from "./storage/sqlite-paths.js"
import type {
  MissionControlIndexStatus,
  NativeVectorBackendName,
  SessionDiscoveryScope,
  SessionTranscriptEntry,
  VectorBackendPreference,
} from "./types.js"
import { withPathLock } from "./index-db/locks.js"
import { buildCursors, chooseLatestCandidate, mergeIndexDocuments } from "./index-db/merge.js"
import { resolveDirtyStorePath, resolveScopedIndexPath, SUPPORTED_DISCOVERY_SCOPES } from "./index-db/paths.js"
import { SqliteSearchIndexStore } from "./index-db/sqlite-store.js"
import {
  DIRTY_SESSION_STORE_VERSION,
  type DirtySessionStore,
  type LoadedIndexCandidate,
  type SearchIndexDocument,
} from "./index-db/types.js"

export type { SearchIndexDocument, SearchIndexSessionCursor } from "./index-db/types.js"

export interface MissionControlIndexDBOptions {
  vectorExtensionPaths?: Partial<Record<NativeVectorBackendName, string>>
  vectorBackend?: VectorBackendPreference
  workspaceKey?: string
}

export class MissionControlIndexDB {
  private static readonly VERSION = 7
  private readonly sqliteByPath = new Map<string, MissionControlSqliteDatabase>()
  private readonly storeByPath = new Map<string, SqliteSearchIndexStore>()

  constructor(
    private readonly rootDir: string,
    private readonly configuredIndexPath?: string,
    private readonly discoveryScope?: SessionDiscoveryScope,
    private readonly options: MissionControlIndexDBOptions = {},
  ) {}

  getIndexPath(scope = this.discoveryScope ?? "current_directory") {
    return resolveMissionControlSqliteCachePath(this.rootDir, scope, this.configuredIndexPath, this.options.workspaceKey)
  }

  async load(scope = this.discoveryScope): Promise<SearchIndexDocument | undefined> {
    try {
      if (!scope) {
        return (await this.loadLatestWithPath()).index
      }

      return (await this.loadForScope(scope)).index
    } finally {
      this.close()
    }
  }

  async readStatus(): Promise<Omit<MissionControlIndexStatus, "dirtySessionCount">> {
    try {
      const loaded = this.discoveryScope ? await this.loadForScope(this.discoveryScope) : await this.loadLatestWithPath()
      return this.toStatus(loaded.index, loaded.path)
    } finally {
      this.close()
    }
  }

  async readDirtySessionIDs(filter?: Iterable<string>) {
    try {
      const snapshot = await this.readDirtySessionsInternal(filter)
      return Object.keys(snapshot)
    } finally {
      this.close()
    }
  }

  async readDirtySessions(filter?: Iterable<string>) {
    try {
      return await this.readDirtySessionsInternal(filter)
    } finally {
      this.close()
    }
  }

  async markDirtySessions(sessionIDs: Iterable<string>) {
    try {
      const nextIDs = Array.from(new Set(sessionIDs)).filter(Boolean)
      if (nextIDs.length === 0) {
        return
      }

      for (const scope of this.getDirtyStoreScopes()) {
        await withPathLock(this.getIndexPath(scope), async () => {
          await this.importLegacyDirtyStoreIfNeeded(scope)
          this.store(scope).markDirtySessions(scope, nextIDs)
        })
      }
    } finally {
      this.close()
    }
  }

  async clearDirtySessionsUpTo(dirtySessions: Record<string, number>) {
    try {
      const entries = Object.entries(dirtySessions).filter((entry) => typeof entry[0] === "string" && entry[0].length > 0)
      if (entries.length === 0) {
        return
      }

      for (const scope of this.getDirtyStoreScopes()) {
        await withPathLock(this.getIndexPath(scope), async () => {
          await this.importLegacyDirtyStoreIfNeeded(scope)
          this.store(scope).clearDirtySessionsUpTo(scope, Object.fromEntries(entries))
        })
      }
    } finally {
      this.close()
    }
  }

  async write(
    sessions: SourceSessionRecord[],
    entries: SessionTranscriptEntry[],
    settings: SearchIndexDocument["settings"],
    discovery: SearchIndexDocument["discovery"],
    snapshotAt: number,
  ) {
    try {
      const builtAt = Date.now()
      const index: SearchIndexDocument = {
        version: MissionControlIndexDB.VERSION,
        builtAt,
        snapshotAt,
        discovery,
        settings,
        sessions,
        cursors: buildCursors(sessions, builtAt),
        chunks: buildSessionChunks(sessions, entries),
      }

      return this.saveInternal(index)
    } finally {
      this.close()
    }
  }

  async writeWithExistingSemantic(
    sessions: SourceSessionRecord[],
    entries: SessionTranscriptEntry[],
    settings: SearchIndexDocument["settings"],
    discovery: SearchIndexDocument["discovery"],
    semantic: SearchIndexDocument["semantic"],
    snapshotAt: number,
  ) {
    try {
      const builtAt = Date.now()
      const index: SearchIndexDocument = {
        version: MissionControlIndexDB.VERSION,
        builtAt,
        snapshotAt,
        discovery,
        settings,
        sessions,
        cursors: buildCursors(sessions, builtAt),
        chunks: buildSessionChunks(sessions, entries),
        semantic,
      }

      return this.saveInternal(index)
    } finally {
      this.close()
    }
  }

  async save(index: SearchIndexDocument) {
    try {
      return await this.saveInternal(index)
    } finally {
      this.close()
    }
  }

  async queryFtsCandidates(options: Parameters<SqliteSearchIndexStore["queryFtsCandidates"]>[0]) {
    try {
      return this.store(options.scope).queryFtsCandidates(options)
    } finally {
      this.close()
    }
  }

  async querySemanticCandidates(options: {
    scope: SessionDiscoveryScope
    signature: string
    queryVector: number[]
    limit?: number
    sessionIDs?: Iterable<string>
    vectorBackend?: VectorBackendPreference
  }) {
    try {
      return this.store(options.scope).querySemanticCandidates(options)
    } finally {
      this.close()
    }
  }

  close() {
    for (const sqlite of this.sqliteByPath.values()) {
      sqlite.close()
    }
    this.sqliteByPath.clear()
    this.storeByPath.clear()
  }

  dispose() {
    this.close()
  }

  private async readDirtySessionsInternal(filter?: Iterable<string>) {
    const scopes = this.getDirtyStoreScopes()
    for (const scope of scopes) {
      await this.importLegacyDirtyStoreIfNeeded(scope)
    }

    const combined = Object.assign({}, ...scopes.map((scope) => this.store(scope).readDirtySessions(scope))) as Record<string, number>
    const sessionIDs = Object.keys(combined)
    if (!filter) {
      return combined
    }

    const allowed = new Set(filter)
    return Object.fromEntries(sessionIDs.filter((sessionID) => allowed.has(sessionID)).map((sessionID) => [sessionID, combined[sessionID] ?? 0]))
  }

  private async saveInternal(index: SearchIndexDocument) {
    const indexPath = this.getIndexPath(index.discovery.scope)
    return withPathLock(indexPath, async () => {
      await this.loadSqliteOrImportLegacyIndex(index.discovery.scope)
      return this.store(index.discovery.scope).saveMergedSnapshot(index, mergeIndexDocuments)
    })
  }

  toStatus(index: SearchIndexDocument | undefined, path = this.getIndexPath(index?.discovery.scope ?? this.discoveryScope ?? "current_directory")): Omit<MissionControlIndexStatus, "dirtySessionCount"> {
    return {
      path,
      builtAt: index?.builtAt,
      discoveryScope: index?.discovery.scope,
      discoveryDirectory: index?.discovery.directory,
      discoveryWorkspaceID: index?.discovery.workspaceID,
      indexedSessionCount: index?.sessions.length,
      includeToolOutputsForIndexing: index?.settings.includeToolOutputsForIndexing ?? false,
      semanticSignature: index?.semantic?.signature,
    }
  }

  isFresh(
    existing: SearchIndexDocument | undefined,
    sessions: SourceSessionRecord[],
    settings: SearchIndexDocument["settings"],
    discovery: SearchIndexDocument["discovery"],
  ) {
    if (!existing) {
      return false
    }

    if (
      existing.discovery.scope !== discovery.scope ||
      existing.discovery.directory !== discovery.directory ||
      existing.discovery.workspaceID !== discovery.workspaceID
    ) {
      return false
    }

    if (existing.settings.includeToolOutputsForIndexing !== settings.includeToolOutputsForIndexing) {
      return false
    }

    if (existing.sessions.length !== sessions.length) {
      return false
    }

    const existingByID = new Map(existing.sessions.map((session) => [session.sessionID, session.updatedAt]))
    for (const session of sessions) {
      if (existingByID.get(session.sessionID) !== session.updatedAt) {
        return false
      }
    }

    return true
  }

  private async loadForScope(scope: SessionDiscoveryScope): Promise<LoadedIndexCandidate> {
    const path = this.getIndexPath(scope)
    return {
      scope,
      path,
      index: await this.loadSqliteOrImportLegacyIndex(scope),
    }
  }

  private async loadLatestWithPath(): Promise<LoadedIndexCandidate> {
    const candidates = await Promise.all(
      SUPPORTED_DISCOVERY_SCOPES.map((scope) => this.loadForScope(scope)),
    )

    return (
      chooseLatestCandidate(candidates) ?? {
        scope: "current_directory",
        path: this.getIndexPath("current_directory"),
        index: undefined,
      }
    )
  }

  private async loadDirtyStore(path: string): Promise<DirtySessionStore> {
    try {
      const content = await readFile(path, "utf8")
      const parsed = JSON.parse(content) as DirtySessionStore
      if (parsed.version !== DIRTY_SESSION_STORE_VERSION || !parsed.sessions || typeof parsed.sessions !== "object") {
        return {
          version: DIRTY_SESSION_STORE_VERSION,
          sessions: {},
        }
      }

      return parsed
    } catch {
      return {
        version: DIRTY_SESSION_STORE_VERSION,
        sessions: {},
      }
    }
  }

  private getDirtyStoreScopes() {
    return this.discoveryScope
      ? [this.discoveryScope]
      : SUPPORTED_DISCOVERY_SCOPES
  }

  private async loadSqliteOrImportLegacyIndex(scope: SessionDiscoveryScope): Promise<SearchIndexDocument | undefined> {
    const existing = this.store(scope).loadScopedSnapshot(scope)
    if (existing) {
      return existing
    }

    const legacy = await this.loadLegacyIndex(scope)
    if (legacy) {
      return this.store(scope).importLegacySnapshotIfAbsent(scope, legacy)
    }

    return undefined
  }

  private async loadLegacyIndex(scope: SessionDiscoveryScope): Promise<SearchIndexDocument | undefined> {
    try {
      const path = resolveScopedIndexPath(this.rootDir, this.configuredIndexPath, scope, this.options.workspaceKey)
      const content = await readFile(path, "utf8")
      const parsed = JSON.parse(content) as SearchIndexDocument
      if (parsed.version !== MissionControlIndexDB.VERSION || parsed.discovery?.scope !== scope) {
        return undefined
      }

      return { ...parsed, version: MissionControlIndexDB.VERSION }
    } catch {
      return undefined
    }
  }

  private async importLegacyDirtyStoreIfNeeded(scope: SessionDiscoveryScope) {
    const store = this.store(scope)
    if (store.hasLegacyImport("dirty", scope)) {
      return
    }

    const path = resolveDirtyStorePath(this.rootDir, this.configuredIndexPath, scope, this.options.workspaceKey)
    const snapshot = await this.loadDirtyStore(path)
    store.importLegacyDirtySessionsOnce(scope, snapshot.sessions)
  }

  private store(scope = this.discoveryScope ?? "current_directory") {
    const path = this.getIndexPath(scope)
    const existing = this.storeByPath.get(path)
    if (existing) {
      return existing
    }

    const sqlite = openMissionControlSqliteDatabase(path, {
      extensions: this.options.vectorExtensionPaths,
    })
    const store = new SqliteSearchIndexStore({ sqlite, vectorBackend: this.options.vectorBackend })
    store.ensureSchema()
    this.sqliteByPath.set(path, sqlite)
    this.storeByPath.set(path, store)
    return store
  }
}
