import type { Database } from "bun:sqlite"

import { dot } from "../search/fingerprint.js"
import type { SourceSessionRecord } from "../source-db.js"
import type { MissionControlSqliteDatabase } from "../storage/sqlite.js"
import type { NativeVectorBackendName, SessionChunk, SessionDiscoveryScope, VectorBackendName, VectorBackendPreference } from "../types.js"
import type { SearchIndexDocument, SearchIndexSessionCursor } from "./types.js"

export interface SqliteSearchStoreOptions {
  sqlite: MissionControlSqliteDatabase | Database
  vectorBackend?: VectorBackendPreference
}

export interface FtsCandidateQueryOptions {
  scope: SessionDiscoveryScope
  query: string
  limit?: number
  sessionIDs?: Iterable<string>
}

export interface FtsCandidate {
  chunkID: string
  sessionID: string
  rank: number
}

export interface SemanticCandidateQueryOptions {
  scope: SessionDiscoveryScope
  signature: string
  queryVector: number[]
  limit?: number
  sessionIDs?: Iterable<string>
  vectorBackend?: VectorBackendPreference
}

export interface SemanticCandidate {
  chunkID: string
  score: number
  backend: VectorBackendName
}

type BindValue = string | number | null

const SEARCH_SCHEMA_MIGRATION_ID = "search-index-store-v1"
const DEFAULT_FTS_LIMIT = 100

export class SqliteSearchIndexStore {
  private readonly database: Database
  private readonly sqlite?: MissionControlSqliteDatabase
  private readonly vectorBackend: VectorBackendPreference

  constructor(options: SqliteSearchStoreOptions) {
    this.database = "database" in options.sqlite ? options.sqlite.database : options.sqlite
    this.sqlite = "database" in options.sqlite ? options.sqlite : undefined
    this.vectorBackend = options.vectorBackend ?? "auto"
  }

  ensureSchema() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS index_state (
        scope TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        built_at INTEGER NOT NULL,
        snapshot_at INTEGER NOT NULL,
        discovery_directory TEXT,
        discovery_workspace_id TEXT,
        include_tool_outputs_for_indexing INTEGER NOT NULL,
        settings_json TEXT NOT NULL,
        semantic_signature TEXT,
        semantic_built_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS sessions (
        scope TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        directory TEXT,
        workspace_id TEXT,
        parent_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, session_id)
      );

