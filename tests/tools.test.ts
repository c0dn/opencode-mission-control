import { describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG } from "../src/config.ts"
import { applyMissionControlToolGuidance } from "../src/plugin.ts"
import { createMissionControlTools } from "../src/tools.ts"
import { ZellijCommandError } from "../src/terminals/zellij.ts"

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

describe("tool surface", () => {
  test("legacy orchestration-only tool surface still exposes terminal command tools", () => {
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
    expect(tools.mc_session_abort).toBeDefined()
    expect(tools.mc_session_search).toBeDefined()
    expect(Object.keys(tools).some((toolName) => toolName.startsWith("mc_" + "job_"))).toBe(false)
    expect(Object.keys(tools).some((toolName) => toolName.startsWith("mc_" + "terminal_"))).toBe(true)
    expect(tools.mc_terminal_start).toBeDefined()
    expect(tools.mc_terminal_cancel).toBeDefined()
  })

  test("inspect-only tool surface still exposes terminal command tools", () => {
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
    expect(tools.mc_session_abort).toBeDefined()
    expect(Object.keys(tools).some((toolName) => toolName.startsWith("mc_" + "job_"))).toBe(false)
    expect(Object.keys(tools).some((toolName) => toolName.startsWith("mc_" + "terminal_"))).toBe(true)
    expect(tools.mc_terminal_start).toBeDefined()
    expect(tools.mc_terminal_cancel).toBeDefined()
  })

  test("mc_terminal_start falls back to context.sessionID when sessionId arg is omitted", async () => {
    const calls: unknown[] = []
    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async startTerminal(args: unknown) {
        calls.push(args)
        return { terminal: { id: "term_1" }, followCommand: "zellij attach mc-ses_ctx" }
      },
    } as any)

    await tools.mc_terminal_start.execute(
      { command: ["printf", "ok"] } as any,
      { sessionID: "ses_ctx" } as any,
    )

    expect(calls).toEqual([
      {
        sessionId: "ses_ctx",
        command: ["printf", "ok"],
        commandString: undefined,
        cwd: undefined,
        title: undefined,
        label: undefined,
        floating: undefined,
        direction: undefined,
        inPlace: undefined,
        closeOnExit: undefined,
        startSuspended: undefined,
        sessionName: undefined,
      },
    ])
  })

  test("mc_terminal_start prefers the explicit sessionId arg over context.sessionID", async () => {
    const calls: unknown[] = []
    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async startTerminal(args: any) {
        calls.push(args.sessionId)
        return { terminal: { id: "term_1" }, followCommand: "" }
      },
    } as any)

    await tools.mc_terminal_start.execute(
      { sessionId: "ses_explicit", command: ["true"] } as any,
      { sessionID: "ses_ctx" } as any,
    )

    expect(calls).toEqual(["ses_explicit"])
  })

  test("mc_terminal_panes resolves owner sessionId via context and forwards all", async () => {
    const calls: unknown[] = []
    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async listTerminalPanes(args: unknown) {
        calls.push(args)
        return { session: "mc-ses_ctx", paneCount: 0, focusedPaneID: null, panes: [] }
      },
    } as any)

    await tools.mc_terminal_panes.execute({ all: false } as any, { sessionID: "ses_ctx" } as any)
    expect(calls).toEqual([{ session: undefined, sessionId: "ses_ctx", all: false }])
  })

  test("mc_terminal_capture forwards explicit session + paneId", async () => {
    const calls: unknown[] = []
    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async captureTerminalPane(args: unknown) {
        calls.push(args)
        return { session: "mc-x", paneId: "terminal_9", full: true, ansi: false, content: "" }
      },
    } as any)

    await tools.mc_terminal_capture.execute(
      { session: "mc-x", paneId: "9", full: true } as any,
      {} as any,
    )
    expect(calls).toEqual([
      { session: "mc-x", sessionId: undefined, paneId: "9", full: true, ansi: undefined },
    ])
  })

  test("mc_terminal_sessions lists zellij sessions", async () => {
    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async listZellijSessions() {
        return { count: 1, currentSession: "mc-a", sessions: [{ name: "mc-a", current: true, raw: "mc-a (current)" }] }
      },
    } as any)

    const result = (await tools.mc_terminal_sessions.execute({} as any, {} as any)) as any
    expect(result.title).toBe("Zellij Sessions")
    expect(JSON.parse(result.output).currentSession).toBe("mc-a")
  })

  test("mc_terminal_capture returns a structured resolution error for an invalid pane id", async () => {
    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async captureTerminalPane() {
        throw new Error("Invalid pane ID. Use terminal_<n>, plugin_<n>, or a bare integer.")
      },
    } as any)

    const result = (await tools.mc_terminal_capture.execute(
      { session: "mc-x", paneId: "nope" } as any,
      {} as any,
    )) as any
    const output = JSON.parse(result.output)
    expect(output.ok).toBe(false)
    expect(output.error.code).toBe("TerminalResolutionError")
  })

  test("live terminal tools return structured resolution errors for Zellij command failures", async () => {
    const zellijFailure = () =>
      new ZellijCommandError("zellij live command failed", ["--session", "missing", "action", "list-panes"], {
        stdout: "partial pane json",
        stderr: "No such session: missing",
        exitCode: 1,
      })
    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async listTerminalPanes() {
        throw zellijFailure()
      },
      async captureTerminalPane() {
        throw zellijFailure()
      },
      async listZellijSessions() {
        throw zellijFailure()
      },
    } as any)

    for (const [terminalTool, args] of [
      [tools.mc_terminal_panes, { session: "missing" }],
      [tools.mc_terminal_capture, { session: "missing", paneId: "1" }],
      [tools.mc_terminal_sessions, {}],
    ] as const) {
      const result = (await terminalTool.execute(args as any, {} as any)) as any
      const output = JSON.parse(result.output)

      expect(output.ok).toBe(false)
      expect(output.error.code).toBe("TerminalResolutionError")
      expect(output.error.message).toContain("zellij live command failed")
      expect(output.error.message).toContain("stderr: No such session: missing")
      expect(output.error.message).toContain("stdout: partial pane json")
    }
  })

  test("terminal tool handlers return structured not-found errors", async () => {
    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async getTerminal() {
        throw new Error("Unknown terminal id: term_missing")
      },
      async readTerminal() {
        throw new Error("Unknown terminal id: term_missing")
      },
      async sendTerminal() {
        throw new Error("Unknown terminal id: term_missing")
      },
      async cancelTerminal() {
        throw new Error("Unknown terminal id: term_missing")
      },
    } as any)

    for (const terminalTool of [tools.mc_terminal_get, tools.mc_terminal_read, tools.mc_terminal_send, tools.mc_terminal_cancel]) {
      const result = await terminalTool.execute({ terminalId: "term_missing" } as any, {} as any) as any
      const output = JSON.parse(result.output)

      expect(output).toEqual({
        ok: false,
        error: {
          code: "TerminalNotFound",
          message: "Unknown terminal id: term_missing",
          suggestion: "Use mc_terminal_list to find active Mission Control terminal ids before retrying.",
        },
      })
    }
  })
})
