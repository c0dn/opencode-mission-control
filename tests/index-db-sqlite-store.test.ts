import { mkdtempSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { MissionControlIndexDB } from "../src/index-db.ts"
import { resolveDirtyStorePath, resolveScopedIndexPath } from "../src/index-db/paths.ts"
import { SqliteSearchIndexStore } from "../src/index-db/sqlite-store.ts"
import type { SearchIndexDocument } from "../src/index-db/types.ts"
import { openMissionControlSqliteDatabase } from "../src/storage/sqlite.ts"

describe("SqliteSearchIndexStore", () => {
  test("creates schema and records the search migration", () => {
    const sqlite = openTempDatabase()
    const store = new SqliteSearchIndexStore({ sqlite })

    store.ensureSchema()

    const migration = sqlite.database
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get("search-index-store-v1") as { id: string } | undefined
    expect(migration?.id).toBe("search-index-store-v1")

    sqlite.close()
  })

  test("replaces and loads a scoped snapshot with semantic vector arrays", () => {
    const sqlite = openTempDatabase()
    const store = new SqliteSearchIndexStore({ sqlite })

    store.replaceScopedSnapshot(makeIndex({ builtAt: 100, title: "First title" }))
    store.replaceScopedSnapshot(makeIndex({ builtAt: 200, title: "Replacement title" }))

    const loaded = store.loadScopedSnapshot("current_directory")

    expect(loaded).toMatchObject({
      version: 5,
      builtAt: 200,
      snapshotAt: 99,
      discovery: {
        scope: "current_directory",
        directory: "/repo",
      },
      settings: {
        includeToolOutputsForIndexing: true,
      },
      semantic: {
        signature: "jina:test:2",
        builtAt: 180,
        fingerprints: {
          "session-1:message-1:0": "fingerprint-1",
        },
        vectors: {
          "session-1:message-1:0": [0.1, 0.2],
        },
        queries: {
          hello: {
            text: "hello",
            vector: [0.3, 0.4],
            updatedAt: 181,
          },
        },
      },
    })
    expect(loaded?.sessions).toEqual([
      {
        sessionID: "session-1",
        title: "Replacement title",
        directory: "/repo",
        createdAt: 10,
        updatedAt: 20,
      },
    ])
    expect(loaded?.cursors).toEqual([
      {
        sessionID: "session-1",
        sessionUpdatedAt: 20,
        indexedAt: 200,
      },
    ])
    expect(loaded?.chunks).toEqual([
      {
        chunkID: "session-1:message-1:0",
        sessionID: "session-1",
        messageID: "message-1",
        role: "user",
        partType: "text",
        text: "hello searchable world",
        createdAt: 12,
      },
    ])

    sqlite.close()
  })

  test("keeps current directory and global snapshots isolated", () => {
    const sqlite = openTempDatabase()
    const store = new SqliteSearchIndexStore({ sqlite })

    store.replaceScopedSnapshot(makeIndex({ scope: "current_directory", title: "Local" }))
    store.replaceScopedSnapshot(makeIndex({ scope: "global_unscoped", directory: undefined, title: "Global" }))

    expect(store.loadScopedSnapshot("current_directory")?.sessions[0]?.title).toBe("Local")
    expect(store.loadScopedSnapshot("global_unscoped")?.sessions[0]?.title).toBe("Global")

    sqlite.close()
  })

  test("marks reads filters and clears dirty sessions up to known timestamps", () => {
    const sqlite = openTempDatabase()
    const store = new SqliteSearchIndexStore({ sqlite })

    store.markDirtySessions("current_directory", ["session-1", "session-2", "session-1"], 100)
    store.markDirtySessions("current_directory", ["session-1"], 90)
    store.markDirtySessions("global_unscoped", ["session-1"], 50)

    expect(store.readDirtySessions("current_directory")).toEqual({
      "session-1": 101,
      "session-2": 100,
    })
    expect(store.readDirtySessions("current_directory", ["session-2", "missing"])).toEqual({
      "session-2": 100,
    })

    store.clearDirtySessionsUpTo("current_directory", {
      "session-1": 99,
      "session-2": 100,
    })
    expect(store.readDirtySessions("current_directory")).toEqual({
      "session-1": 101,
    })
    expect(store.readDirtySessions("global_unscoped")).toEqual({
      "session-1": 50,
    })

    sqlite.close()
  })

  test("keeps same-millisecond dirty invalidations after clearing an older snapshot", () => {
    const sqlite = openTempDatabase()
    const store = new SqliteSearchIndexStore({ sqlite })

    store.markDirtySessions("current_directory", ["session-1"], 100)
    const observedBeforeRefresh = store.readDirtySessions("current_directory")
    store.markDirtySessions("current_directory", ["session-1"], 100)

    store.clearDirtySessionsUpTo("current_directory", observedBeforeRefresh)

    expect(store.readDirtySessions("current_directory")).toEqual({
      "session-1": 101,
    })

    sqlite.close()
  })

  test("merges and writes a scoped snapshot inside one store transaction", () => {
    const sqlite = openTempDatabase()
    const store = new SqliteSearchIndexStore({ sqlite })

    store.replaceScopedSnapshot(makeIndex({ builtAt: 100, title: "Existing title" }))
    const merged = store.saveMergedSnapshot(makeIndex({ builtAt: 200, title: "Next title" }), (current, next) => ({
      ...next,
      semantic: current?.semantic,
    }))

    expect(merged.semantic?.signature).toBe("jina:test:2")
    expect(store.loadScopedSnapshot("current_directory")?.semantic?.signature).toBe("jina:test:2")
    expect(store.loadScopedSnapshot("current_directory")?.sessions[0]?.title).toBe("Next title")

    sqlite.close()
  })

  test("imports a legacy snapshot only when the scoped snapshot is absent", () => {
    const sqlite = openTempDatabase()
    const store = new SqliteSearchIndexStore({ sqlite })

    store.replaceScopedSnapshot(makeIndex({ builtAt: 400, title: "SQLite title" }))

    const loaded = store.importLegacySnapshotIfAbsent(
      "current_directory",
      makeIndex({ builtAt: 100, title: "Legacy title" }),
    )

    expect(loaded.sessions[0]?.title).toBe("SQLite title")
    expect(store.loadScopedSnapshot("current_directory")?.sessions[0]?.title).toBe("SQLite title")

    sqlite.close()
  })

  test("queries FTS candidates within a scope and optional session filter", () => {
    const sqlite = openTempDatabase()
    const store = new SqliteSearchIndexStore({ sqlite })

    store.replaceScopedSnapshot(makeIndex({ scope: "current_directory", title: "Local", text: "alpha beta" }))
    store.replaceScopedSnapshot(makeIndex({ scope: "global_unscoped", directory: undefined, title: "Global", text: "alpha gamma" }))

    expect(store.queryFtsCandidates({ scope: "current_directory", query: "alpha", limit: 5 })).toEqual([
      {
        chunkID: "session-1:message-1:0",
        sessionID: "session-1",
        rank: expect.any(Number),
      },
    ])
    expect(
      store.queryFtsCandidates({
        scope: "current_directory",
        query: "alpha",
        sessionIDs: ["missing"],
      }),
    ).toEqual([])
    expect(store.queryFtsCandidates({ scope: "current_directory", query: "Local", limit: 5 })).toEqual([])

    sqlite.close()
  })

  test("returns no FTS candidates for an explicit empty session filter", () => {
    const sqlite = openTempDatabase()
    const store = new SqliteSearchIndexStore({ sqlite })

    store.replaceScopedSnapshot(makeIndex({ scope: "current_directory", text: "alpha beta" }))

    expect(
      store.queryFtsCandidates({
        scope: "current_directory",
        query: "alpha",
        sessionIDs: [],
      }),
    ).toEqual([])

    sqlite.close()
  })

  test("does not throw on FTS queries with punctuation paths code and operators", () => {
    const sqlite = openTempDatabase()
    const store = new SqliteSearchIndexStore({ sqlite })

    store.replaceScopedSnapshot(makeIndex({ scope: "current_directory", text: "alpha foo/bar error.stack hyphen-word key:value near term" }))

    for (const query of ['foo/bar', 'error.stack', '"unterminated', "AND", "OR", "NEAR", "hyphen-word", "key:value"]) {
      expect(() => store.queryFtsCandidates({ scope: "current_directory", query })).not.toThrow()
    }
    expect(store.queryFtsCandidates({ scope: "current_directory", query: "alpha", limit: 5 })).toHaveLength(1)

    sqlite.close()
  })

  test("imports a legacy JSON snapshot when the SQLite snapshot is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-index-sqlite-import-"))
    const configuredIndexPath = join(dir, "legacy-index.json")
    const legacyPath = resolveScopedIndexPath(dir, configuredIndexPath, "current_directory")
    await writeFile(legacyPath, JSON.stringify(makeIndex({ builtAt: 321, title: "Legacy title" })), "utf8")

    const loaded = await new MissionControlIndexDB(dir, configuredIndexPath, "current_directory").load()

    expect(loaded?.builtAt).toBe(321)
    expect(loaded?.sessions[0]?.title).toBe("Legacy title")

    const reloaded = await new MissionControlIndexDB(dir, configuredIndexPath, "current_directory").load()
    expect(reloaded?.sessions[0]?.title).toBe("Legacy title")
  })

  test("imports legacy dirty JSON once when the SQLite dirty store is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-index-sqlite-dirty-import-"))
    const configuredIndexPath = join(dir, "legacy-index.json")
    const legacyDirtyPath = resolveDirtyStorePath(dir, configuredIndexPath, "current_directory")
    await writeFile(
      legacyDirtyPath,
      JSON.stringify({ version: 1, sessions: { "legacy-dirty-session": 123 } }),
      "utf8",
    )

    const indexDB = new MissionControlIndexDB(dir, configuredIndexPath, "current_directory")
    expect(await indexDB.readDirtySessions()).toEqual({ "legacy-dirty-session": 123 })

    await indexDB.clearDirtySessionsUpTo({ "legacy-dirty-session": 123 })
    expect(await new MissionControlIndexDB(dir, configuredIndexPath, "current_directory").readDirtySessions()).toEqual({})
  })

  test("imports legacy dirty JSON even when dirty rows already exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-index-sqlite-dirty-merge-import-"))
    const configuredIndexPath = join(dir, "legacy-index.json")
    const indexDB = new MissionControlIndexDB(dir, configuredIndexPath, "current_directory")
    const sqlite = openMissionControlSqliteDatabase(indexDB.getIndexPath("current_directory"))
    const store = new SqliteSearchIndexStore({ sqlite })
    store.markDirtySessions("current_directory", ["existing-dirty-session"], 200)
    sqlite.close()

    const legacyDirtyPath = resolveDirtyStorePath(dir, configuredIndexPath, "current_directory")
    await writeFile(
      legacyDirtyPath,
      JSON.stringify({ version: 1, sessions: { "existing-dirty-session": 123, "legacy-dirty-session": 150 } }),
      "utf8",
    )

    expect(await new MissionControlIndexDB(dir, configuredIndexPath, "current_directory").readDirtySessions()).toEqual({
      "existing-dirty-session": 200,
      "legacy-dirty-session": 150,
    })
  })

  test("uses legacy dirty import marker as the import sentinel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-index-sqlite-dirty-marker-import-"))
    const configuredIndexPath = join(dir, "legacy-index.json")
    const indexDB = new MissionControlIndexDB(dir, configuredIndexPath, "current_directory")
    const sqlite = openMissionControlSqliteDatabase(indexDB.getIndexPath("current_directory"))
    const store = new SqliteSearchIndexStore({ sqlite })
    store.markDirtySessions("current_directory", ["partial-dirty-session"], 200)
    store.markLegacyImport("dirty", "current_directory", 201)
    sqlite.close()

    const legacyDirtyPath = resolveDirtyStorePath(dir, configuredIndexPath, "current_directory")
    await writeFile(
      legacyDirtyPath,
      JSON.stringify({ version: 1, sessions: { "legacy-dirty-session": 150 } }),
      "utf8",
    )

    expect(await new MissionControlIndexDB(dir, configuredIndexPath, "current_directory").readDirtySessions()).toEqual({
      "partial-dirty-session": 200,
    })
  })

  test("close is idempotent and later operations reopen SQLite handles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-index-sqlite-close-"))
    const configuredIndexPath = join(dir, "index.json")
    const indexDB = new MissionControlIndexDB(dir, configuredIndexPath, "current_directory")

    await indexDB.save(makeIndex({ builtAt: 111, title: "Before close" }))
    indexDB.close()
    indexDB.close()

    await indexDB.save(makeIndex({ builtAt: 222, title: "After close" }))

    const loaded = await indexDB.load()
    expect(loaded?.builtAt).toBe(222)
    expect(loaded?.sessions[0]?.title).toBe("After close")
  })
})