      CREATE TABLE IF NOT EXISTS session_cursors (
        scope TEXT NOT NULL,
        session_id TEXT NOT NULL,
        session_updated_at INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        PRIMARY KEY (scope, session_id),
        FOREIGN KEY (scope, session_id) REFERENCES sessions(scope, session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chunks (
        scope TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        part_id TEXT,
        parent_session_id TEXT,
        role TEXT NOT NULL,
        part_type TEXT NOT NULL,
        agent TEXT,
        tool_name TEXT,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (scope, chunk_id),
        FOREIGN KEY (scope, session_id) REFERENCES sessions(scope, session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS dirty_sessions (
        scope TEXT NOT NULL,
        session_id TEXT NOT NULL,
        dirty_at INTEGER NOT NULL,
        PRIMARY KEY (scope, session_id)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        scope UNINDEXED,
        chunk_id UNINDEXED,
        session_id UNINDEXED,
        text
      );

      CREATE TABLE IF NOT EXISTS semantic_collections (
        scope TEXT NOT NULL,
        signature TEXT NOT NULL,
        built_at INTEGER NOT NULL,
        PRIMARY KEY (scope, signature)
      );

      CREATE TABLE IF NOT EXISTS semantic_vector_meta (
        scope TEXT NOT NULL,
        signature TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        vector_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, signature, chunk_id),
        FOREIGN KEY (scope, signature) REFERENCES semantic_collections(scope, signature) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS semantic_query_cache (
        scope TEXT NOT NULL,
        signature TEXT NOT NULL,
        query_key TEXT NOT NULL DEFAULT '',
        query_text TEXT NOT NULL,
        vector_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, signature, query_text),
        FOREIGN KEY (scope, signature) REFERENCES semantic_collections(scope, signature) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS legacy_imports (
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        imported_at INTEGER NOT NULL,
        PRIMARY KEY (kind, scope)
      );

      CREATE TABLE IF NOT EXISTS index_leases (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)

    this.database
      .prepare("INSERT OR REPLACE INTO schema_migrations (id, applied_at) VALUES (?, ?)")
      .run(SEARCH_SCHEMA_MIGRATION_ID, Date.now())
    this.ensureColumn("semantic_vector_meta", "vector_json", "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn("semantic_query_cache", "query_key", "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn("semantic_query_cache", "vector_json", "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn("index_state", "discovery_workspace_id", "TEXT")
    this.ensureColumn("sessions", "workspace_id", "TEXT")
  }

  replaceScopedSnapshot(index: SearchIndexDocument) {
    this.ensureSchema()
    this.transaction(() => {
      this.writeSnapshotRows(index)
    })
  }

  importLegacySnapshotIfAbsent(scope: SessionDiscoveryScope, legacy: SearchIndexDocument): SearchIndexDocument {
    this.ensureSchema()
    return this.transaction(() => {
      const current = this.loadScopedSnapshotRows(scope)
      if (current) {
        return current
      }

      this.writeSnapshotRows(legacy)
      return legacy
    })
  }

  saveMergedSnapshot(index: SearchIndexDocument, merge: (current: SearchIndexDocument | undefined, next: SearchIndexDocument) => SearchIndexDocument) {
    this.ensureSchema()
    return this.transaction(() => {
      const current = this.loadScopedSnapshotRows(index.discovery.scope)
      const merged = merge(current, index)
      this.writeSnapshotRows(merged)
      return merged
    })
  }

  loadScopedSnapshot(scope: SessionDiscoveryScope): SearchIndexDocument | undefined {
    this.ensureSchema()
    return this.loadScopedSnapshotRows(scope)
  }

  private loadScopedSnapshotRows(scope: SessionDiscoveryScope): SearchIndexDocument | undefined {
    const state = this.database.prepare("SELECT * FROM index_state WHERE scope = ?").get(scope) as IndexStateRow | undefined
    if (!state) {
      return undefined
    }

    const sessions = this.database
      .prepare("SELECT * FROM sessions WHERE scope = ? ORDER BY updated_at ASC, session_id ASC")
      .all(scope) as SessionRow[]
    const cursors = this.database
      .prepare("SELECT * FROM session_cursors WHERE scope = ? ORDER BY session_id ASC")
      .all(scope) as CursorRow[]
    const chunks = this.database
      .prepare("SELECT * FROM chunks WHERE scope = ? ORDER BY created_at ASC, chunk_id ASC")
      .all(scope) as ChunkRow[]

    const document: SearchIndexDocument = {
      version: state.version,
      builtAt: state.built_at,
      snapshotAt: state.snapshot_at,
      discovery: {
        scope,
        directory: state.discovery_directory ?? undefined,
        workspaceID: state.discovery_workspace_id ?? undefined,
      },
      settings: parseJsonSettings(state.settings_json, Boolean(state.include_tool_outputs_for_indexing)),
      sessions: sessions.map(toSessionRecord),
      cursors: cursors.map(toCursorRecord),
      chunks: chunks.map(toChunkRecord),
    }

    if (state.semantic_signature && state.semantic_built_at !== null) {
      const vectorMeta = this.database
        .prepare("SELECT chunk_id, fingerprint, vector_json FROM semantic_vector_meta WHERE scope = ? AND signature = ? ORDER BY chunk_id ASC")
        .all(scope, state.semantic_signature) as VectorMetaRow[]
      const queryMeta = this.database
        .prepare("SELECT query_key, query_text, vector_json, updated_at FROM semantic_query_cache WHERE scope = ? AND signature = ? ORDER BY query_key ASC, query_text ASC")
        .all(scope, state.semantic_signature) as QueryMetaRow[]

      document.semantic = {
        signature: state.semantic_signature,
        builtAt: state.semantic_built_at,
        fingerprints: Object.fromEntries(vectorMeta.map((row) => [row.chunk_id, row.fingerprint])),
        vectors: Object.fromEntries(vectorMeta.map((row) => [row.chunk_id, parseNumberArray(row.vector_json)])),
        queries: Object.fromEntries(
          queryMeta.map((row) => [
            row.query_key || row.query_text,
            {
              text: row.query_text,
              vector: parseNumberArray(row.vector_json),
              updatedAt: row.updated_at,
            },
          ]),
        ),
      }
    }

    return document
  }

  markDirtySessions(scope: SessionDiscoveryScope, sessionIDs: Iterable<string>, dirtyAt = Date.now()) {
    this.ensureSchema()
    const uniqueIDs = Array.from(new Set(sessionIDs)).filter(Boolean)
    if (uniqueIDs.length === 0) {
      return
    }

    const statement = this.database.prepare(`
      INSERT INTO dirty_sessions (scope, session_id, dirty_at) VALUES (?, ?, ?)
      ON CONFLICT(scope, session_id) DO UPDATE SET dirty_at = max(dirty_sessions.dirty_at + 1, excluded.dirty_at)
    `)
    this.transaction(() => {
      for (const sessionID of uniqueIDs) {
        statement.run(scope, sessionID, dirtyAt)
      }
    })
  }

  importLegacyDirtySessionsOnce(scope: SessionDiscoveryScope, sessions: Record<string, number>, importedAt = Date.now()) {
    this.ensureSchema()
    const entries = Object.entries(sessions).filter(([sessionID]) => sessionID.length > 0)
    const upsertDirty = this.database.prepare(`
      INSERT INTO dirty_sessions (scope, session_id, dirty_at) VALUES (?, ?, ?)
      ON CONFLICT(scope, session_id) DO UPDATE SET dirty_at = max(dirty_sessions.dirty_at, excluded.dirty_at)
    `)
    const markImport = this.database.prepare("INSERT OR REPLACE INTO legacy_imports (kind, scope, imported_at) VALUES (?, ?, ?)")

    this.transaction(() => {
      if (this.hasLegacyImportRows("dirty", scope)) {
        return
      }

      for (const [sessionID, dirtyAt] of entries) {
        upsertDirty.run(scope, sessionID, dirtyAt)
      }
      markImport.run("dirty", scope, importedAt)
    })
  }

  readDirtySessions(scope: SessionDiscoveryScope, filter?: Iterable<string>): Record<string, number> {
    this.ensureSchema()
    const rows = filter ? this.readFilteredDirtySessions(scope, filter) : this.readAllDirtySessions(scope)
    return Object.fromEntries(rows.map((row) => [row.session_id, row.dirty_at]))
  }

  clearDirtySessionsUpTo(scope: SessionDiscoveryScope, dirtySessions: Record<string, number>) {
    this.ensureSchema()
    const entries = Object.entries(dirtySessions).filter(([sessionID]) => sessionID.length > 0)
    if (entries.length === 0) {
      return
    }

    const statement = this.database.prepare("DELETE FROM dirty_sessions WHERE scope = ? AND session_id = ? AND dirty_at <= ?")
    this.transaction(() => {
      for (const [sessionID, dirtyAt] of entries) {
        statement.run(scope, sessionID, dirtyAt)
      }
    })
  }

  hasDirtySessions(scope: SessionDiscoveryScope) {
    this.ensureSchema()
    const row = this.database.prepare("SELECT 1 AS found FROM dirty_sessions WHERE scope = ? LIMIT 1").get(scope) as { found: number } | undefined
    return row != null
  }

  hasLegacyImport(kind: string, scope: SessionDiscoveryScope) {
    this.ensureSchema()
    return this.hasLegacyImportRows(kind, scope)
  }

  markLegacyImport(kind: string, scope: SessionDiscoveryScope, importedAt = Date.now()) {
    this.ensureSchema()
    this.database.prepare("INSERT OR REPLACE INTO legacy_imports (kind, scope, imported_at) VALUES (?, ?, ?)").run(kind, scope, importedAt)
  }

  queryFtsCandidates(options: FtsCandidateQueryOptions): FtsCandidate[] {
    this.ensureSchema()
    const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_FTS_LIMIT))
    const sessionIDs = options.sessionIDs === undefined ? undefined : Array.from(new Set(options.sessionIDs)).filter(Boolean)
    const ftsQuery = toSafeFtsQuery(options.query)

    if (!ftsQuery || sessionIDs?.length === 0) {
      return []
    }

    try {
      if (sessionIDs === undefined) {
        return this.database
          .prepare(`
            SELECT chunk_id AS chunkID, session_id AS sessionID, bm25(chunks_fts) AS rank
            FROM chunks_fts
            WHERE chunks_fts MATCH ? AND scope = ?
            ORDER BY rank ASC
            LIMIT ?
          `)
          .all(ftsQuery, options.scope, limit) as FtsCandidate[]
      }

      const placeholders = sessionIDs.map(() => "?").join(", ")
      return this.database
        .prepare(`
          SELECT chunk_id AS chunkID, session_id AS sessionID, bm25(chunks_fts) AS rank
          FROM chunks_fts
          WHERE chunks_fts MATCH ? AND scope = ? AND session_id IN (${placeholders})
          ORDER BY rank ASC
          LIMIT ?
        `)
        .all(ftsQuery, options.scope, ...sessionIDs, limit) as FtsCandidate[]
    } catch {
      return []
    }
  }

  querySemanticCandidates(options: SemanticCandidateQueryOptions): SemanticCandidate[] {
    this.ensureSchema()
    const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_FTS_LIMIT))
    const sessionIDs = options.sessionIDs === undefined ? undefined : Array.from(new Set(options.sessionIDs)).filter(Boolean)

    if (options.queryVector.length === 0 || sessionIDs?.length === 0) {
      return []
    }

    const nativeBackend = this.selectNativeVectorBackend(options.vectorBackend ?? "auto")
    if (nativeBackend) {
      const nativeCandidates = this.queryNativeSemanticCandidates(nativeBackend, options, limit, sessionIDs)
      if (nativeCandidates && nativeCandidates.length > 0) {
        return nativeCandidates
      }
    }

    return this.queryBlobSemanticCandidates(options, limit, sessionIDs)
  }

  private clearSnapshotRows(scope: SessionDiscoveryScope) {
    for (const table of [
      "chunks_fts",
      "semantic_query_cache",
      "semantic_vector_meta",
      "semantic_collections",
      "chunks",
      "session_cursors",
      "sessions",
      "index_state",
    ]) {
      this.database.prepare(`DELETE FROM ${table} WHERE scope = ?`).run(scope)
    }
  }

  private writeSnapshotRows(index: SearchIndexDocument) {
    this.clearSnapshotRows(index.discovery.scope)
    this.database.prepare(`
      INSERT INTO index_state (
        scope, version, built_at, snapshot_at, discovery_directory,
        discovery_workspace_id, include_tool_outputs_for_indexing, settings_json, semantic_signature, semantic_built_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      index.discovery.scope,
      index.version,
      index.builtAt,
      index.snapshotAt,
      index.discovery.directory ?? null,
      index.discovery.workspaceID ?? null,
      index.settings.includeToolOutputsForIndexing ? 1 : 0,
      JSON.stringify(index.settings),
      index.semantic?.signature ?? null,
      index.semantic?.builtAt ?? null,
    )

    const insertSession = this.database.prepare(`
      INSERT INTO sessions (scope, session_id, title, directory, workspace_id, parent_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const session of index.sessions) {
      insertSession.run(
        index.discovery.scope,
        session.sessionID,
        session.title,
        session.directory ?? null,
        session.workspaceID ?? null,
        session.parentSessionID ?? null,
        session.createdAt,
        session.updatedAt,
      )
    }

    const insertCursor = this.database.prepare(`
      INSERT INTO session_cursors (scope, session_id, session_updated_at, indexed_at)
      VALUES (?, ?, ?, ?)
    `)
    for (const cursor of index.cursors) {
      insertCursor.run(index.discovery.scope, cursor.sessionID, cursor.sessionUpdatedAt, cursor.indexedAt)
    }

    const insertChunk = this.database.prepare(`
      INSERT INTO chunks (
        scope, chunk_id, session_id, message_id, part_id, parent_session_id,
        role, part_type, agent, tool_name, text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertFts = this.database.prepare("INSERT INTO chunks_fts (scope, chunk_id, session_id, text) VALUES (?, ?, ?, ?)")
    for (const chunk of index.chunks) {
      insertChunk.run(
        index.discovery.scope,
        chunk.chunkID,
        chunk.sessionID,
        chunk.messageID,
        chunk.partID ?? null,
        chunk.parentSessionID ?? null,
        chunk.role,
        chunk.partType,
        chunk.agent ?? null,
        chunk.toolName ?? null,
        chunk.text,
        chunk.createdAt,
      )
      insertFts.run(index.discovery.scope, chunk.chunkID, chunk.sessionID, chunk.text)
    }

    if (!index.semantic) {
      return
    }

    this.database.prepare("INSERT INTO semantic_collections (scope, signature, built_at) VALUES (?, ?, ?)").run(
      index.discovery.scope,
      index.semantic.signature,
      index.semantic.builtAt,
    )

    const insertVectorMeta = this.database.prepare(`
      INSERT INTO semantic_vector_meta (scope, signature, chunk_id, fingerprint, vector_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const [chunkID, fingerprint] of Object.entries(index.semantic.fingerprints)) {
      insertVectorMeta.run(
        index.discovery.scope,
        index.semantic.signature,
        chunkID,
        fingerprint,
        JSON.stringify(index.semantic.vectors[chunkID] ?? []),
        index.semantic.builtAt,
      )
    }

    this.writeNativeSemanticVectorsBestEffort(index)

    const insertQuery = this.database.prepare(`
      INSERT INTO semantic_query_cache (scope, signature, query_key, query_text, vector_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const [queryKey, query] of Object.entries(index.semantic.queries ?? {})) {
      insertQuery.run(index.discovery.scope, index.semantic.signature, queryKey, query.text, JSON.stringify(query.vector), query.updatedAt)
    }
  }

  private readAllDirtySessions(scope: SessionDiscoveryScope) {
    return this.database
      .prepare("SELECT session_id, dirty_at FROM dirty_sessions WHERE scope = ? ORDER BY session_id ASC")
      .all(scope) as DirtySessionRow[]
  }

  private selectNativeVectorBackend(preference: VectorBackendPreference): NativeVectorBackendName | undefined {
    if (preference === "blob-scan") {
      return undefined
    }

    const candidates: NativeVectorBackendName[] = preference === "auto" ? ["sqlite-vec", "vec1"] : [preference]
    return candidates.find((backend) => this.sqlite?.getExtensionProbe(backend)?.available)
  }

  private writeNativeSemanticVectorsBestEffort(index: SearchIndexDocument) {
    const semantic = index.semantic
    if (!semantic) {
      return
    }

    const firstVector = Object.values(semantic.vectors).find((vector) => Array.isArray(vector) && vector.length > 0)
    if (!firstVector) {
      return
    }

    const backend = this.selectNativeVectorBackend(this.vectorBackend)
    if (!backend) {
      return
    }

    const tableName = getNativeVectorTableName(backend, firstVector.length)
    try {
      this.createNativeVectorTable(backend, tableName, firstVector.length)
      this.database.prepare(`DELETE FROM ${tableName} WHERE scope = ? AND signature = ?`).run(index.discovery.scope, semantic.signature)
      const insert = this.database.prepare(`INSERT INTO ${tableName} (scope, signature, chunk_id, embedding) VALUES (?, ?, ?, ?)`)
      for (const [chunkID, vector] of Object.entries(semantic.vectors)) {
        if (vector.length !== firstVector.length) {
          continue
        }
        insert.run(index.discovery.scope, semantic.signature, chunkID, serializeVectorForNative(vector))
      }
    } catch {
      // Native vector support is optional; JSON vector rows remain the source of truth.
    }
  }

  private queryNativeSemanticCandidates(
    backend: NativeVectorBackendName,
    options: SemanticCandidateQueryOptions,
    limit: number,
    sessionIDs: string[] | undefined,
  ): SemanticCandidate[] | undefined {
    const dimensions = options.queryVector.length
    const tableName = getNativeVectorTableName(backend, dimensions)
    try {
      this.createNativeVectorTable(backend, tableName, dimensions)
      const sessionFilter = sessionIDs ? `AND c.session_id IN (${sessionIDs.map(() => "?").join(", ")})` : ""
      const rows = this.database
        .prepare(`
          SELECT v.chunk_id AS chunkID, v.distance AS distance
          FROM ${tableName} v
          JOIN chunks c ON c.scope = v.scope AND c.chunk_id = v.chunk_id
          WHERE v.embedding MATCH ? AND k = ? AND v.scope = ? AND v.signature = ? ${sessionFilter}
          ORDER BY v.distance ASC
          LIMIT ?
        `)
        .all(serializeVectorForNative(options.queryVector), limit, options.scope, options.signature, ...(sessionIDs ?? []), limit) as NativeVectorCandidateRow[]

      return rows.map((row) => ({
        chunkID: row.chunkID,
        score: 1 / (1 + Math.max(0, row.distance)),
        backend,
      }))
    } catch {
      return undefined
    }
  }

  private queryBlobSemanticCandidates(
    options: SemanticCandidateQueryOptions,
    limit: number,
    sessionIDs: string[] | undefined,
  ): SemanticCandidate[] {
    const sessionFilter = sessionIDs ? `AND c.session_id IN (${sessionIDs.map(() => "?").join(", ")})` : ""
    const rows = this.database
      .prepare(`
        SELECT m.chunk_id AS chunkID, m.vector_json AS vectorJson
        FROM semantic_vector_meta m
        JOIN chunks c ON c.scope = m.scope AND c.chunk_id = m.chunk_id
        WHERE m.scope = ? AND m.signature = ? ${sessionFilter}
      `)
      .all(options.scope, options.signature, ...(sessionIDs ?? [])) as VectorScanRow[]

    return rows
      .map((row) => ({
        chunkID: row.chunkID,
        score: dot(options.queryVector, parseNumberArray(row.vectorJson)),
        backend: "blob-scan" as const,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
  }

  private createNativeVectorTable(backend: NativeVectorBackendName, tableName: string, dimensions: number) {
    const moduleName = backend === "sqlite-vec" ? "vec0" : "vec1"
    this.database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING ${moduleName}(
        scope TEXT,
        signature TEXT,
        chunk_id TEXT PRIMARY KEY,
        embedding float[${dimensions}]
      )
    `)
  }

  private readFilteredDirtySessions(scope: SessionDiscoveryScope, filter: Iterable<string>) {
    const ids = Array.from(new Set(filter)).filter(Boolean)
    if (ids.length === 0) {
      return []
    }

    const placeholders = ids.map(() => "?").join(", ")
    return this.database
      .prepare(`SELECT session_id, dirty_at FROM dirty_sessions WHERE scope = ? AND session_id IN (${placeholders}) ORDER BY session_id ASC`)
      .all(scope, ...ids) as DirtySessionRow[]
  }

  private hasLegacyImportRows(kind: string, scope: SessionDiscoveryScope) {
    const row = this.database.prepare("SELECT 1 AS found FROM legacy_imports WHERE kind = ? AND scope = ?").get(kind, scope) as { found: number } | undefined
    return row != null
  }

  private transaction<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const result = callback()
      this.database.exec("COMMIT")
      return result
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const rows = this.database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!rows.some((row) => row.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }
}

const parseJsonSettings = (settingsJson: string, includeToolOutputsForIndexing: boolean): SearchIndexDocument["settings"] => {
  try {
    const parsed = JSON.parse(settingsJson) as SearchIndexDocument["settings"]
    return {
      includeToolOutputsForIndexing: Boolean(parsed.includeToolOutputsForIndexing),
    }
  } catch {
    return { includeToolOutputsForIndexing }
  }
}

const toSafeFtsQuery = (query: string): string | undefined => {
  const terms = Array.from(new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? []))
  if (terms.length === 0) {
    return undefined
  }

  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ")
}

const getNativeVectorTableName = (backend: NativeVectorBackendName, dimensions: number) =>
  `semantic_vectors_native_${backend.replace(/[^a-z0-9_]/gi, "_")}_${Math.max(1, Math.trunc(dimensions))}`

const serializeVectorForNative = (vector: number[]) => JSON.stringify(vector)

const parseNumberArray = (json: string): number[] => {
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === "number" && Number.isFinite(value)) : []
  } catch {
    return []
  }
}

