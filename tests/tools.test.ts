import { describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG } from "../src/config.ts"
import { createMissionControlTools } from "../src/tools.ts"

describe("mc_session_search tool", () => {
  test("exposes the simplified public argument surface", async () => {
    const calls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async searchSessions(args: unknown) {
        calls.push(args)
        return {
          ok: true,
          data: {
            query: "CTF",
            requestedMode: "lexical",
            effectiveMode: "lexical",
            builtAt: 1,
            indexPath: "/tmp/search-index.json",
            discoveryScope: "current_directory",
            indexedSessionCount: 0,
            warnings: [],
            matches: [],
          },
        }
      },
    } as any)

    const searchTool = tools.mc_session_search
    expect(Object.keys(searchTool.args).sort()).toEqual(["exact", "limit", "query", "scope"].sort())

    await searchTool.execute({
      query: "CTF",
      scope: "global",
      exact: true,
      limit: 7,
    } as any, {} as any)

    expect(calls).toEqual([
        {
          query: "CTF",
          scope: "global",
          exact: true,
          limit: 7,
        },
    ])
  })
})

describe("session metadata lookup tools", () => {
  test("mc_session_get forwards a session id and returns metadata only", async () => {
    const calls: string[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async getSession(sessionId: string) {
        calls.push(sessionId)
        return {
          ok: true,
          data: {
            session: {
              sessionId,
              title: "Build notes",
              directory: "/tmp/project",
            },
          },
        }
      },
    } as any)

    expect(Object.keys(tools.mc_session_get.args)).toEqual(["sessionId"])
    await tools.mc_session_get.execute({ sessionId: "ses_123" } as any, {} as any)
    expect(calls).toEqual(["ses_123"])
  })

  test("mc_session_find forwards exact-title lookup args", async () => {
    const calls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async findSessions(args: unknown) {
        calls.push(args)
        return {
          ok: true,
          data: {
            title: "Build notes",
            scope: "global",
            candidates: [],
            ambiguous: false,
          },
        }
      },
    } as any)

    expect(Object.keys(tools.mc_session_find.args).sort()).toEqual(["limit", "scope", "title"].sort())
    await tools.mc_session_find.execute({ title: "Build notes", scope: "global", limit: 3 } as any, {} as any)

    expect(calls).toEqual([{ title: "Build notes", scope: "global", limit: 3 }])
  })
})

describe("mc_session_read tool", () => {
  test("forwards beforeMessageId to the session service", async () => {
    const calls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async readSession(sessionId: string, options: unknown) {
        calls.push({ sessionId, options })
        return {
          ok: true,
          data: {
            sessionId,
            entries: [],
            includedChildSessionIds: [],
            offset: 0,
            hasMore: false,
            totalEntries: 0,
            totalEntriesExact: true,
          },
        }
      },
    } as any)

    const readTool = tools.mc_session_read
    expect(Object.keys(readTool.args).sort()).toEqual(
      ["beforeMessageId", "limit", "offset", "sessionId", "withChildren", "withToolOutputs"].sort(),
    )

    await readTool.execute(
      {
        sessionId: "ses_123",
        beforeMessageId: "msg_7",
        offset: 6,
        limit: 4,
        withChildren: true,
        withToolOutputs: false,
      } as any,
      {} as any,
    )

    expect(calls).toEqual([
      {
        sessionId: "ses_123",
        options: {
          beforeMessageId: "msg_7",
          offset: 6,
          limit: 4,
          withChildren: true,
          withToolOutputs: false,
        },
      },
    ])
  })
})

describe("mc_session_tail tool", () => {
  test("forwards compact text-only session tail args", async () => {
    const calls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async tailSession(sessionId: string, options: unknown) {
        calls.push({ sessionId, options })
        return {
          ok: true,
          data: {
            sessionId,
            entries: [],
            includedChildSessionIds: [],
            offset: 0,
            hasMore: false,
            totalEntries: 0,
            totalEntriesExact: true,
          },
        }
      },
    } as any)

    expect(Object.keys(tools.mc_session_tail.args).sort()).toEqual(
      ["limit", "offset", "sessionId", "withChildren"].sort(),
    )

    await tools.mc_session_tail.execute(
      {
        sessionId: "ses_123",
        offset: 5,
        limit: 10,
        withChildren: true,
      } as any,
      {} as any,
    )

    expect(calls).toEqual([
      {
        sessionId: "ses_123",
        options: {
          offset: 5,
          limit: 10,
          withChildren: true,
        },
      },
    ])
  })
})

describe("tool surface", () => {
  test("legacy orchestration-only tool surface is normalized to session inspection tools", () => {
    const tools = createMissionControlTools({
      config: {
        ...DEFAULT_CONFIG,
        tools: {
          surface: "jobs" + "-only" as never,
        },
      },
    } as any)

    expect(tools.mc_status).toBeDefined()
    expect(tools.mc_session_read).toBeDefined()
    expect(tools.mc_session_get).toBeDefined()
    expect(tools.mc_session_find).toBeDefined()
    expect(tools.mc_session_tail).toBeDefined()
    expect(tools.mc_session_search).toBeDefined()
    expect(Object.keys(tools).some((toolName) => toolName.startsWith("mc_" + "job_"))).toBe(false)
  })

  test("inspect-only tool surface keeps session inspection tools only", () => {
    const tools = createMissionControlTools({
      config: {
        ...DEFAULT_CONFIG,
        tools: {
          surface: "inspect-only",
        },
      },
    } as any)

    expect(tools.mc_status).toBeDefined()
    expect(tools.mc_session_read).toBeDefined()
    expect(tools.mc_session_get).toBeDefined()
    expect(tools.mc_session_find).toBeDefined()
    expect(tools.mc_session_tail).toBeDefined()
    expect(Object.keys(tools).some((toolName) => toolName.startsWith("mc_" + "job_"))).toBe(false)
  })
})
