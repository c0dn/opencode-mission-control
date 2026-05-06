import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"

import { Database } from "bun:sqlite"

import type { NativeVectorBackendName } from "../types.js"

export interface SqliteExtensionProbeResult {
  backend: NativeVectorBackendName
  requestedPath?: string
  loaded: boolean
  available: boolean
  reason?: string
}

export interface OpenMissionControlSqliteOptions {
  busyTimeoutMs?: number
  createParentDirectory?: boolean
  extensions?: Partial<Record<NativeVectorBackendName, string>>
  strictExtensionLoading?: boolean
}

type ExtensionSmokeProbe = (database: Database) => string | undefined

export interface MissionControlSqliteDatabase {
  path: string
  database: Database
  extensionProbes: SqliteExtensionProbeResult[]
  getExtensionProbe(backend: NativeVectorBackendName): SqliteExtensionProbeResult | undefined
  close(): void
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000
const VECTOR_BACKENDS_WITH_EXTENSIONS: NativeVectorBackendName[] = ["vec1", "sqlite-vec"]

export const openMissionControlSqliteDatabase = (
  databasePath: string,
  options: OpenMissionControlSqliteOptions = {},
): MissionControlSqliteDatabase => {
  if (options.createParentDirectory !== false) {
    ensurePrivateParentDirectory(dirname(databasePath))
  }

  const database = new Database(databasePath, { create: true, readwrite: true })
  try {
    chmodSqliteFilesPrivate(databasePath)
    configureMissionControlSqliteDatabase(database, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)
    ensureSchemaMigrationsTable(database)
    chmodSqliteFilesPrivate(databasePath)

    const extensionProbes = VECTOR_BACKENDS_WITH_EXTENSIONS.map((backend) =>
      loadOptionalVectorExtension(database, backend, options.extensions?.[backend], options.strictExtensionLoading ?? false),
    )

    return {
      path: databasePath,
      database,
      extensionProbes,
      getExtensionProbe: (backend) => extensionProbes.find((probe) => probe.backend === backend),
      close: () => database.close(),
    }
  } catch (error) {
    database.close()
    throw error
  }
}

export const configureMissionControlSqliteDatabase = (database: Database, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS) => {
  database.exec("PRAGMA journal_mode = WAL")
  database.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`)
  database.exec("PRAGMA foreign_keys = ON")
}

export const ensureSchemaMigrationsTable = (database: Database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)
}

const loadOptionalVectorExtension = (
  database: Database,
  backend: NativeVectorBackendName,
  extensionPath: string | undefined,
  strictExtensionLoading: boolean,
): SqliteExtensionProbeResult => {
  const requestedPath = extensionPath?.trim()

  if (!requestedPath) {
    return {
      backend,
      loaded: false,
      available: false,
      reason: "No extension path configured",
    }
  }

  if (!isAbsolute(requestedPath)) {
    const result = {
      backend,
      requestedPath,
      loaded: false,
      available: false,
      reason: "Extension path must be absolute",
    }

    if (strictExtensionLoading) {
      throw new Error(result.reason)
    }

    return result
  }

  try {
    database.loadExtension(requestedPath)
    const probeFailure = VECTOR_EXTENSION_SMOKE_PROBES[backend](database)

    return {
      backend,
      requestedPath,
      loaded: true,
      available: probeFailure === undefined,
      reason: probeFailure,
    }
  } catch (error) {
    if (strictExtensionLoading) {
      throw error
    }

    return {
      backend,
      requestedPath,
      loaded: false,
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

const VECTOR_EXTENSION_SMOKE_PROBES: Record<NativeVectorBackendName, ExtensionSmokeProbe> = {
  "sqlite-vec": (database) =>
    firstSuccessfulProbe(database, [
      {
        label: "vec_version()",
        sql: "SELECT vec_version()",
      },
      {
        label: "temp vec0 virtual table",
        sql: "CREATE VIRTUAL TABLE temp.mc_sqlite_vec_smoke_probe USING vec0(embedding float[2]); DROP TABLE temp.mc_sqlite_vec_smoke_probe",
      },
    ]),
  vec1: (database) =>
    firstSuccessfulProbe(database, [
      {
        label: "vec1_version()",
        sql: "SELECT vec1_version()",
      },
      {
        label: "temp vec1 virtual table",
        sql: "CREATE VIRTUAL TABLE temp.mc_vec1_smoke_probe USING vec1(embedding float[2]); DROP TABLE temp.mc_vec1_smoke_probe",
      },
    ]),
}

const firstSuccessfulProbe = (database: Database, probes: { label: string; sql: string }[]) => {
  const failures: string[] = []

  for (const probe of probes) {
    try {
      database.exec(probe.sql)
      return undefined
    } catch (error) {
      failures.push(`${probe.label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return `Backend smoke probe failed (${failures.join("; ")})`
}

const ensurePrivateParentDirectory = (directoryPath: string) => {
  const missingDirectories = collectMissingDirectories(directoryPath)

  mkdirSync(directoryPath, { mode: 0o700, recursive: true })

  if (process.platform === "win32") {
    return
  }

  for (const createdDirectory of missingDirectories) {
    chmodDirectoryPrivate(createdDirectory)
  }
}

const collectMissingDirectories = (directoryPath: string) => {
  const missingDirectories: string[] = []
  let currentPath = directoryPath

  while (!existsSync(currentPath)) {
    missingDirectories.unshift(currentPath)

    const parentPath = dirname(currentPath)
    if (parentPath === currentPath) {
      break
    }

    currentPath = parentPath
  }

  return missingDirectories
}

const chmodDirectoryPrivate = (directoryPath: string) => {
  if (process.platform === "win32") {
    return
  }

  try {
    chmodSync(directoryPath, 0o700)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOSYS" && code !== "ENOTSUP") {
      throw error
    }
  }
}

const chmodSqliteFilesPrivate = (databasePath: string) => {
  if (process.platform === "win32") {
    return
  }

  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      chmodSync(path, 0o600)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOSYS" && code !== "ENOTSUP") {
        throw error
      }
    }
  }
}