const toSessionRecord = (row: SessionRow): SourceSessionRecord => ({
  sessionID: row.session_id,
  title: row.title,
  directory: row.directory ?? undefined,
  workspaceID: row.workspace_id ?? undefined,
  parentSessionID: row.parent_session_id ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toCursorRecord = (row: CursorRow): SearchIndexSessionCursor => ({
  sessionID: row.session_id,
  sessionUpdatedAt: row.session_updated_at,
  indexedAt: row.indexed_at,
})

const toChunkRecord = (row: ChunkRow): SessionChunk => ({
  chunkID: row.chunk_id,
  sessionID: row.session_id,
  messageID: row.message_id,
  partID: row.part_id ?? undefined,
  parentSessionID: row.parent_session_id ?? undefined,
  role: row.role as SessionChunk["role"],
  partType: row.part_type as SessionChunk["partType"],
  agent: row.agent ?? undefined,
  toolName: row.tool_name ?? undefined,
  text: row.text,
  createdAt: row.created_at,
})

interface IndexStateRow {
  version: number
  built_at: number
  snapshot_at: number
  discovery_directory: string | null
  discovery_workspace_id: string | null
  include_tool_outputs_for_indexing: number
  settings_json: string
  semantic_signature: string | null
  semantic_built_at: number | null
}

interface SessionRow {
  session_id: string
  title: string
  directory: string | null
  workspace_id: string | null
  parent_session_id: string | null
  created_at: number
  updated_at: number
}

interface CursorRow {
  session_id: string
  session_updated_at: number
  indexed_at: number
}

interface ChunkRow {
  chunk_id: string
  session_id: string
  message_id: string
  part_id: string | null
  parent_session_id: string | null
  role: string
  part_type: string
  agent: string | null
  tool_name: string | null
  text: string
  created_at: number
}

interface DirtySessionRow {
  session_id: string
  dirty_at: number
}

interface VectorMetaRow {
  chunk_id: string
  fingerprint: string
  vector_json: string
}

interface NativeVectorCandidateRow {
  chunkID: string
  distance: number
}

interface VectorScanRow {
  chunkID: string
  vectorJson: string
}

interface QueryMetaRow {
  query_key: string
  query_text: string
  vector_json: string
  updated_at: number
}

interface SqliteStatement {
  run(...values: BindValue[]): unknown
  all(...values: BindValue[]): unknown[]
  get(...values: BindValue[]): unknown
}

declare module "bun:sqlite" {
  interface Database {
    prepare(sql: string): SqliteStatement
  }
}
