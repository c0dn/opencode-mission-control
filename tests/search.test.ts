import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG, createMissionControlConfig } from "../src/config.ts"
import { SqliteSearchIndexStore } from "../src/index-db/sqlite-store.ts"
import type { SearchIndexDocument } from "../src/index-db/types.ts"
import { OpenCodeAdapter } from "../src/opencode-client.ts"
import { MissionControlRuntimeState } from "../src/runtime-state.ts"
import type { SemanticEmbeddingProvider } from "../src/semantic-provider.ts"
import { MissionControlSearchService } from "../src/search.ts"
import { MissionControlSourceDB } from "../src/source-db.ts"
import { openMissionControlSqliteDatabase } from "../src/storage/sqlite.ts"

// ---------------------------------------------------------------------------
// V2 adapter helpers — search tests need v2.session.messages for indexing
// ---------------------------------------------------------------------------

/** Convert a classic {info, parts} test fixture to V2 format for getSessionMessages. */
const toV2Item = (classic: any): any => {
  const info = classic?.info ?? {}
  const parts = classic?.parts ?? []
  const time = info.time ?? { created: 0 }
  if (info.role === "user") {
    return { id: info.id, type: "user", time, text: parts.find((p: any) => p.type === "text")?.text ?? "" }
  }
  return {
    id: info.id,
    type: "assistant",
    time,
    ...(info.agent ? { agent: info.agent } : {}),
    content: parts.map((p: any) => {
      if (p.type === "text") return { type: "text", text: p.text ?? "" }
      if (p.type === "reasoning") return { id: p.id, type: "reasoning", text: p.text ?? "" }
      if (p.type === "tool")
        return {
          id: p.id,
          type: "tool",
          name: p.tool ?? p.toolName ?? "unknown",
          state: { status: p.state?.status ?? "completed", content: [{ type: "text", text: p.state?.output ?? p.text ?? "" }], input: {}, structured: {} },
        }
      return { type: p.type, text: p.text ?? "" }
    }),
  }
}

/**
 * Drop-in replacement for `new OpenCodeAdapter(clientDef)` that auto-extracts
 * `session.messages` from clientDef and wraps it as `v2.session.messages` so
 * that the V2-only getSessionMessages path works without a real server.
 *
 * Classic messages signature `({ path: { id }, query })` is mapped to V2
 * params `{ sessionID, directory }` transparently.
 */
const makeV2Adapter = (clientDef: Record<string, any>) => {
  const session = clientDef?.session ?? {}
  const { messages: classicMessages, ...sessionWithoutMessages } = session

  const sdkClient = classicMessages
    ? {
        v2: {
          session: {
            async messages(params: { sessionID: string; directory?: string; limit?: number; order?: string; cursor?: string }) {
              const classics = await classicMessages({
                path: { id: params.sessionID },
                query: typeof params.directory === "string" ? { directory: params.directory } : undefined,
              })
              return { items: (classics ?? []).map(toV2Item), cursor: {} }
            },
          },
        },
      }
    : undefined

  return new OpenCodeAdapter(
    { ...clientDef, session: sessionWithoutMessages },
    sdkClient ? { sdkClient } : undefined,
  )
}

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop()
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

