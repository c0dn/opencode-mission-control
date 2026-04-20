import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, extname, join } from "node:path"

import { buildSessionChunks } from "./normalize.js"
import type { SourceSessionRecord } from "./source-db.js"
import type {
  MissionControlIndexStatus,
  SessionChunk,
  SessionDiscoveryScope,
  SessionTranscriptEntry,
} from "./types.js"

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

interface LoadedIndexCandidate {
  scope: SessionDiscoveryScope
  path: string
  index: SearchIndexDocument | undefined
}

interface DirtySessionStore {
  version: number
  sessions: Record<string, number>
}

const SUPPORTED_DISCOVERY_SCOPES: SessionDiscoveryScope[] = ["current_directory", "global_unscoped"]
const DIRTY_SESSION_STORE_VERSION = 1

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

const getMissionControlCacheRoot = (rootDir: string, scope: SessionDiscoveryScope = "current_directory") => {
  const xdgCache = process.env.XDG_CACHE_HOME?.trim()
  const home = process.env.HOME?.trim() || homedir()
  const baseDir = xdgCache || (home ? join(home, ".cache") : tmpdir())
  return join(baseDir, "opencode-mission-control", cachePartition(rootDir, scope))
}

const scopeKey = (rootDir: string) => createHash("sha1").update(rootDir || "default").digest("hex").slice(0, 16)

const cachePartition = (rootDir: string, scope: SessionDiscoveryScope) =>
  scope === "global_unscoped" ? "global_unscoped" : scopeKey(rootDir)

const resolveScopedIndexPath = (
  rootDir: string,
  configuredIndexPath: string | undefined,
  discoveryScope: SessionDiscoveryScope,
) => {
  if (configuredIndexPath) {
    return resolveConfiguredScopedIndexPath(configuredIndexPath, discoveryScope)
  }

  return join(getMissionControlCacheRoot(rootDir, discoveryScope), `search-index.${discoveryScope}.json`)
}

const resolveConfiguredScopedIndexPath = (filePath: string, scope: SessionDiscoveryScope) => {
  const normalizedExistingScope = getConfiguredScopeSuffix(filePath)

  if (!normalizedExistingScope) {
    return scope === "current_directory" ? filePath : addScopeSuffix(filePath, scope)
  }

  if (normalizedExistingScope === scope) {
    return filePath
  }

  return replaceScopeSuffix(filePath, normalizedExistingScope, scope)
}

const resolveDirtyStorePath = (
  rootDir: string,
  configuredIndexPath: string | undefined,
  scope: SessionDiscoveryScope,
) => {
  if (!configuredIndexPath) {
    return join(getMissionControlCacheRoot(rootDir, scope), `search-dirty.${scope}.json`)
  }

  return addScopedDirtySuffix(stripConfiguredScopeSuffix(configuredIndexPath), scope)
}

const addScopeSuffix = (filePath: string, scope: SessionDiscoveryScope) => {
  const extension = extname(filePath)
  if (!extension) {
    return `${filePath}.${scope}`
  }

  const baseName = basename(filePath, extension)
  return join(dirname(filePath), `${baseName}.${scope}${extension}`)
}

const replaceScopeSuffix = (filePath: string, fromScope: SessionDiscoveryScope, toScope: SessionDiscoveryScope) => {
  const extension = extname(filePath)
  if (!extension) {
    return filePath.endsWith(`.${fromScope}`)
      ? `${filePath.slice(0, -(`.${fromScope}`.length))}.${toScope}`
      : addScopeSuffix(filePath, toScope)
  }

  const baseName = basename(filePath, extension)
  if (!baseName.endsWith(`.${fromScope}`)) {
    return addScopeSuffix(filePath, toScope)
  }

  const strippedBaseName = baseName.slice(0, -(`.${fromScope}`.length))
  return join(dirname(filePath), `${strippedBaseName}.${toScope}${extension}`)
}

const getConfiguredScopeSuffix = (filePath: string): SessionDiscoveryScope | undefined => {
  for (const scope of SUPPORTED_DISCOVERY_SCOPES) {
    if (filePath.endsWith(`.${scope}`) || filePath.endsWith(`.${scope}${extname(filePath)}`)) {
      return scope
    }
  }

  return undefined
}

const stripConfiguredScopeSuffix = (filePath: string) => {
  const scope = getConfiguredScopeSuffix(filePath)
  return scope ? removeScopeSuffix(filePath, scope) : filePath
}

const removeScopeSuffix = (filePath: string, scope: SessionDiscoveryScope) => {
  const extension = extname(filePath)
  if (!extension) {
    return filePath.endsWith(`.${scope}`) ? filePath.slice(0, -(`.${scope}`.length)) : filePath
  }

  const baseName = basename(filePath, extension)
  if (!baseName.endsWith(`.${scope}`)) {
    return filePath
  }

  return join(dirname(filePath), `${baseName.slice(0, -(`.${scope}`.length))}${extension}`)
}

const addScopedDirtySuffix = (filePath: string, scope: SessionDiscoveryScope) => {
  const extension = extname(filePath)
  if (!extension) {
    return `${filePath}.dirty.${scope}`
  }

  const baseName = basename(filePath, extension)
  return join(dirname(filePath), `${baseName}.dirty.${scope}${extension}`)
}

