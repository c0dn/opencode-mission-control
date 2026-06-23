import { afterEach, describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG } from "../src/config.ts"
import { MissionControlEventHook, MISSION_CONTROL_EVENT_HOOKS } from "../src/events.ts"
import { applyMissionControlToolGuidance, MissionControlPlugin } from "../src/plugin.ts"
import { MissionControlServer } from "../src/server.ts"

const originalFromContext = MissionControlServer.fromContext

// Options that satisfy the Jina key gate without making real network calls
const TEST_OPTIONS = { search: { jinaApiKey: "test-key-for-plugin-tests" } }

afterEach(() => {
  MissionControlServer.fromContext = originalFromContext
})

// ── Key gate ──────────────────────────────────────────────────────────────────

describe("MissionControlPlugin key gate", () => {
  test("returns an inert plugin with no tools when no Jina API key is provided", async () => {
    const hooks = await MissionControlPlugin({
      client: { app: { async log() {} } },
      directory: "/tmp/project",
    } as any)

    expect((hooks as any).tool).toBeUndefined()
  })

  test("returns an inert plugin when jinaApiKey is an empty string", async () => {
    const hooks = await MissionControlPlugin(
      { client: { app: { async log() {} } }, directory: "/tmp/project" } as any,
      { search: { jinaApiKey: "   " } },
    )

    expect((hooks as any).tool).toBeUndefined()
  })

  test("registers tools when a Jina API key is present", async () => {
    MissionControlServer.fromContext = (async () => ({
      config: DEFAULT_CONFIG,
      searchSessions: async () => ({}),
      readSession: async () => ({}),
      tailSession: async () => ({}),
      findSessions: async () => ({}),
      getSession: async () => ({}),
      listSessions: async () => ({}),
      abortSession: async () => ({}),
      sendSessionMessageAsync: async () => ({}),
      sendSessionMessageInterrupt: async () => ({}),
      onRuntimeEvent: async () => undefined,
      compactionContext: () => [],
      dispose: async () => {},
    }) as any)

    const hooks = await MissionControlPlugin(
      { client: { app: { async log() {} } }, directory: "/tmp/project" } as any,
      TEST_OPTIONS,
    )

    expect((hooks as any).tool).toBeDefined()
    const toolKeys = Object.keys((hooks as any).tool)
    expect(toolKeys).toContain("session_search")
    expect(toolKeys).toContain("session_search_global")
    expect(toolKeys).toContain("session_read")
    expect(toolKeys).toContain("session_tail")
    expect(toolKeys).toContain("session_find")
    expect(toolKeys).toContain("session_get")
    expect(toolKeys).toContain("session_list")
    expect(toolKeys).toContain("subagent_abort")
    expect(toolKeys).toContain("subagent_send_async")
    expect(toolKeys).toContain("subagent_send_interrupt")
    expect(toolKeys).not.toContain("mc_status")
    expect(toolKeys).not.toContain("mc_session_events")
    expect(toolKeys).not.toContain("mc_session_tree")
    expect(toolKeys.length).toBe(10)
  })
})

// ── Tool guidance ─────────────────────────────────────────────────────────────

describe("MissionControlPlugin tool guidance", () => {
  test("applyMissionControlToolGuidance augments known tools without depending on exact prose", () => {
    for (const [toolID, description] of [
      ["session_search", "Search session transcripts in the current project/directory"],
      ["session_read", "Read one session transcript, optionally with children"],
      ["subagent_abort", "Abort/cancel an OpenCode session by session ID"],
    ] as const) {
      const augmented = applyMissionControlToolGuidance(toolID, description)

      expect(augmented).toContain(description)
      expect(augmented.length).toBeGreaterThan(description.length)
      expect(augmented).toContain("\n\n")
    }
  })

  test("tool.definition augments known tool descriptions without mutating parameters", async () => {
    MissionControlServer.fromContext = (async () => ({
      config: DEFAULT_CONFIG,
      searchSessions: async () => ({}),
      readSession: async () => ({}),
      tailSession: async () => ({}),
      findSessions: async () => ({}),
      getSession: async () => ({}),
      listSessions: async () => ({}),
      abortSession: async () => ({}),
      sendSessionMessageAsync: async () => ({}),
      sendSessionMessageInterrupt: async () => ({}),
      onRuntimeEvent: async () => undefined,
      compactionContext: () => [],
      dispose: async () => {},
    }) as any)

    const hooks = await MissionControlPlugin(
      { client: { app: { async log() {} } }, directory: "/tmp/project", worktree: "/tmp/project" } as any,
      TEST_OPTIONS,
    )

    const parameters = { keep: true }
    const output = { description: "Search session transcripts in the current project/directory", parameters }

    await hooks["tool.definition"]?.({ toolID: "session_search" } as any, output as any)

    expect(output.description).toContain("Search session transcripts in the current project/directory")
    expect(output.description.length).toBeGreaterThan(
      "Search session transcripts in the current project/directory".length,
    )
    expect(output.parameters).toBe(parameters)
  })

  test("tool.definition leaves unrelated tools unchanged", async () => {
    MissionControlServer.fromContext = (async () => ({
      config: DEFAULT_CONFIG,
      searchSessions: async () => ({}),
      readSession: async () => ({}),
      tailSession: async () => ({}),
      findSessions: async () => ({}),
      getSession: async () => ({}),
      listSessions: async () => ({}),
      abortSession: async () => ({}),
      sendSessionMessageAsync: async () => ({}),
      sendSessionMessageInterrupt: async () => ({}),
      onRuntimeEvent: async () => undefined,
      compactionContext: () => [],
      dispose: async () => {},
    }) as any)

    const hooks = await MissionControlPlugin(
      { client: { app: { async log() {} } }, directory: "/tmp/project", worktree: "/tmp/project" } as any,
      TEST_OPTIONS,
    )

    const output = { description: "Plain tool description", parameters: {} }
    await hooks["tool.definition"]?.({ toolID: "something_else" } as any, output as any)

    expect(output.description).toBe("Plain tool description")
  })

  test("experimental.session.compacting injects Mission Control subagent context", async () => {
    MissionControlServer.fromContext = (async () => ({
      config: DEFAULT_CONFIG,
      searchSessions: async () => ({}),
      readSession: async () => ({}),
      tailSession: async () => ({}),
      findSessions: async () => ({}),
      getSession: async () => ({}),
      listSessions: async () => ({}),
      abortSession: async () => ({}),
      sendSessionMessageAsync: async () => ({}),
      sendSessionMessageInterrupt: async () => ({}),
      onRuntimeEvent: async () => undefined,
      compactionContext(sessionId: string) {
        return [`subagents for ${sessionId}: ses_child`]
      },
      dispose: async () => {},
    }) as any)

    const hooks = await MissionControlPlugin(
      { client: { app: { async log() {} } }, directory: "/tmp/project", worktree: "/tmp/project" } as any,
      TEST_OPTIONS,
    )

    const output = { context: ["existing"], prompt: undefined as string | undefined }
    await hooks["experimental.session.compacting"]?.({ sessionID: "ses_parent" } as any, output as any)

    expect(output.context).toEqual(["existing", "subagents for ses_parent: ses_child"])
    expect(output.prompt).toBeUndefined()
  })
})

