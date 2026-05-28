import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG, createMissionControlConfig } from "../src/config.ts"
import { MissionControlServer } from "../src/server.ts"

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

  test("status reports built index metadata after a search", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-server-"))
    tempDirs.push(directory)

    const server = new MissionControlServer(
      {
        client: {
          session: {
            async list() {
              return [
                {
                  id: "server-session",
                  directory,
                  title: "Server Session",
                  time: { created: 1, updated: 10 },
                },
              ]
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
          app: {
            async log() {
              return undefined
            },
          },
        },
        directory,
        worktree: directory,
      },
      DEFAULT_CONFIG,
      { search: {} },
    )

    const searchResult = await server.searchSessions({ query: "server indexed content" })
    expect(searchResult.ok).toBe(true)

    const status = await server.status()
    expect(status.index.path).toContain("opencode-mission-control")
    expect(status.index.builtAt).toBeDefined()
    expect(status.index.discoveryScope).toBe("current_directory")
    expect(status.index.discoveryDirectory).toBe(directory)
    expect(status.index.indexedSessionCount).toBe(1)
    expect(status.index.dirtySessionCount).toBe(0)
    expect((status.capabilities as any).jobs).toBeUndefined()
  })

  test("status reports terminal tools available for legacy inspect-only config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-server-"))
    tempDirs.push(directory)

    const server = new MissionControlServer(
      {
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
      },
      {
        ...DEFAULT_CONFIG,
        tools: {
          surface: "inspect-only",
        },
      },
      { search: {} },
    )

    const status = await server.status()

    expect(status.implemented.terminalTools).toBe(true)
    expect(status.capabilities.terminals).toEqual({
      zellij: true,
      syntheticNotifications: true,
    })
  })

  test("status reports the most recently built scope-specific index", async () => {
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
        client: {
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
                    info: { id: "local-message", role: "assistant", time: { created: 5 } },
                    parts: [{ id: "local-part", type: "text", text: "local indexed content" }],
                  },
                ]
              }

              expect(path.id).toBe("global-session")
              expect(query?.directory).toBe(otherDirectory)
              return [
                {
                  info: { id: "global-message", role: "assistant", time: { created: 6 } },
                  parts: [{ id: "global-part", type: "text", text: "global indexed content" }],
                },
              ]
            },
          },
          app: {
            async log() {
              return undefined
            },
          },
        },
        directory,
        worktree: directory,
      },
      config,
      { search: {} },
    )

    const localSearch = await server.searchSessions({ query: "local indexed content" })
    expect(localSearch.ok).toBe(true)

    const globalSearch = await server.searchSessions({ query: "global indexed content", scope: "global" })
    expect(globalSearch.ok).toBe(true)

    const status = await server.status()
    expect(status.index.discoveryScope).toBe("global_unscoped")
    expect(status.index.path).toContain("global_unscoped")
    expect(status.index.indexedSessionCount).toBe(2)
  })

  test("status tracks dirty sessions and clears them after rebuild", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-server-"))
    tempDirs.push(directory)

    let revision = 1
    const server = new MissionControlServer(
      {
        client: {
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
        },
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

    const dirtyStatus = await server.status()
    expect(dirtyStatus.index.dirtySessionCount).toBe(1)

    const secondSearch = await server.searchSessions({ query: "server new token" })
    expect(secondSearch.ok).toBe(true)
    if (!secondSearch.ok) {
      throw new Error("Expected dirty server search to succeed")
    }
    expect(secondSearch.data.matches[0]?.snippet).toContain("server new token")

    const cleanStatus = await server.status()
    expect(cleanStatus.index.dirtySessionCount).toBe(0)
  })

  test("persists dirty invalidations across restart when content changes without updatedAt moving", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-server-"))
    tempDirs.push(directory)

    let revision = 1
    const messageCalls = new Map<string, number>()
    const client = {
      session: {
        async list() {
          return [
            {
              id: "restart-dirty-session",
              directory,
              title: "Restart Dirty Session",
              time: { created: 1, updated: 10 },
            },
          ]
        },
        async messages({ path }: { path: { id: string } }) {
          messageCalls.set(path.id, (messageCalls.get(path.id) ?? 0) + 1)
          return [
            {
              info: { id: "restart-dirty-message", role: "assistant", time: { created: 5 } },
              parts: [
                {
                  id: "restart-dirty-part",
                  type: "text",
                  text: revision === 1 ? "restart old token" : "restart new token",
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
    }

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
    const client = {
      session: {
        async list({ query }: { query?: { directory?: string } } = {}) {
          if (query?.directory === "") {
            return [
              {
                id: "shared-global-session",
                directory: "/tmp/shared-project",
                title: "Shared Global Session",
                time: { created: 1, updated: 10 },
              },
            ]
          }

          return []
        },
        async messages({ path }: { path: { id: string } }) {
          messageCalls.set(path.id, (messageCalls.get(path.id) ?? 0) + 1)
          return [
            {
              info: { id: "shared-global-message", role: "assistant", time: { created: 5 } },
              parts: [
                {
                  id: "shared-global-part",
                  type: "text",
                  text: revision === 1 ? "global stale token" : "global refreshed token",
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
    }

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
