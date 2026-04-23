import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { buildSessionChunks } from "./normalize.js"
import type { SourceSessionRecord } from "./source-db.js"
import type {
  MissionControlIndexStatus,
  SessionDiscoveryScope,
  SessionTranscriptEntry,
} from "./types.js"
import { withPathLock } from "./index-db/locks.js"
import { buildCursors, chooseLatestCandidate, mergeIndexDocuments } from "./index-db/merge.js"
import { resolveDirtyStorePath, resolveScopedIndexPath, SUPPORTED_DISCOVERY_SCOPES } from "./index-db/paths.js"
import {
  DIRTY_SESSION_STORE_VERSION,
  type DirtySessionStore,
  type LoadedIndexCandidate,
  type SearchIndexDocument,
} from "./index-db/types.js"

export type { SearchIndexDocument, SearchIndexSessionCursor } from "./index-db/types.js"

export class MissionControlIndexDB {
  private static readonly VERSION = 5

  constructor(
    private readonly rootDir: string,
    private readonly configuredIndexPath?: string,
    private readonly discoveryScope?: SessionDiscoveryScope,
  ) {}

  getIndexPath(scope = this.discoveryScope ?? "current_directory") {
    return resolveScopedIndexPath(this.rootDir, this.configuredIndexPath, scope)
  }

  async load(scope = this.discoveryScope): Promise<SearchIndexDocument | undefined> {
    if (!scope) {
      return (await this.loadLatestWithPath()).index
    }

    return (await this.loadForScope(scope)).index
  }

  async readStatus(): Promise<Omit<MissionControlIndexStatus, "dirtySessionCount">> {
    const loaded = this.discoveryScope ? await this.loadForScope(this.discoveryScope) : await this.loadLatestWithPath()
    return this.toStatus(loaded.index, loaded.path)
  }

  async readDirtySessionIDs(filter?: Iterable<string>) {
    const snapshot = await this.readDirtySessions(filter)
    return Object.keys(snapshot)
  }

  async readDirtySessions(filter?: Iterable<string>) {
    const snapshots = await Promise.all(this.getDirtyStorePaths().map((path) => this.loadDirtyStore(path)))
    const combined = Object.assign({}, ...snapshots.map((snapshot) => snapshot.sessions)) as Record<string, number>
    const sessionIDs = Object.keys(combined)
    if (!filter) {
      return combined
    }

    const allowed = new Set(filter)
    return Object.fromEntries(sessionIDs.filter((sessionID) => allowed.has(sessionID)).map((sessionID) => [sessionID, combined[sessionID] ?? 0]))
  }

  async markDirtySessions(sessionIDs: Iterable<string>) {
    const nextIDs = Array.from(new Set(sessionIDs)).filter(Boolean)
    if (nextIDs.length === 0) {
      return
    }

    for (const path of this.getDirtyStorePaths()) {
      await withPathLock(path, async () => {
        const snapshot = await this.loadDirtyStore(path)
        const markedAt = Date.now()
        for (const sessionID of nextIDs) {
          snapshot.sessions[sessionID] = Math.max((snapshot.sessions[sessionID] ?? 0) + 1, markedAt)
        }

        await this.saveDirtyStore(snapshot, path)
      })
    }
  }

  async clearDirtySessionsUpTo(dirtySessions: Record<string, number>) {
    const entries = Object.entries(dirtySessions).filter((entry) => typeof entry[0] === "string" && entry[0].length > 0)
    if (entries.length === 0) {
      return
    }

    for (const path of this.getDirtyStorePaths()) {
      await withPathLock(path, async () => {
        const snapshot = await this.loadDirtyStore(path)
        let mutated = false

        for (const [sessionID, dirtyAt] of entries) {
          if ((snapshot.sessions[sessionID] ?? 0) <= dirtyAt) {
            delete snapshot.sessions[sessionID]
            mutated = true
          }
        }

        if (mutated) {
          await this.saveDirtyStore(snapshot, path)
        }
      })
    }
  }

  async write(
    sessions: SourceSessionRecord[],
    entries: SessionTranscriptEntry[],
    settings: SearchIndexDocument["settings"],
    discovery: SearchIndexDocument["discovery"],
    snapshotAt: number,
  ) {
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

    return this.save(index)
  }

  async writeWithExistingSemantic(
    sessions: SourceSessionRecord[],
    entries: SessionTranscriptEntry[],
    settings: SearchIndexDocument["settings"],
    discovery: SearchIndexDocument["discovery"],
    semantic: SearchIndexDocument["semantic"],
    snapshotAt: number,
  ) {
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

    return this.save(index)
  }

  async save(index: SearchIndexDocument) {
    const indexPath = this.getIndexPath()
    return withPathLock(indexPath, async () => {
      const current = await this.loadIndexAtPath(indexPath)
      const merged = mergeIndexDocuments(current, index)
      await mkdir(dirname(indexPath), { recursive: true })
      await writeFile(indexPath, JSON.stringify(merged, null, 2), "utf8")
      return merged
    })
  }

  toStatus(index: SearchIndexDocument | undefined, path = this.getIndexPath(index?.discovery.scope ?? this.discoveryScope ?? "current_directory")): Omit<MissionControlIndexStatus, "dirtySessionCount"> {
    return {
      path,
      builtAt: index?.builtAt,
      discoveryScope: index?.discovery.scope,
      discoveryDirectory: index?.discovery.directory,
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

    if (existing.discovery.scope !== discovery.scope || existing.discovery.directory !== discovery.directory) {
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
      index: await this.loadIndexAtPath(path),
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

  private async saveDirtyStore(snapshot: DirtySessionStore, path: string) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(snapshot, null, 2), "utf8")
  }

  private getDirtyStorePaths() {
    return this.discoveryScope
      ? [resolveDirtyStorePath(this.rootDir, this.configuredIndexPath, this.discoveryScope)]
      : SUPPORTED_DISCOVERY_SCOPES.map((scope) => resolveDirtyStorePath(this.rootDir, this.configuredIndexPath, scope))
  }

  private async loadIndexAtPath(path: string): Promise<SearchIndexDocument | undefined> {
    try {
      const content = await readFile(path, "utf8")
      const parsed = JSON.parse(content) as SearchIndexDocument
      if (parsed.version !== MissionControlIndexDB.VERSION) {
        return undefined
      }

      return parsed
    } catch {
      return undefined
    }
  }
}
