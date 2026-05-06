import type {
  MissionControlConfig,
  NativeVectorBackendName,
  VectorBackendName,
  VectorBackendPreference,
} from "../types.js"
import type { MissionControlSqliteDatabase, SqliteExtensionProbeResult } from "../storage/sqlite.js"

export interface VectorBackendProbeOptions {
  config: MissionControlConfig
  sqlite?: MissionControlSqliteDatabase
}

export interface VectorBackendProbeResult {
  preference: VectorBackendPreference
  selectedBackend: VectorBackendName
  available: boolean
  reason?: string
  extensionProbe?: SqliteExtensionProbeResult
}

export const resolveVectorBackendPreference = (config: MissionControlConfig): VectorBackendPreference =>
  VECTOR_BACKEND_PREFERENCES.has(config.search.vectorBackend as VectorBackendPreference) ? config.search.vectorBackend : "auto"

export const createVectorBackendProbe = ({ config, sqlite }: VectorBackendProbeOptions): VectorBackendProbeResult => {
  const preference = resolveVectorBackendPreference(config)

  if (preference === "blob-scan") {
    return {
      preference,
      selectedBackend: "blob-scan",
      available: true,
      reason: "BLOB scan fallback does not require a native extension",
    }
  }

  if (preference !== "auto") {
    return probeNativeBackend(preference, preference, sqlite)
  }

  for (const backend of ["vec1", "sqlite-vec"] satisfies NativeVectorBackendName[]) {
    const nativeProbe = probeNativeBackend(preference, backend, sqlite)
    if (nativeProbe.available) {
      return nativeProbe
    }
  }

  return {
    preference,
    selectedBackend: "blob-scan",
    available: true,
    reason: "No native vector extension is available; falling back to BLOB scan scaffold",
  }
}

const probeNativeBackend = (
  preference: VectorBackendPreference,
  backend: NativeVectorBackendName,
  sqlite: MissionControlSqliteDatabase | undefined,
): VectorBackendProbeResult => {
  const extensionProbe = sqlite?.getExtensionProbe(backend)

  return {
    preference,
    selectedBackend: backend,
    available: extensionProbe?.available ?? false,
    reason: extensionProbe?.reason ?? "SQLite database or extension probe is not available",
    extensionProbe,
  }
}

const VECTOR_BACKEND_PREFERENCES = new Set<VectorBackendPreference>(["auto", "vec1", "sqlite-vec", "blob-scan"])