describe("MissionControlSearchService", () => {
  test("indexes sessions and searches child tool output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "root-session",
              directory,
              title: "Root Mission",
              time: { created: 1, updated: 10 },
            },
            {
              id: "child-session",
              directory,
              title: "Child Mission",
              parentID: "root-session",
              time: { created: 2, updated: 11 },
            },
          ]
        },
        async messages({ path }: { path: { id: string } }) {
          if (path.id === "root-session") {
            return [
              {
                info: {
                  id: "message-root",
                  role: "assistant",
                  time: { created: 5 },
                },
                parts: [
                  {
                    id: "part-root",
                    type: "text",
                    text: "Root summary",
                  },
                ],
              },
            ]
          }

          return [
            {
              info: {
                id: "message-child",
                role: "assistant",
                time: { created: 6 },
              },
              parts: [
                {
                  id: "part-child",
                  type: "text",
                  text: "Mission logs mention indexing status",
                },
              ],
            },
          ]
        },
      },
    })

    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    const result = await service.search(adapter, DEFAULT_CONFIG, directory, {
      query: "indexing status",
      sessionId: "root-session",
      includeChildren: true,
      limit: 5,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected lexical search to succeed")
    }

    expect(result.data.matches).toHaveLength(1)
    expect(result.data.matches[0]?.sessionId).toBe("child-session")
    expect(result.data.matches[0]?.snippet).toContain("indexing status")
    expect(result.data.effectiveMode).toBe("lexical")
  })

  test("defaults session-scoped searches to the full subtree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "root-session",
              directory,
              title: "Root Mission",
              time: { created: 1, updated: 10 },
            },
            {
              id: "child-session",
              directory,
              title: "Child Mission",
              parentID: "root-session",
              time: { created: 2, updated: 11 },
            },
          ]
        },
        async messages({ path }: { path: { id: string } }) {
          if (path.id === "root-session") {
            return [
              {
                info: {
                  id: "message-root",
                  role: "assistant",
                  time: { created: 5 },
                },
                parts: [
                  {
                    id: "part-root",
                    type: "text",
                    text: "Root summary",
                  },
                ],
              },
            ]
          }

          return [
            {
              info: {
                id: "message-child",
                role: "assistant",
                time: { created: 6 },
              },
              parts: [
                {
                  id: "part-child",
                  type: "text",
                  text: "descendant-only token",
                },
              ],
            },
          ]
        },
      },
    })

    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    const result = await service.search(adapter, DEFAULT_CONFIG, directory, {
      query: "descendant-only token",
      sessionId: "root-session",
      limit: 5,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected subtree-default search to succeed")
    }

    expect(result.data.matches).toHaveLength(1)
    expect(result.data.matches[0]?.sessionId).toBe("child-session")
  })

  test("supports alternate session parent and timestamp shapes during indexing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "root-session",
              directory,
              title: "Root Mission",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:01.000Z",
            },
            {
              id: "child-session",
              directory,
              title: "Child Mission",
              parentSessionID: "root-session",
              createdAt: "2026-01-01T00:00:02.000Z",
              updatedAt: "2026-01-01T00:00:03.000Z",
            },
          ]
        },
        async messages({ path }: { path: { id: string } }) {
          if (path.id === "root-session") {
            return [
              {
                info: { id: "message-root", role: "assistant", time: { created: 5 } },
                parts: [{ id: "part-root", type: "text", text: "root content" }],
              },
            ]
          }

          return [
            {
              info: { id: "message-child", role: "assistant", time: { created: 6 } },
              parts: [{ id: "part-child", type: "text", text: "alternate-shape token" }],
            },
          ]
        },
      },
    })

    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    const result = await service.search(adapter, DEFAULT_CONFIG, directory, {
      query: "alternate-shape token",
      sessionId: "root-session",
      limit: 5,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected alternate-shape search to succeed")
    }

    expect(result.data.matches).toHaveLength(1)
    expect(result.data.matches[0]?.sessionId).toBe("child-session")
  })

  test("uses a true global discovery scope when the global flag is enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    const otherDirectory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory, otherDirectory)
    const config = createMissionControlConfig({
      search: {
        indexPath: join(directory, "search-index.current_directory.json"),
      },
    })

    const adapter = makeV2Adapter({
      session: {
        async list({ query }: { query?: { directory?: string } } = {}) {
          if (query?.directory === "") {
            return [
              {
                id: "local-session",
                directory,
                title: "Local Session",
                time: { created: 1, updated: 10 },
              },
              {
                id: "global-session",
                directory: otherDirectory,
                title: "Global Session",
                time: { created: 2, updated: 11 },
              },
            ]
          }

          return [
            {
              id: "local-session",
              directory,
              title: "Local Session",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages({ path, query }: { path: { id: string }; query?: { directory?: string } }) {
          if (path.id === "local-session") {
            expect(query?.directory).toBe(directory)
            return [
              {
                info: { id: "message-local", role: "assistant", time: { created: 5 } },
                parts: [{ id: "part-local", type: "text", text: "local session note" }],
              },
            ]
          }

          expect(path.id).toBe("global-session")
          expect(query?.directory).toBe(otherDirectory)
          return [
            {
              info: { id: "message-global", role: "assistant", time: { created: 6 } },
              parts: [{ id: "part-global", type: "text", text: "rareglobaltoken evidence" }],
            },
          ]
        },
      },
    })

    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))

    const scopedResult = await service.search(adapter, config, directory, {
      query: "rareglobaltoken",
    })

    expect(scopedResult.ok).toBe(true)
    if (!scopedResult.ok) {
      throw new Error("Expected scoped search to succeed")
    }

    expect(scopedResult.data.discoveryScope).toBe("current_directory")
    expect(scopedResult.data.indexedSessionCount).toBe(1)
    expect(scopedResult.data.matches).toHaveLength(0)
    expect(scopedResult.data.indexPath).toContain("current_directory")

    const globalResult = await service.search(adapter, config, directory, {
      query: "rareglobaltoken",
      scope: "global",
    })

    expect(globalResult.ok).toBe(true)
    if (!globalResult.ok) {
      throw new Error("Expected global search to succeed")
    }

    expect(globalResult.data.discoveryScope).toBe("global_unscoped")
    expect(globalResult.data.indexedSessionCount).toBe(2)
    expect(globalResult.data.matches[0]?.sessionId).toBe("global-session")
    expect(globalResult.data.indexPath).toContain("global_unscoped")
    expect(globalResult.data.indexPath).not.toBe(scopedResult.data.indexPath)
  })

  test("incrementally reindexes only changed sessions and persists per-session cursors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    let revision = 1
    const messageCalls = new Map<string, number>()

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "session-a",
              directory,
              title: "Session A",
              time: { created: 1, updated: revision === 1 ? 10 : 11 },
            },
            {
              id: "session-b",
              directory,
              title: "Session B",
              time: { created: 2, updated: 20 },
            },
          ]
        },
        async messages({ path }: { path: { id: string } }) {
          messageCalls.set(path.id, (messageCalls.get(path.id) ?? 0) + 1)

          if (path.id === "session-a") {
            return [
              {
                info: { id: "message-a", role: "assistant", time: { created: 5 } },
                parts: [{ id: "part-a", type: "text", text: revision === 1 ? "alpha old" : "alpha updated" }],
              },
            ]
          }

          return [
            {
              info: { id: "message-b", role: "assistant", time: { created: 6 } },
              parts: [{ id: "part-b", type: "text", text: "beta stable" }],
            },
          ]
        },
      },
    })

    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))

    const first = await service.search(adapter, DEFAULT_CONFIG, directory, { query: "beta stable" })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      throw new Error("Expected initial incremental search to succeed")
    }

    revision = 2

    const second = await service.search(adapter, DEFAULT_CONFIG, directory, { query: "alpha updated" })
    expect(second.ok).toBe(true)
    if (!second.ok) {
      throw new Error("Expected incremental update search to succeed")
    }

    expect(messageCalls.get("session-a")).toBe(2)
    expect(messageCalls.get("session-b")).toBe(1)

    const persistedIndex = loadPersistedIndex(second.data.indexPath, "current_directory")

    expect(persistedIndex.cursors?.map((cursor) => cursor.sessionID).sort()).toEqual(["session-a", "session-b"])
    expect(persistedIndex.cursors?.find((cursor) => cursor.sessionID === "session-a")?.sessionUpdatedAt).toBe(11)
    expect(persistedIndex.cursors?.find((cursor) => cursor.sessionID === "session-b")?.sessionUpdatedAt).toBe(20)
  })

  test("does not index tool outputs unless explicitly enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "tool-session",
              directory,
              title: "Tool Session",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages() {
          return [
            {
              info: {
                id: "message-tool",
                role: "assistant",
                time: { created: 5 },
              },
              parts: [
                {
                  id: "part-tool",
                  type: "tool",
                  tool: "read",
                  state: {
                    status: "completed",
                    output: "super secret indexing token",
                  },
                },
              ],
            },
          ]
        },
      },
    })

    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    const disabledResult = await service.search(
      adapter,
      DEFAULT_CONFIG,
      directory,
      {
        query: "super secret indexing token",
      },
      undefined,
    )

    expect(disabledResult.ok).toBe(true)
    if (!disabledResult.ok) {
      throw new Error("Expected search with default config to succeed")
    }

    expect(disabledResult.data.matches).toHaveLength(0)

    const enabledResult = await service.search(
      adapter,
      createMissionControlConfig({
        search: {
          includeToolOutputsForIndexing: true,
        },
      }),
      directory,
      {
        query: "super secret indexing token",
      },
      undefined,
    )

    expect(enabledResult.ok).toBe(true)
    if (!enabledResult.ok) {
      throw new Error("Expected opt-in search to succeed")
    }

    expect(enabledResult.data.matches).toHaveLength(1)
  })

  test("falls back to lexical results when semantic mode is requested without a configured provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "root-session",
              directory,
              title: "Root Mission",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages() {
          return [
            {
              info: {
                id: "message-root",
                role: "assistant",
                time: { created: 5 },
              },
              parts: [
                {
                  id: "part-root",
                  type: "text",
                  text: "Mission control semantic fallback still finds lexical evidence",
                },
              ],
            },
          ]
        },
      },
    })

    const config = createMissionControlConfig({
      search: {
        semanticEnabled: true,
        semanticProvider: "jina",
      },
    })
    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    const result = await service.search(
      adapter,
      config,
      directory,
      {
        query: "lexical evidence",
        mode: "semantic",
      },
      undefined,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected fallback search to succeed")
    }

    expect(result.data.effectiveMode).toBe("lexical")
    expect(result.data.warnings.length).toBeGreaterThan(0)
    expect(result.data.matches).toHaveLength(1)
  })

  test("does not return title-only lexical matches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "title-only-session",
              directory,
              title: "UniqueTitleOnlyToken",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages() {
          return [
            {
              info: { id: "message-title-only", role: "assistant", time: { created: 5 } },
              parts: [{ id: "part-title-only", type: "text", text: "ordinary transcript content" }],
            },
          ]
        },
      },
    })

    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    const result = await service.search(adapter, DEFAULT_CONFIG, directory, {
      query: "UniqueTitleOnlyToken",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected title-only lexical search to succeed")
    }

    expect(result.data.matches).toHaveLength(0)
  })

  test("forces lexical retrieval when exact is requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "exact-session",
              directory,
              title: "Exact Session",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages() {
          return [
            {
              info: {
                id: "message-exact",
                role: "assistant",
                time: { created: 5 },
              },
              parts: [
                {
                  id: "part-exact",
                  type: "text",
                  text: "HTX exact token recorded here",
                },
              ],
            },
          ]
        },
      },
    })

    const config = createMissionControlConfig({
      search: {
        defaultMode: "hybrid",
        semanticEnabled: true,
        semanticProvider: "jina",
      },
    })
    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    let queryCalls = 0
    const provider: SemanticEmbeddingProvider = {
      name: "jina",
      isAvailable: () => true,
      availabilityWarning: () => undefined,
      signature: () => "exact-provider",
      embedQuery: async () => {
        queryCalls += 1
        return [1, 0]
      },
      embedPassages: async (texts: string[]) => texts.map(() => [1, 0]),
    }

    const result = await service.search(adapter, config, directory, {
      query: "HTX",
      exact: true,
    }, provider)

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected exact lexical search to succeed")
    }

    expect(result.data.requestedMode).toBe("lexical")
    expect(result.data.effectiveMode).toBe("lexical")
    expect(result.data.matches).toHaveLength(1)
    expect(result.data.matches[0]?.matchType).toBe("exact")
    expect(queryCalls).toBe(0)
  })

  test("warns when exact mode only finds ranked lexical candidates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "candidate-session",
              directory,
              title: "Candidate Session",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages() {
          return [
            {
              info: {
                id: "message-candidate",
                role: "assistant",
                time: { created: 5 },
              },
              parts: [
                {
                  id: "part-candidate",
                  type: "text",
                  text: "HTX exact token recorded here",
                },
              ],
            },
          ]
        },
      },
    })

    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    const result = await service.search(adapter, DEFAULT_CONFIG, directory, {
      query: "HTX missing",
      exact: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected exact lexical candidate search to succeed")
    }

    expect(result.data.matches).toHaveLength(1)
    expect(result.data.matches[0]?.matchType).toBe("candidate")
    expect(result.data.warnings).toContain("No exact lexical hits were found; returning ranked lexical candidates instead.")
  })

  test("does not mark path or hyphenated prefixes as exact hits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "prefix-session",
              directory,
              title: "Prefix Session",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages() {
          return [
            {
              info: {
                id: "message-prefix",
                role: "assistant",
                time: { created: 5 },
              },
              parts: [
                {
                  id: "part-prefix",
                  type: "text",
                  text: "mission-control-job and foo/bar/baz are only longer prefixes.",
                },
              ],
            },
          ]
        },
      },
    })

    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    const result = await service.search(adapter, DEFAULT_CONFIG, directory, {
      query: "mission-control",
      exact: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected hyphen-prefix exact search to succeed")
    }

    expect(result.data.matches).toHaveLength(1)
    expect(result.data.matches[0]?.matchType).toBe("candidate")
    expect(result.data.warnings).toContain("No exact lexical hits were found; returning ranked lexical candidates instead.")
  })

  test("ranks exact lexical hits ahead of candidates before applying the result limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "candidate-session",
              directory,
              title: "Candidate Session",
              time: { created: 1, updated: 10 },
            },
            {
              id: "exact-text-session",
              directory,
              title: "mission-control",
              time: { created: 2, updated: 11 },
            },
          ]
        },
        async messages({ path }: { path: { id: string } }) {
          if (path.id === "candidate-session") {
            return [
              {
                info: { id: "candidate-message", role: "assistant", time: { created: 5 } },
                parts: [{ id: "candidate-part", type: "text", text: "mission-control-job is only a longer prefix." }],
              },
            ]
          }

          return [
            {
              info: { id: "exact-message", role: "assistant", time: { created: 6 } },
              parts: [{ id: "exact-part", type: "text", text: "mission-control exact hit" }],
            },
          ]
        },
      },
    })

    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    const result = await service.search(adapter, DEFAULT_CONFIG, directory, {
      query: "mission-control",
      exact: true,
      limit: 1,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected exact-first lexical search to succeed")
    }

    expect(result.data.matches).toHaveLength(1)
    expect(result.data.matches[0]?.sessionId).toBe("exact-text-session")
    expect(result.data.matches[0]?.matchType).toBe("exact")
    expect(result.data.warnings).toEqual([])
  })

  test("auto-selects hybrid retrieval for bare acronym queries when semantic is available", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "acronym-session",
              directory,
              title: "Acronym Session",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages() {
          return [
            {
              info: {
                id: "message-acronym",
                role: "assistant",
                time: { created: 5 },
              },
              parts: [
                {
                  id: "part-acronym",
                  type: "text",
                  text: "HTX challenge notes are stored here",
                },
              ],
            },
          ]
        },
      },
    })

    const config = createMissionControlConfig({
      search: {
        defaultMode: "hybrid",
        semanticEnabled: true,
        semanticProvider: "jina",
      },
    })
    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    const provider: SemanticEmbeddingProvider = {
      name: "jina",
      isAvailable: () => true,
      availabilityWarning: () => undefined,
      signature: () => "acronym-provider",
      embedQuery: async () => [1, 0],
      embedPassages: async (texts: string[]) => texts.map(() => [1, 0]),
    }
    const result = await service.search(adapter, config, directory, {
      query: "HTX",
    }, provider)

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected acronym lexical search to succeed")
    }

    expect(result.data.requestedMode).toBe("hybrid")
    expect(result.data.effectiveMode).toBe("hybrid")
    expect(result.data.matches).toHaveLength(1)
    expect(result.data.matches[0]?.matchType).toBe("exact")
  })

  test("normalizes quoted queries while still using automatic hybrid retrieval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "quoted-session",
              directory,
              title: "Quoted Session",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages() {
          return [
            {
              info: {
                id: "message-quoted",
                role: "assistant",
                time: { created: 5 },
              },
              parts: [
                {
                  id: "part-quoted",
                  type: "text",
                  text: "The transcript mentions indexing status without quote characters.",
                },
              ],
            },
          ]
        },
      },
    })

    const config = createMissionControlConfig({
      search: {
        defaultMode: "hybrid",
        semanticEnabled: true,
        semanticProvider: "jina",
      },
    })
    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    const provider: SemanticEmbeddingProvider = {
      name: "jina",
      isAvailable: () => true,
      availabilityWarning: () => undefined,
      signature: () => "quoted-provider",
      embedQuery: async () => [1, 0],
      embedPassages: async (texts: string[]) => texts.map(() => [1, 0]),
    }
    const result = await service.search(adapter, config, directory, {
      query: '"indexing status"',
    }, provider)

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected quoted lexical search to succeed")
    }

    expect(result.data.requestedMode).toBe("hybrid")
    expect(result.data.effectiveMode).toBe("hybrid")
    expect(result.data.matches).toHaveLength(1)
  })

  test("uses hybrid embeddings when a provider is available", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "session-a",
              directory,
              title: "Alpha",
              time: { created: 1, updated: 10 },
            },
            {
              id: "session-b",
              directory,
              title: "Beta",
              time: { created: 2, updated: 11 },
            },
          ]
        },
        async messages({ path }: { path: { id: string } }) {
          if (path.id === "session-a") {
            return [
              {
                info: { id: "message-a", role: "assistant", time: { created: 5 } },
                parts: [{ id: "part-a", type: "text", text: "Alpha chunk" }],
              },
            ]
          }

          return [
            {
              info: { id: "message-b", role: "assistant", time: { created: 6 } },
              parts: [{ id: "part-b", type: "text", text: "Beta chunk" }],
            },
          ]
        },
      },
    })

    const provider: SemanticEmbeddingProvider = {
      name: "jina",
      isAvailable: () => true,
      availabilityWarning: () => undefined,
      signature: () => "fake-jina-signature",
      embedQuery: async () => [1, 0],
      embedPassages: async (texts: string[]) =>
        texts.map((text) => (text.includes("Alpha") ? [1, 0] : [0, 1])),
    }

    const config = createMissionControlConfig({
      search: {
        semanticEnabled: true,
        semanticProvider: "jina",
      },
    })
    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    const result = await service.search(
      adapter,
      config,
      directory,
      {
        query: "meaning unrelated to lexical terms",
      },
      provider,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected semantic search to succeed")
    }

    expect(result.data.effectiveMode).toBe("hybrid")
    expect(result.data.matches[0]?.sessionId).toBe("session-a")
  })

  test("reuses a persisted query embedding for repeated semantic searches with the same query", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    let queryCalls = 0
    let passageCalls = 0

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "session-query-cache",
              directory,
              title: "Query Cache Session",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages() {
          return [
            {
              info: { id: "message-query-cache", role: "assistant", time: { created: 5 } },
              parts: [{ id: "part-query-cache", type: "text", text: "cached semantic content" }],
            },
          ]
        },
      },
    })

    const provider: SemanticEmbeddingProvider = {
      name: "jina",
      isAvailable: () => true,
      availabilityWarning: () => undefined,
      signature: () => "query-cache-signature",
      embedQuery: async () => {
        queryCalls += 1
        return [1, 0]
      },
      embedPassages: async (texts: string[]) => {
        passageCalls += texts.length
        return texts.map(() => [1, 0])
      },
    }

    const config = createMissionControlConfig({
      search: {
        semanticEnabled: true,
        semanticProvider: "jina",
      },
    })
    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))

    const first = await service.search(adapter, config, directory, { query: "semantic cache query", mode: "semantic" }, provider)
    expect(first.ok).toBe(true)

    const second = await service.search(adapter, config, directory, { query: "semantic cache query", mode: "semantic" }, provider)
    expect(second.ok).toBe(true)

    expect(queryCalls).toBe(1)
    expect(passageCalls).toBe(1)
  })

  test("invalidates persisted query embeddings when the semantic signature changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    let queryCalls = 0
    let signature = "query-cache-signature-a"

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "session-query-signature",
              directory,
              title: "Query Signature Session",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages() {
          return [
            {
              info: { id: "message-query-signature", role: "assistant", time: { created: 5 } },
              parts: [{ id: "part-query-signature", type: "text", text: "signature sensitive semantic content" }],
            },
          ]
        },
      },
    })

    const provider: SemanticEmbeddingProvider = {
      name: "jina",
      isAvailable: () => true,
      availabilityWarning: () => undefined,
      signature: () => signature,
      embedQuery: async () => {
        queryCalls += 1
        return signature.endsWith("a") ? [1, 0] : [0, 1]
      },
      embedPassages: async (texts: string[]) => texts.map(() => [1, 0]),
    }

    const config = createMissionControlConfig({
      search: {
        semanticEnabled: true,
        semanticProvider: "jina",
      },
    })
    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))

    const first = await service.search(adapter, config, directory, { query: "semantic cache query", mode: "semantic" }, provider)
    expect(first.ok).toBe(true)

    signature = "query-cache-signature-b"

    const second = await service.search(adapter, config, directory, { query: "semantic cache query", mode: "semantic" }, provider)
    expect(second.ok).toBe(true)

    expect(queryCalls).toBe(2)
  })

  test("prunes deleted chunk vectors from the persisted semantic cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    let revision = 1
    let passageCalls = 0

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return revision === 1
            ? [
                {
                  id: "session-keep",
                  directory,
                  title: "Keep Session",
                  time: { created: 1, updated: 10 },
                },
                {
                  id: "session-delete",
                  directory,
                  title: "Delete Session",
                  time: { created: 2, updated: 11 },
                },
              ]
            : [
                {
                  id: "session-keep",
                  directory,
                  title: "Keep Session",
                  time: { created: 1, updated: 10 },
                },
              ]
        },
        async messages({ path }: { path: { id: string } }) {
          return [
            {
              info: { id: `${path.id}-message`, role: "assistant", time: { created: 5 } },
              parts: [{ id: `${path.id}-part`, type: "text", text: `${path.id} semantic content` }],
            },
          ]
        },
      },
    })

    const provider: SemanticEmbeddingProvider = {
      name: "jina",
      isAvailable: () => true,
      availabilityWarning: () => undefined,
      signature: () => "prune-signature",
      embedQuery: async () => [1, 0],
      embedPassages: async (texts: string[]) => {
        passageCalls += texts.length
        return texts.map((text) => (text.includes("keep") ? [1, 0] : [0, 1]))
      },
    }

    const config = createMissionControlConfig({
      search: {
        semanticEnabled: true,
        semanticProvider: "jina",
      },
    })
    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))

    const first = await service.search(adapter, config, directory, { query: "keep", mode: "semantic" }, provider)
    expect(first.ok).toBe(true)
    if (!first.ok) {
      throw new Error("Expected initial prune search to succeed")
    }

    revision = 2

    const second = await service.search(adapter, config, directory, { query: "keep", mode: "semantic" }, provider)
    expect(second.ok).toBe(true)
    if (!second.ok) {
      throw new Error("Expected deletion prune search to succeed")
    }

    const persistedIndex = loadPersistedIndex(second.data.indexPath, "current_directory")

    // V2 text parts have no explicit ID → positional fallback: sessionID:messageID:partIndex
    expect(Object.keys(persistedIndex.semantic?.vectors ?? {})).toEqual(["session-keep:session-keep-message:0"])
    expect(Object.keys(persistedIndex.semantic?.fingerprints ?? {})).toEqual(["session-keep:session-keep-message:0"])
    expect(passageCalls).toBe(2)
  })

  test("refreshes recency for reused query embeddings once the query cache is full", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    let queryCalls = 0

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "session-query-lru",
              directory,
              title: "Query LRU Session",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages() {
          return [
            {
              info: { id: "message-query-lru", role: "assistant", time: { created: 5 } },
              parts: [{ id: "part-query-lru", type: "text", text: "query cache overflow content" }],
            },
          ]
        },
      },
    })

    const provider: SemanticEmbeddingProvider = {
      name: "jina",
      isAvailable: () => true,
      availabilityWarning: () => undefined,
      signature: () => "query-lru-signature",
      embedQuery: async () => {
        queryCalls += 1
        return [1, 0]
      },
      embedPassages: async (texts: string[]) => texts.map(() => [1, 0]),
    }

    const config = createMissionControlConfig({
      search: {
        semanticEnabled: true,
        semanticProvider: "jina",
      },
    })
    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))

    const firstHot = await service.search(adapter, config, directory, { query: "hot-query", mode: "semantic" }, provider)
    expect(firstHot.ok).toBe(true)

    for (let index = 0; index < 126; index += 1) {
      const cold = await service.search(
        adapter,
        config,
        directory,
        { query: `cold-query-${index}`, mode: "semantic" },
        provider,
      )
      expect(cold.ok).toBe(true)
    }

    const secondHot = await service.search(adapter, config, directory, { query: "hot-query", mode: "semantic" }, provider)
    expect(secondHot.ok).toBe(true)

    for (let index = 126; index < 128; index += 1) {
      const cold = await service.search(
        adapter,
        config,
        directory,
        { query: `cold-query-${index}`, mode: "semantic" },
        provider,
      )
      expect(cold.ok).toBe(true)
    }

    const finalHot = await service.search(adapter, config, directory, { query: "hot-query", mode: "semantic" }, provider)
    expect(finalHot.ok).toBe(true)
    if (!finalHot.ok) {
      throw new Error("Expected final hot-query semantic search to succeed")
    }
    expect(queryCalls).toBe(129)

    const persistedIndex = loadPersistedIndex(finalHot.data.indexPath, "current_directory")
    expect(Object.keys(persistedIndex.semantic?.queries ?? {})).toHaveLength(128)
  })

  test("re-embeds a chunk when its text changes under the same chunk id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    let revision = 1
    let embedCalls = 0

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "session-stable",
              directory,
              title: "Stable Session",
              time: { created: 1, updated: revision },
            },
          ]
        },
        async messages() {
          return [
            {
              info: { id: "message-stable", role: "assistant", time: { created: 5 } },
              parts: [
                {
                  id: "part-stable",
                  type: "text",
                  text: revision === 1 ? "Original semantic content" : "Updated semantic content",
                },
              ],
            },
          ]
        },
      },
    })

    const provider: SemanticEmbeddingProvider = {
      name: "jina",
      isAvailable: () => true,
      availabilityWarning: () => undefined,
      signature: () => "fake-jina-signature",
      embedQuery: async () => [0, 1],
      embedPassages: async (texts: string[]) => {
        embedCalls += texts.length
        return texts.map((text) => (text.includes("Updated") ? [0, 1] : [1, 0]))
      },
    }

    const config = createMissionControlConfig({
      search: {
        semanticEnabled: true,
        semanticProvider: "jina",
      },
    })
    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))

    const first = await service.search(adapter, config, directory, { query: "updated", mode: "semantic" }, provider)
    expect(first.ok).toBe(true)
    if (!first.ok) {
      throw new Error("Expected first semantic search to succeed")
    }
    expect(first.data.matches[0]?.score).toBeLessThan(1)

    revision = 2

    const second = await service.search(adapter, config, directory, { query: "updated", mode: "semantic" }, provider)
    expect(second.ok).toBe(true)
    if (!second.ok) {
      throw new Error("Expected second semantic search to succeed")
    }

    expect(second.data.matches[0]?.snippet).toContain("Updated semantic content")
    expect(second.data.matches[0]?.score ?? 0).toBeGreaterThan(first.data.matches[0]?.score ?? 0)
    expect(embedCalls).toBe(2)
  })

  test("falls back to lexical matches when the semantic provider fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "provider-fallback",
              directory,
              title: "Provider Fallback",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages() {
          return [
            {
              info: { id: "message-provider-fallback", role: "assistant", time: { created: 5 } },
              parts: [{ id: "part-provider-fallback", type: "text", text: "lexical fallback survives provider failure" }],
            },
          ]
        },
      },
    })

    const failingProvider: SemanticEmbeddingProvider = {
      name: "jina",
      isAvailable: () => true,
      availabilityWarning: () => undefined,
      signature: () => "failing-provider-fallback",
      embedQuery: async () => [1, 0],
      embedPassages: async () => {
        throw new Error("provider failed")
      },
    }

    const config = createMissionControlConfig({
      search: {
        semanticEnabled: true,
        semanticProvider: "jina",
      },
    })
    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    const result = await service.search(adapter, config, directory, { query: "lexical fallback" }, failingProvider)

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected provider failure to fall back to lexical")
    }
    expect(result.data.effectiveMode).toBe("lexical")
    expect(result.data.matches).toHaveLength(1)
    expect(result.data.warnings[0]).toContain("Semantic search failed and fell back to lexical mode")
  })

  test("returns an error when semantic search fails and lexical fallback is disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "semantic-only",
              directory,
              title: "Semantic Only",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages() {
          return [
            {
              info: { id: "message-only", role: "assistant", time: { created: 5 } },
              parts: [{ id: "part-only", type: "text", text: "semantic-only content" }],
            },
          ]
        },
      },
    })

    const failingProvider: SemanticEmbeddingProvider = {
      name: "jina",
      isAvailable: () => true,
      availabilityWarning: () => undefined,
      signature: () => "failing-provider",
      embedQuery: async () => [1, 0],
      embedPassages: async () => {
        throw new Error("provider failed")
      },
    }

    const config = createMissionControlConfig({
      search: {
        lexicalEnabled: false,
        semanticEnabled: true,
        semanticProvider: "jina",
      },
    })
    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    const result = await service.search(
      adapter,
      config,
      directory,
      { query: "semantic-only", mode: "semantic" },
      failingProvider,
    )

    expect(result.ok).toBe(false)
  })

  test("rebuilds the lexical index when a message part update marks the session dirty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    let revision = 1
    const adapter = makeV2Adapter({
      session: {
        async list() {
          return [
            {
              id: "dirty-session",
              directory,
              title: "Dirty Session",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages() {
          return [
            {
              info: { id: "message-dirty", role: "assistant", time: { created: 5 } },
              parts: [
                {
                  id: "part-dirty",
                  type: "text",
                  text: revision === 1 ? "original indexed token" : "refreshed indexed token",
                },
              ],
            },
          ]
        },
      },
    })

    const runtimeState = new MissionControlRuntimeState(20)
    const service = new MissionControlSearchService(new MissionControlSourceDB(), runtimeState)

    const first = await service.search(adapter, DEFAULT_CONFIG, directory, { query: "original indexed token" })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      throw new Error("Expected initial lexical search to succeed")
    }
    expect(first.data.matches[0]?.snippet).toContain("original indexed token")

    revision = 2
    runtimeState.recordEvent("message.part.updated", { sessionID: "dirty-session" })

    const second = await service.search(adapter, DEFAULT_CONFIG, directory, { query: "refreshed indexed token" })
    expect(second.ok).toBe(true)
    if (!second.ok) {
      throw new Error("Expected dirty-session lexical search to succeed")
    }

    expect(second.data.matches[0]?.snippet).toContain("refreshed indexed token")
    expect(runtimeState.isSessionDirty("dirty-session")).toBe(false)
  })

  test("returns a global discovery error when unscoped session enumeration fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory)

    const adapter = makeV2Adapter({
      session: {
        async list({ query }: { query?: { directory?: string } } = {}) {
          if (query?.directory === "") {
            throw new Error("unscoped session list unavailable")
          }

          return []
        },
      },
    })

    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))
    const result = await service.search(adapter, DEFAULT_CONFIG, directory, {
      query: "anything",
      scope: "global",
    })

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error("Expected global search to fail when global discovery is unavailable")
    }

    expect(result.error.code).toBe("GlobalSessionDiscoveryUnavailable")
  })

  test("keeps a custom current-directory indexPath exact while using a sibling file for global scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    const otherDirectory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory, otherDirectory)

    const adapter = makeV2Adapter({
      session: {
        async list({ query }: { query?: { directory?: string } } = {}) {
          if (query?.directory === "") {
            return [
              {
                id: "local-session",
                directory,
                title: "Local Session",
                time: { created: 1, updated: 10 },
              },
              {
                id: "global-session",
                directory: otherDirectory,
                title: "Global Session",
                time: { created: 2, updated: 11 },
              },
            ]
          }

          return [
            {
              id: "local-session",
              directory,
              title: "Local Session",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages({ path }: { path: { id: string } }) {
          return [
            {
              info: { id: `${path.id}-message`, role: "assistant", time: { created: 5 } },
              parts: [{ id: `${path.id}-part`, type: "text", text: `${path.id} content` }],
            },
          ]
        },
      },
    })

    const configuredIndexPath = join(directory, "custom-index.json")
    const config = createMissionControlConfig({
      search: {
        indexPath: configuredIndexPath,
      },
    })
    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))

    const localResult = await service.search(adapter, config, directory, { query: "local-session content" })
    expect(localResult.ok).toBe(true)
    if (!localResult.ok) {
      throw new Error("Expected local custom-path search to succeed")
    }
    expect(localResult.data.indexPath).toBe(join(directory, "custom-index.sqlite3"))

    const globalResult = await service.search(adapter, config, directory, {
      query: "global-session content",
      scope: "global",
    })
    expect(globalResult.ok).toBe(true)
    if (!globalResult.ok) {
      throw new Error("Expected global custom-path search to succeed")
    }
    expect(globalResult.data.indexPath).toBe(join(directory, "custom-index.global_unscoped.sqlite3"))
  })

  test("reuses an already-scoped custom indexPath without double-appending the scope suffix", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    const otherDirectory = await mkdtemp(join(tmpdir(), "mission-control-search-"))
    tempDirs.push(directory, otherDirectory)

    const adapter = makeV2Adapter({
      session: {
        async list({ query }: { query?: { directory?: string } } = {}) {
          if (query?.directory === "") {
            return [
              {
                id: "local-session",
                directory,
                title: "Local Session",
                time: { created: 1, updated: 10 },
              },
              {
                id: "global-session",
                directory: otherDirectory,
                title: "Global Session",
                time: { created: 2, updated: 11 },
              },
            ]
          }

          return [
            {
              id: "local-session",
              directory,
              title: "Local Session",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages({ path }: { path: { id: string } }) {
          return [
            {
              info: { id: `${path.id}-message`, role: "assistant", time: { created: 5 } },
              parts: [{ id: `${path.id}-part`, type: "text", text: `${path.id} content` }],
            },
          ]
        },
      },
    })

    const configuredIndexPath = join(directory, "custom-index.current_directory.json")
    const config = createMissionControlConfig({
      search: {
        indexPath: configuredIndexPath,
      },
    })
    const service = new MissionControlSearchService(new MissionControlSourceDB(), new MissionControlRuntimeState(20))

    const localResult = await service.search(adapter, config, directory, { query: "local-session content" })
    expect(localResult.ok).toBe(true)
    if (!localResult.ok) {
      throw new Error("Expected local scoped custom-path search to succeed")
    }
    expect(localResult.data.indexPath).toBe(join(directory, "custom-index.current_directory.sqlite3"))

    const globalResult = await service.search(adapter, config, directory, {
      query: "global-session content",
      scope: "global",
    })
    expect(globalResult.ok).toBe(true)
    if (!globalResult.ok) {
      throw new Error("Expected global scoped custom-path search to succeed")
    }
    expect(globalResult.data.indexPath).toBe(join(directory, "custom-index.global_unscoped.sqlite3"))
  })
})

const loadPersistedIndex = (indexPath: string, scope: SearchIndexDocument["discovery"]["scope"]) => {
  const sqlite = openMissionControlSqliteDatabase(indexPath)
  try {
    return new SqliteSearchIndexStore({ sqlite }).loadScopedSnapshot(scope) ?? ({ cursors: [], semantic: undefined } as Partial<SearchIndexDocument>)
  } finally {
    sqlite.close()
  }
}
