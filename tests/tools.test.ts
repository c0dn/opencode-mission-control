import { describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG } from "../src/config.ts"
import { applyMissionControlToolGuidance } from "../src/plugin.ts"
import { createMissionControlTools } from "../src/tools.ts"

// ── Search tools ─────────────────────────────────────────────────────────────

describe("session_search tool", () => {
  test("exposes query and limit only; hardcodes scope=local", async () => {
    const calls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async searchSessions(args: unknown) {
        calls.push(args)
        return {
          ok: true,
          data: {
            query: "CTF",
            requestedMode: "hybrid",
            effectiveMode: "hybrid",
            builtAt: 1,
            indexPath: "/tmp/search-index.sqlite3",
            discoveryScope: "current_directory",
            indexedSessionCount: 0,
            warnings: [],
            matches: [],
          },
        }
      },
    } as any)

    expect(Object.keys(tools.session_search.args).sort()).toEqual(["limit", "query"].sort())

    await tools.session_search.execute({ query: "CTF", limit: 5 } as any, {} as any)

    expect(calls).toEqual([{ query: "CTF", scope: "local", limit: 5 }])
  })

  test("returns titled plugin result", async () => {
    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async searchSessions() {
        return { ok: true, data: { matches: [] } }
      },
    } as any)

    const result = (await tools.session_search.execute({ query: "hello" } as any, {} as any)) as any
    expect(result.title).toBe("Session Search Results")
  })
})

describe("session_search_global tool", () => {
  test("exposes query and limit only; hardcodes scope=global", async () => {
    const calls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async searchSessions(args: unknown) {
        calls.push(args)
        return { ok: true, data: { matches: [] } }
      },
    } as any)

    expect(Object.keys(tools.session_search_global.args).sort()).toEqual(["limit", "query"].sort())

    await tools.session_search_global.execute({ query: "CTF", limit: 3 } as any, {} as any)

    expect(calls).toEqual([{ query: "CTF", scope: "global", limit: 3 }])
  })
})

// ── Read / inspect ────────────────────────────────────────────────────────────

describe("session_read tool", () => {
  test("forwards all args including withChildren and offset", async () => {
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

    expect(Object.keys(tools.session_read.args).sort()).toEqual(
      ["beforeMessageId", "limit", "offset", "sessionId", "withChildren", "withToolOutputs"].sort(),
    )

    await tools.session_read.execute(
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

describe("session_tail tool", () => {
  test("forwards compact text-only session tail args including offset and withChildren", async () => {
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

    expect(Object.keys(tools.session_tail.args).sort()).toEqual(
      ["limit", "offset", "sessionId", "withChildren"].sort(),
    )

    await tools.session_tail.execute(
      { sessionId: "ses_123", offset: 5, limit: 10, withChildren: true } as any,
      {} as any,
    )

    expect(calls).toEqual([
      { sessionId: "ses_123", options: { offset: 5, limit: 10, withChildren: true } },
    ])
  })
})

describe("session_find tool", () => {
  test("forwards exact-title lookup args", async () => {
    const calls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async findSessions(args: unknown) {
        calls.push(args)
        return { ok: true, data: { title: "Build notes", scope: "global", candidates: [], ambiguous: false } }
      },
    } as any)

    expect(Object.keys(tools.session_find.args).sort()).toEqual(["limit", "scope", "title"].sort())
    await tools.session_find.execute({ title: "Build notes", scope: "global", limit: 3 } as any, {} as any)
    expect(calls).toEqual([{ title: "Build notes", scope: "global", limit: 3 }])
  })
})

describe("session_get tool", () => {
  test("forwards a session id and returns metadata only", async () => {
    const calls: string[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async getSession(sessionId: string) {
        calls.push(sessionId)
        return { ok: true, data: { session: { sessionId, title: "Build notes", directory: "/tmp/project" } } }
      },
    } as any)

    expect(Object.keys(tools.session_get.args)).toEqual(["sessionId"])
    await tools.session_get.execute({ sessionId: "ses_123" } as any, {} as any)
    expect(calls).toEqual(["ses_123"])
  })
})

describe("session_list tool", () => {
  test("exposes scope, start, search, limit args and forwards them", async () => {
    const calls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async listSessions(args: unknown) {
        calls.push(args)
        return { ok: true, data: { scope: "local", sessions: [], total: 0 } }
      },
    } as any)

    expect(Object.keys(tools.session_list.args).sort()).toEqual(
      ["limit", "scope", "search", "start"].sort(),
    )

    await tools.session_list.execute(
      { scope: "global", start: 1700000000000, search: "CTF", limit: 10 } as any,
      {} as any,
    )

    expect(calls).toEqual([{ scope: "global", start: 1700000000000, search: "CTF", limit: 10 }])
  })

  test("returns a titled plugin result", async () => {
    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async listSessions() {
        return { ok: true, data: { scope: "local", sessions: [], total: 0 } }
      },
    } as any)

    const result = (await tools.session_list.execute({} as any, {} as any)) as any
    expect(result.title).toBe("Session List")
  })
})

