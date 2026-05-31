import { describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG } from "../src/config.ts"
import { applyMissionControlToolGuidance } from "../src/plugin.ts"
import { createMissionControlTools } from "../src/tools.ts"

describe("mc_session_search tool", () => {
  test("returns titled plugin result with output and metadata", async () => {
    const payload = { ok: true, data: { name: "opencode-mission-control" } }
    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async status() {
        return payload
      },
    } as any)

    const result = await tools.mc_status.execute({} as any, {} as any) as any
    expect(result.title).toBe("Mission Control Status")
    expect(result.output).toBe(JSON.stringify(payload, null, 2))
    expect(result.metadata).toBe(payload)
  })

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

describe("mc_session_abort tool", () => {
  test("forwards a session id and returns a titled structured result", async () => {
    const calls: string[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async abortSession(sessionId: string) {
        calls.push(sessionId)
        return {
          ok: true,
          data: {
            sessionId,
            requestAccepted: true,
            aborted: true,
            result: null,
          },
        }
      },
    } as any)

    expect(Object.keys(tools.mc_session_abort.args)).toEqual(["sessionId"])

    const result = await tools.mc_session_abort.execute({ sessionId: "ses_child" } as any, {} as any) as any
    expect(result.title).toBe("Session Abort")
    expect(JSON.parse(result.output)).toEqual({
      ok: true,
      data: {
        sessionId: "ses_child",
        requestAccepted: true,
        aborted: true,
        result: null,
      },
    })
    expect(result.metadata).toEqual({
      ok: true,
      data: {
        sessionId: "ses_child",
        requestAccepted: true,
        aborted: true,
        result: null,
      },
    })
    expect(calls).toEqual(["ses_child"])
  })

  test("adds guidance for background subagent cancellation", () => {
    const description = applyMissionControlToolGuidance("mc_session_abort", "Abort/cancel an OpenCode session by session ID")

    expect(description).toContain("background subagents")
    expect(description).toContain("session abort endpoint")
  })
})

describe("inter-session messaging tools", () => {
  test("mc_session_send_async forwards target, message, and sender, and titles the result", async () => {
    const calls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async sendSessionMessageAsync(targetSessionId: string, message: string, fromSessionId?: string) {
        calls.push({ targetSessionId, message, fromSessionId })
        return {
          ok: true,
          data: {
            targetSessionId,
            fromSessionId,
            delivery: "async",
            requestAccepted: true,
            note: "queued",
          },
        }
      },
    } as any)

    expect(Object.keys(tools.mc_session_send_async.args).sort()).toEqual(["message", "targetSessionId"].sort())

    const result = (await tools.mc_session_send_async.execute(
      { targetSessionId: "ses_target", message: "hello" } as any,
      { sessionID: "ses_sender" } as any,
    )) as any

    expect(result.title).toBe("Session Message Sent")
    expect(calls).toEqual([{ targetSessionId: "ses_target", message: "hello", fromSessionId: "ses_sender" }])
  })

  test("mc_session_send_interrupt forwards target, message, and sender, and titles the result", async () => {
    const calls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async sendSessionMessageInterrupt(targetSessionId: string, message: string, fromSessionId?: string) {
        calls.push({ targetSessionId, message, fromSessionId })
        return {
          ok: true,
          data: {
            targetSessionId,
            fromSessionId,
            delivery: "interrupt",
            requestAccepted: true,
            aborted: true,
            note: "interrupted",
          },
        }
      },
    } as any)

    expect(Object.keys(tools.mc_session_send_interrupt.args).sort()).toEqual(["message", "targetSessionId"].sort())

    const result = (await tools.mc_session_send_interrupt.execute(
      { targetSessionId: "ses_target", message: "stop now" } as any,
      { sessionID: "ses_sender" } as any,
    )) as any

    expect(result.title).toBe("Session Interrupt Sent")
    expect(calls).toEqual([{ targetSessionId: "ses_target", message: "stop now", fromSessionId: "ses_sender" }])
  })

  test("adds guidance describing async loop-boundary delivery", () => {
    const description = applyMissionControlToolGuidance(
      "mc_session_send_async",
      "Queue a message into another OpenCode session without blocking; the target processes it at its next loop boundary",
    )

    expect(description).toContain("next loop boundary")
    expect(description).toContain("inter_agent_message")
    expect(description).toContain("mc_session_tail")
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