const openTempDatabase = () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-index-sqlite-store-"))
  return openMissionControlSqliteDatabase(join(dir, "index.sqlite3"))
}

const makeIndex = (options: {
  scope?: "current_directory" | "global_unscoped"
  directory?: string
  builtAt?: number
  title?: string
  text?: string
}): SearchIndexDocument => ({
  version: 5,
  builtAt: options.builtAt ?? 100,
  snapshotAt: 99,
  discovery: {
    scope: options.scope ?? "current_directory",
    directory: options.directory === undefined && options.scope === "global_unscoped" ? undefined : (options.directory ?? "/repo"),
  },
  settings: {
    includeToolOutputsForIndexing: true,
  },
  sessions: [
    {
      sessionID: "session-1",
      title: options.title ?? "Session title",
      directory: options.directory === undefined && options.scope === "global_unscoped" ? "" : (options.directory ?? "/repo"),
      createdAt: 10,
      updatedAt: 20,
    },
  ],
  cursors: [
    {
      sessionID: "session-1",
      sessionUpdatedAt: 20,
      indexedAt: options.builtAt ?? 100,
    },
  ],
  chunks: [
    {
      chunkID: "session-1:message-1:0",
      sessionID: "session-1",
      messageID: "message-1",
      role: "user",
      partType: "text",
      text: options.text ?? "hello searchable world",
      createdAt: 12,
    },
  ],
  semantic: {
    signature: "jina:test:2",
    builtAt: 180,
    fingerprints: {
      "session-1:message-1:0": "fingerprint-1",
    },
    vectors: {
      "session-1:message-1:0": [0.1, 0.2],
    },
    queries: {
      hello: {
        text: "hello",
        vector: [0.3, 0.4],
        updatedAt: 181,
      },
    },
  },
})