// ── Subagent orchestration ────────────────────────────────────────────────────

describe("subagent_abort tool", () => {
  test("forwards a session id and returns a titled structured result", async () => {
    const calls: string[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async abortSession(sessionId: string) {
        calls.push(sessionId)
        return { ok: true, data: { sessionId, requestAccepted: true, aborted: true, result: null } }
      },
    } as any)

    expect(Object.keys(tools.subagent_abort.args)).toEqual(["sessionId"])

    const result = (await tools.subagent_abort.execute({ sessionId: "ses_child" } as any, {} as any)) as any
    expect(result.title).toBe("Session Abort")
    expect(JSON.parse(result.output)).toEqual({
      ok: true,
      data: { sessionId: "ses_child", requestAccepted: true, aborted: true, result: null },
    })
    expect(calls).toEqual(["ses_child"])
  })

  test("adds guidance for background subagent cancellation", () => {
    const description = applyMissionControlToolGuidance(
      "subagent_abort",
      "Abort/cancel an OpenCode session by session ID",
    )

    expect(description).toContain("background subagents")
    expect(description).toContain("session abort endpoint")
  })
})

describe("subagent_send_async tool", () => {
  test("forwards target, message, and sender; returns titled result", async () => {
    const calls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async sendSessionMessageAsync(targetSessionId: string, message: string, fromSessionId?: string) {
        calls.push({ targetSessionId, message, fromSessionId })
        return {
          ok: true,
          data: { targetSessionId, fromSessionId, delivery: "async", requestAccepted: true, note: "queued" },
        }
      },
    } as any)

    expect(Object.keys(tools.subagent_send_async.args).sort()).toEqual(["message", "targetSessionId"].sort())

    const result = (await tools.subagent_send_async.execute(
      { targetSessionId: "ses_peer", message: "hello peer" } as any,
      { sessionID: "ses_sender" } as any,
    )) as any

    expect(result.title).toBe("Session Message Sent")
    expect(calls).toEqual([{ targetSessionId: "ses_peer", message: "hello peer", fromSessionId: "ses_sender" }])
  })

  test("adds peer messaging guidance", () => {
    const description = applyMissionControlToolGuidance(
      "subagent_send_async",
      "Queue a message into a peer subagent session; the target processes it at its next loop boundary",
    )

    expect(description).toContain("peer subagent")
    expect(description).toContain("inter_agent_message")
    expect(description).toContain("end your loop")
  })
})

describe("subagent_send_interrupt tool", () => {
  test("forwards target, message, and sender; returns titled result", async () => {
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

    expect(Object.keys(tools.subagent_send_interrupt.args).sort()).toEqual(["message", "targetSessionId"].sort())

    const result = (await tools.subagent_send_interrupt.execute(
      { targetSessionId: "ses_peer", message: "stop now" } as any,
      { sessionID: "ses_sender" } as any,
    )) as any

    expect(result.title).toBe("Session Interrupt Sent")
    expect(calls).toEqual([
      { targetSessionId: "ses_peer", message: "stop now", fromSessionId: "ses_sender" },
    ])
  })
})