// ── Runtime hooks ─────────────────────────────────────────────────────────────

describe("MissionControlPlugin runtime hooks", () => {
  test("event forwards supported runtime events and normalizes properties payloads", async () => {
    const forwarded: Array<{ type: string; payload: unknown }> = []

    MissionControlServer.fromContext = (async () => ({
      config: DEFAULT_CONFIG,
      searchSessions: async () => ({}),
      readSession: async () => ({}),
      tailSession: async () => ({}),
      findSessions: async () => ({}),
      getSession: async () => ({}),
      listSessions: async () => ({}),
      abortSession: async () => ({}),
      sendSessionMessageAsync: async () => ({}),
      sendSessionMessageInterrupt: async () => ({}),
      async onRuntimeEvent(type: string, payload: unknown) {
        forwarded.push({ type, payload })
      },
      compactionContext: () => [],
      dispose: async () => {},
    }) as any)

    const hooks = await MissionControlPlugin(
      { client: { app: { async log() {} } }, directory: "/tmp/project", worktree: "/tmp/project" } as any,
      TEST_OPTIONS,
    )

    const supportedEvent = MISSION_CONTROL_EVENT_HOOKS[0] as MissionControlEventHook
    await hooks.event?.({ event: { type: supportedEvent, properties: { sessionID: "session-1" } } } as any)
    await hooks.event?.({ event: { type: "session.compacted", properties: { sessionID: "session-2" } } } as any)
    await hooks.event?.({ event: { type: "message.removed", properties: { sessionID: "session-3" } } } as any)
    await hooks.event?.({ event: { type: "something.else", properties: { sessionID: "ignored" } } } as any)

    expect(forwarded).toEqual([
      { type: supportedEvent, payload: { sessionID: "session-1" } },
      { type: "session.compacted", payload: { sessionID: "session-2" } },
      { type: "message.removed", payload: { sessionID: "session-3" } },
    ])
  })

  test("event disposes on official disposal events without forwarding them", async () => {
    const forwarded: Array<{ type: string; payload: unknown }> = []
    const disposed: string[] = []

    MissionControlServer.fromContext = (async () => ({
      config: DEFAULT_CONFIG,
      searchSessions: async () => ({}),
      readSession: async () => ({}),
      tailSession: async () => ({}),
      findSessions: async () => ({}),
      getSession: async () => ({}),
      listSessions: async () => ({}),
      abortSession: async () => ({}),
      sendSessionMessageAsync: async () => ({}),
      sendSessionMessageInterrupt: async () => ({}),
      async onRuntimeEvent(type: string, payload: unknown) {
        forwarded.push({ type, payload })
      },
      compactionContext: () => [],
      async dispose() {
        disposed.push("disposed")
      },
    }) as any)

    const hooks = await MissionControlPlugin(
      { client: { app: { async log() {} } }, directory: "/tmp/project", worktree: "/tmp/project" } as any,
      TEST_OPTIONS,
    )

    await hooks.event?.({ event: { type: "global.disposed", properties: { sessionID: "ignored-1" } } } as any)
    await hooks.event?.({
      event: { type: "server.instance.disposed", properties: { sessionID: "ignored-2" } },
    } as any)

    expect(disposed).toEqual(["disposed", "disposed"])
    expect(forwarded).toEqual([])
  })
})