const chooseLatestCandidate = (candidates: LoadedIndexCandidate[]) => {
  let latest: LoadedIndexCandidate | undefined

  for (const candidate of candidates) {
    if (!candidate.index) {
      continue
    }

    if (!latest || compareIndexFreshness(candidate.index, latest.index as SearchIndexDocument) >= 0) {
      latest = candidate
    }
  }

  return latest
}

const INDEX_LOCKS = new Map<string, Promise<void>>()

const withPathLock = async <T>(path: string, action: () => Promise<T>): Promise<T> => {
  const previous = INDEX_LOCKS.get(path) ?? Promise.resolve()
  let release = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  INDEX_LOCKS.set(path, previous.then(() => current))

  await previous
  try {
    return await action()
  } finally {
    release()
    if (INDEX_LOCKS.get(path) === current) {
      INDEX_LOCKS.delete(path)
    }
  }
}

const mergeIndexDocuments = (
  current: SearchIndexDocument | undefined,
  incoming: SearchIndexDocument,
): SearchIndexDocument => {
  if (!current) {
    return incoming
  }

  const base = compareIndexFreshness(current, incoming) > 0 ? current : incoming
  const overlay = base === current ? incoming : current

  return {
    ...base,
    semantic: mergeSemanticState(base.semantic, overlay.semantic, base.chunks),
  }
}

const compareIndexFreshness = (left: SearchIndexDocument, right: SearchIndexDocument) => {
  const leftSnapshotAt = left.snapshotAt ?? left.builtAt ?? 0
  const rightSnapshotAt = right.snapshotAt ?? right.builtAt ?? 0
  if (leftSnapshotAt !== rightSnapshotAt) {
    return leftSnapshotAt - rightSnapshotAt
  }

  return (left.builtAt ?? 0) - (right.builtAt ?? 0)
}

const mergeSemanticState = (
  base: SearchIndexDocument["semantic"],
  overlay: SearchIndexDocument["semantic"],
  chunks: SessionChunk[],
) => {
  if (!base) {
    return overlay ? pruneSemanticState(overlay, chunks) : overlay
  }

  if (!overlay) {
    return pruneSemanticState(base, chunks)
  }

  if (base.signature !== overlay.signature) {
    return pruneSemanticState(base, chunks)
  }

  return pruneSemanticState({
    ...base,
    builtAt: Math.max(base.builtAt ?? 0, overlay.builtAt ?? 0),
    fingerprints: {
      ...(overlay.fingerprints ?? {}),
      ...(base.fingerprints ?? {}),
    },
    vectors: {
      ...(overlay.vectors ?? {}),
      ...(base.vectors ?? {}),
    },
    queries: mergeSemanticQueries(base.queries, overlay.queries),
  }, chunks)
}

const pruneSemanticState = (semantic: NonNullable<SearchIndexDocument["semantic"]>, chunks: SessionChunk[]) => {
  const currentFingerprints = Object.fromEntries(chunks.map((chunk) => [chunk.chunkID, fingerprintText(chunk.text)]))

  return {
    ...semantic,
    fingerprints: Object.fromEntries(
      Object.entries(semantic.fingerprints ?? {}).filter(
        ([chunkID, fingerprint]) => currentFingerprints[chunkID] === fingerprint,
      ),
    ),
    vectors: Object.fromEntries(
      Object.entries(semantic.vectors ?? {}).filter(
        ([chunkID]) => currentFingerprints[chunkID] === semantic.fingerprints?.[chunkID],
      ),
    ),
    queries: trimMergedSemanticQueries(semantic.queries ?? {}),
  }
}

const fingerprintText = (text: string) => {
  let hash = 2166136261

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return `fnv1a:${hash >>> 0}:${text.length}`
}

const mergeSemanticQueries = (
  baseQueries:
    | NonNullable<NonNullable<SearchIndexDocument["semantic"]>["queries"]>
    | undefined,
  overlayQueries:
    | NonNullable<NonNullable<SearchIndexDocument["semantic"]>["queries"]>
    | undefined,
) => {
  const merged = new Map<string, { text: string; vector: number[]; updatedAt: number }>()

  for (const [key, value] of Object.entries(overlayQueries ?? {})) {
    if (value) {
      merged.set(key, value)
    }
  }

  for (const [key, value] of Object.entries(baseQueries ?? {})) {
    if (!value) {
      continue
    }

    const previous = merged.get(key)
    if (!previous || (value.updatedAt ?? 0) >= (previous.updatedAt ?? 0)) {
      merged.set(key, value)
    }
  }

  return trimMergedSemanticQueries(Object.fromEntries(merged))
}

const trimMergedSemanticQueries = (
  queries: NonNullable<NonNullable<SearchIndexDocument["semantic"]>["queries"]>,
) => {
  const entries = Object.entries(queries)
  if (entries.length <= 128) {
    return queries
  }

  return Object.fromEntries(
    entries.sort((left, right) => (right[1]?.updatedAt ?? 0) - (left[1]?.updatedAt ?? 0)).slice(0, 128),
  )
}

const buildCursors = (sessions: SourceSessionRecord[], indexedAt: number): SearchIndexSessionCursor[] =>
  sessions.map((session) => ({
    sessionID: session.sessionID,
    sessionUpdatedAt: session.updatedAt,
    indexedAt,
  }))
