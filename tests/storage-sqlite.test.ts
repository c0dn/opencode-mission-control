import { chmodSync, mkdirSync, mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { createVectorBackendProbe } from "../src/search/vector-backend.ts"
import { createMissionControlConfig } from "../src/config.ts"
import { resolveMissionControlSqliteCachePath } from "../src/storage/sqlite-paths.ts"
import { openMissionControlSqliteDatabase } from "../src/storage/sqlite.ts"

describe("openMissionControlSqliteDatabase", () => {
  test("opens a cache database, creates migrations table, and reports missing extensions", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-sqlite-"))
    const sqlite = openMissionControlSqliteDatabase(join(dir, "cache.sqlite3"))

    expect(sqlite.getExtensionProbe("vec1")?.available).toBe(false)
    expect(sqlite.getExtensionProbe("sqlite-vec")?.available).toBe(false)

    sqlite.database.exec("INSERT OR REPLACE INTO schema_migrations (id, applied_at) VALUES ('test', 1)")
    sqlite.close()
  })

  test("creates SQLite files with private permissions on POSIX", () => {
    if (process.platform === "win32") {
      return
    }

    const dir = mkdtempSync(join(tmpdir(), "mc-sqlite-perms-"))
    const dbPath = join(dir, "cache.sqlite3")
    const sqlite = openMissionControlSqliteDatabase(dbPath)
    sqlite.close()

    expect(statSync(dbPath).mode & 0o777).toBe(0o600)
  })

  test("does not harden existing SQLite parent directory permissions on POSIX", () => {
    if (process.platform === "win32") {
      return
    }

    const dir = mkdtempSync(join(tmpdir(), "mc-sqlite-dir-perms-"))
    const cacheDir = join(dir, "cache")
    mkdirSync(cacheDir, { mode: 0o755 })
    chmodSync(cacheDir, 0o755)

    const sqlite = openMissionControlSqliteDatabase(join(cacheDir, "cache.sqlite3"))
    sqlite.close()

    expect(statSync(cacheDir).mode & 0o777).toBe(0o755)
  })

  test("creates missing SQLite parent directories with private permissions on POSIX", () => {
    if (process.platform === "win32") {
      return
    }

    const dir = mkdtempSync(join(tmpdir(), "mc-sqlite-created-dir-perms-"))
    const cacheDir = join(dir, "cache", "nested")

    const sqlite = openMissionControlSqliteDatabase(join(cacheDir, "cache.sqlite3"))
    sqlite.close()

    expect(statSync(join(dir, "cache")).mode & 0o777).toBe(0o700)
    expect(statSync(cacheDir).mode & 0o777).toBe(0o700)
  })

  test("rejects relative extension paths without loading them", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-sqlite-relative-extension-"))
    const sqlite = openMissionControlSqliteDatabase(join(dir, "cache.sqlite3"), {
      extensions: {
        vec1: "relative/vec1",
      },
    })

    expect(sqlite.getExtensionProbe("vec1")).toMatchObject({
      loaded: false,
      available: false,
      reason: "Extension path must be absolute",
    })

    sqlite.close()
  })

  test("closes initialized database when strict extension loading fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-sqlite-strict-extension-"))

    expect(() =>
      openMissionControlSqliteDatabase(join(dir, "cache.sqlite3"), {
        extensions: {
          vec1: join(dir, "missing-vec1.so"),
        },
        strictExtensionLoading: true,
      }),
    ).toThrow()
  })
})

describe("resolveMissionControlSqliteCachePath", () => {
  test("derives SQLite path from configured JSON index path", () => {
    expect(resolveMissionControlSqliteCachePath("/repo", "current_directory", "/cache/index.json")).toBe(
      "/cache/index.sqlite3",
    )
  })

  test("scopes configured JSON index path before deriving global SQLite path", () => {
    expect(resolveMissionControlSqliteCachePath("/repo", "global_unscoped", "/cache/index.json")).toBe(
      "/cache/index.global_unscoped.sqlite3",
    )
  })

  test("preserves configured current-directory SQLite cache path", () => {
    expect(resolveMissionControlSqliteCachePath("/repo", "current_directory", "/cache/index.sqlite3")).toBe(
      "/cache/index.sqlite3",
    )
  })

  test("scopes configured SQLite cache path for global discovery", () => {
    expect(resolveMissionControlSqliteCachePath("/repo", "global_unscoped", "/cache/index.sqlite3")).toBe(
      "/cache/index.global_unscoped.sqlite3",
    )
  })
})

describe("createVectorBackendProbe", () => {
  test("falls back to blob scan when auto mode has no native extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-sqlite-probe-"))
    const sqlite = openMissionControlSqliteDatabase(join(dir, "cache.sqlite3"))
    const probe = createVectorBackendProbe({ config: createMissionControlConfig(), sqlite })

    expect(probe.preference).toBe("auto")
    expect(probe.selectedBackend).toBe("blob-scan")
    expect(probe.available).toBe(true)

    sqlite.close()
  })

  test("does not select a loaded native extension without a smoke probe", () => {
    const probe = createVectorBackendProbe({
      config: createMissionControlConfig(),
      sqlite: {
        path: ":memory:",
        database: undefined as never,
        extensionProbes: [
          {
            backend: "vec1",
            requestedPath: "/tmp/vec1.so",
            loaded: true,
            available: false,
            reason: "No backend-specific smoke probe is configured",
          },
        ],
        getExtensionProbe: (backend) =>
          backend === "vec1"
            ? {
                backend: "vec1",
                requestedPath: "/tmp/vec1.so",
                loaded: true,
                available: false,
                reason: "No backend-specific smoke probe is configured",
              }
            : undefined,
        close: () => undefined,
      },
    })

    expect(probe.selectedBackend).toBe("blob-scan")
    expect(probe.available).toBe(true)
  })
})
