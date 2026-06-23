import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG, createMissionControlConfig } from "../src/config.ts"
import { MissionControlServer } from "../src/server.ts"

// ---------------------------------------------------------------------------
// V2 helpers — server tests pass client.session.messages in classic format.
// wrapWithV2Messages extracts that function and re-exposes it as a raw client
// GET handler for /api/session/{id}/message returning V2 {items, cursor} so
// that the V2-only getSessionMessages path works without a real server.
// ---------------------------------------------------------------------------

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
      if (p.type === "tool")
        return { id: p.id, type: "tool", name: p.tool ?? p.toolName ?? "unknown", state: { status: "completed", content: [{ type: "text", text: p.state?.output ?? p.text ?? "" }], input: {}, structured: {} } }
      return { type: p.type, text: p.text ?? "" }
    }),
  }
}

/**
 * Wrap a classic server client so session.messages is exposed through a raw
 * GET handler for the V2 /api/session/{id}/message endpoint, while all other
 * paths (session listing, get, children) delegate back to the original session
 * methods so the rest of the adapter still works normally.
 */
const wrapWithV2Messages = (client: Record<string, any>): Record<string, any> => {
  const session = client?.session ?? {}
  const { messages: classicMessages, list: listFn, get: getFn, children: childrenFn, ...sessionRest } = session

  if (!classicMessages) return client

  return {
    ...client,
    session: sessionRest,
    _client: {
      async get(options: { url?: string; query?: Record<string, unknown> }) {
        const url = options?.url ?? ""

        // V2 message path — return projected V2 items
        const msgMatch = url.match(/^\/api\/session\/([^/]+)\/message$/)
        if (msgMatch) {
          const sessionID = decodeURIComponent(msgMatch[1]!)
          const dir = typeof options?.query?.directory === "string" ? options.query.directory : undefined
          const classics = await classicMessages({ path: { id: sessionID }, query: dir ? { directory: dir } : undefined })
          return { data: { items: (classics ?? []).map(toV2Item), cursor: {} } }
        }

        // Session listing (/session or /experimental/session)
        if (url === "/session" || url === "/experimental/session") {
          const result = listFn ? await listFn({ query: options?.query }) : []
          return { data: result }
        }

        // Session get (/session/{id})
        const getMatch = url.match(/^\/session\/([^/?]+)$/)
        if (getMatch) {
          const id = decodeURIComponent(getMatch[1]!)
          const result = getFn ? await getFn({ path: { id }, query: options?.query }) : { id }
          return { data: result }
        }

        // Children (/session/{id}/children)
        const childMatch = url.match(/^\/session\/([^/]+)\/children$/)
        if (childMatch) {
          const id = decodeURIComponent(childMatch[1]!)
          const result = childrenFn ? await childrenFn({ path: { id }, query: options?.query }) : []
          return { data: result }
        }

        throw new Error(`Unexpected raw url in V2 test shim: ${url}`)
      },
    },
  }
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

describe("MissionControlServer", () => {
  test("does not reuse disposed servers from the global context store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-server-store-"))
    tempDirs.push(directory)
    const context = {
      client: {
        session: {},
        app: {
          async log() {
            return undefined
          },
        },
      },
      directory,
      worktree: directory,
    }

    const first = await MissionControlServer.fromContext(context, DEFAULT_CONFIG, { search: {} })
    await first.dispose()
    const second = await MissionControlServer.fromContext(context, DEFAULT_CONFIG, { search: {} })

    expect(second).not.toBe(first)
    await second.dispose()
  })

  test("search result carries built index metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-server-"))
    tempDirs.push(directory)

    const server = new MissionControlServer(
      {
        client: wrapWithV2Messages({
          session: {
            async list() {
              return [{ id: "server-session", directory, title: "Server Session", time: { created: 1, updated: 10 } }]
            },
            async messages() {
              return [
                {
                  info: { id: "server-message", role: "assistant", time: { created: 5 } },
                  parts: [{ id: "server-part", type: "text", text: "server indexed content" }],
                },
              ]
            },
          },
          app: { async log() { return undefined } },
        }),
        directory,
        worktree: directory,
      },
      DEFAULT_CONFIG,
      { search: {} },
    )

    const searchResult = await server.searchSessions({ query: "server indexed content" })
    expect(searchResult.ok).toBe(true)
    if (!searchResult.ok) throw new Error("search failed")

    expect(searchResult.data.indexPath).toContain("opencode-mission-control")
    expect(searchResult.data.builtAt).toBeDefined()
    expect(searchResult.data.discoveryScope).toBe("current_directory")
    expect(searchResult.data.discoveryDirectory).toBe(directory)
    expect(searchResult.data.indexedSessionCount).toBe(1)
  })

  test("search result reflects the correct scope-specific index", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-server-"))
    const otherDirectory = await mkdtemp(join(tmpdir(), "mission-control-server-"))
    tempDirs.push(directory, otherDirectory)
    const config = createMissionControlConfig({
      search: {
        indexPath: join(directory, "server-index.current_directory.json"),
      },
    })

    const server = new MissionControlServer(
      {
        client: wrapWithV2Messages({
          session: {
            async list({ query }: { query?: { directory?: string } } = {}) {
              if (query?.directory === "") {
                return [
                  { id: "local-session", directory, title: "Local Session", time: { created: 1, updated: 10 } },
                  { id: "global-session", directory: otherDirectory, title: "Global Session", time: { created: 2, updated: 11 } },
                ]
              }
              return [{ id: "local-session", directory, title: "Local Session", time: { created: 1, updated: 10 } }]
            },
            async messages({ path, query }: { path: { id: string }; query?: { directory?: string } }) {
              if (path.id === "local-session") {
                expect(query?.directory).toBe(directory)
                return [{ info: { id: "local-message", role: "assistant", time: { created: 5 } }, parts: [{ id: "local-part", type: "text", text: "local indexed content" }] }]
              }
              expect(path.id).toBe("global-session")
              expect(query?.directory).toBe(otherDirectory)
              return [{ info: { id: "global-message", role: "assistant", time: { created: 6 } }, parts: [{ id: "global-part", type: "text", text: "global indexed content" }] }]
            },
          },
          app: { async log() { return undefined } },
        }),
        directory,
        worktree: directory,
      },
      config,
      { search: {} },
    )

    const localSearch = await server.searchSessions({ query: "local indexed content" })
    expect(localSearch.ok).toBe(true)
    if (!localSearch.ok) throw new Error("local search failed")
    expect(localSearch.data.discoveryScope).toBe("current_directory")
    expect(localSearch.data.indexedSessionCount).toBe(1)

    const globalSearch = await server.searchSessions({ query: "global indexed content", scope: "global" })
    expect(globalSearch.ok).toBe(true)
    if (!globalSearch.ok) throw new Error("global search failed")
    expect(globalSearch.data.discoveryScope).toBe("global_unscoped")
    expect(globalSearch.data.indexPath).toContain("global_unscoped")
    expect(globalSearch.data.indexedSessionCount).toBe(2)
  })

  test("dirty session event triggers reindex and new content is found", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-server-"))
    tempDirs.push(directory)

    let revision = 1
    const server = new MissionControlServer(
      {
        client: wrapWithV2Messages({
          session: {
            async list() {
              return [
                {
                  id: "dirty-server-session",
                  directory,
                  title: "Dirty Server Session",
                  time: { created: 1, updated: 10 },
                },
              ]
            },
            async messages() {
              return [
                {
                  info: { id: "dirty-message", role: "assistant", time: { created: 5 } },
                  parts: [
                    {
                      id: "dirty-part",
                      type: "text",
                      text: revision === 1 ? "server old token" : "server new token",
                    },
                  ],
                },
              ]
            },
          },
          app: {
            async log() {
              return undefined
            },
          },
        }),
        directory,
        worktree: directory,
      },
      DEFAULT_CONFIG,
      { search: {} },
    )

    const firstSearch = await server.searchSessions({ query: "server old token" })
    expect(firstSearch.ok).toBe(true)

    revision = 2
    await server.onRuntimeEvent("message.part.updated", { sessionID: "dirty-server-session" })
    await server.onRuntimeEvent("message.part.updated", { sessionID: "unrelated-session" })

    const secondSearch = await server.searchSessions({ query: "server new token" })
    expect(secondSearch.ok).toBe(true)
    if (!secondSearch.ok) {
      throw new Error("Expected dirty server search to succeed")
    }
    expect(secondSearch.data.matches[0]?.snippet).toContain("server new token")
  })

  test("persists dirty invalidations across restart when content changes without updatedAt moving", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-server-"))
    tempDirs.push(directory)

    let revision = 1
    const messageCalls = new Map<string, number>()
    const client = wrapWithV2Messages({
      session: {
        async list() {
          return [{ id: "restart-dirty-session", directory, title: "Restart Dirty Session", time: { created: 1, updated: 10 } }]
        },
        async messages({ path }: { path: { id: string } }) {
          messageCalls.set(path.id, (messageCalls.get(path.id) ?? 0) + 1)
          return [
            {
              info: { id: "restart-dirty-message", role: "assistant", time: { created: 5 } },
              parts: [{ id: "restart-dirty-part", type: "text", text: revision === 1 ? "restart old token" : "restart new token" }],
            },
          ]
        },
      },
      app: { async log() { return undefined } },
    })

    const server1 = new MissionControlServer(
      {
        client,
        directory,
        worktree: directory,
      },
      DEFAULT_CONFIG,
      { search: {} },
    )

    const firstSearch = await server1.searchSessions({ query: "restart old token" })
    expect(firstSearch.ok).toBe(true)

    revision = 2
    await server1.onRuntimeEvent("message.part.updated", { sessionID: "restart-dirty-session" })

    const server2 = new MissionControlServer(
      {
        client,
        directory,
        worktree: directory,
      },
      DEFAULT_CONFIG,
      { search: {} },
    )

    const secondSearch = await server2.searchSessions({ query: "restart new token" })
    expect(secondSearch.ok).toBe(true)
    if (!secondSearch.ok) {
      throw new Error("Expected restart dirty-session search to succeed")
    }

    expect(secondSearch.data.matches[0]?.snippet).toContain("restart new token")
    expect(messageCalls.get("restart-dirty-session")).toBe(2)
  })

  test("shares global dirty invalidations across worktrees", async () => {
    const directoryA = await mkdtemp(join(tmpdir(), "mission-control-server-"))
    const directoryB = await mkdtemp(join(tmpdir(), "mission-control-server-"))
    tempDirs.push(directoryA, directoryB)
    const configA = createMissionControlConfig({
      search: {
        indexPath: join(directoryA, "shared-global.current_directory.json"),
      },
    })
    const configB = createMissionControlConfig({
      search: {
        indexPath: join(directoryB, "shared-global.current_directory.json"),
      },
    })

    let revision = 1
    const messageCalls = new Map<string, number>()
    const client = wrapWithV2Messages({
      session: {
        async list({ query }: { query?: { directory?: string } } = {}) {
          if (query?.directory === "") {
            return [{ id: "shared-global-session", directory: "/tmp/shared-project", title: "Shared Global Session", time: { created: 1, updated: 10 } }]
          }
          return []
        },
        async messages({ path }: { path: { id: string } }) {
          messageCalls.set(path.id, (messageCalls.get(path.id) ?? 0) + 1)
          return [
            {
              info: { id: "shared-global-message", role: "assistant", time: { created: 5 } },
              parts: [{ id: "shared-global-part", type: "text", text: revision === 1 ? "global stale token" : "global refreshed token" }],
            },
          ]
        },
      },
      app: { async log() { return undefined } },
    })

    const serverA = new MissionControlServer(
      {
        client,
        directory: directoryA,
        worktree: directoryA,
      },
      configA,
      { search: {} },
    )

    const firstSearch = await serverA.searchSessions({ query: "global stale token", scope: "global" })
    expect(firstSearch.ok).toBe(true)

    revision = 2
    await serverA.onRuntimeEvent("message.part.updated", { sessionID: "shared-global-session" })

    const serverB = new MissionControlServer(
      {
        client,
        directory: directoryB,
        worktree: directoryB,
      },
      configB,
      { search: {} },
    )

    const secondSearch = await serverB.searchSessions({ query: "global refreshed token", scope: "global" })
    expect(secondSearch.ok).toBe(true)
    if (!secondSearch.ok) {
      throw new Error("Expected cross-worktree global search to succeed")
    }

    expect(secondSearch.data.matches[0]?.snippet).toContain("global refreshed token")
    expect(messageCalls.get("shared-global-session")).toBe(2)
  })
})
