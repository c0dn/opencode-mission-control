import { afterEach, describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG } from "../src/config.ts"
import { MissionControlEventHook, MISSION_CONTROL_EVENT_HOOKS } from "../src/events.ts"
import { applyMissionControlToolGuidance, MissionControlPlugin } from "../src/plugin.ts"
import { MissionControlServer } from "../src/server.ts"

const originalFromContext = MissionControlServer.fromContext

afterEach(() => {
  MissionControlServer.fromContext = originalFromContext
})

describe("MissionControlPlugin tool guidance", () => {
  test("applyMissionControlToolGuidance augments known tools without depending on exact prose", () => {
    for (const [toolID, description] of [
      ["mc_session_search", "Search indexed session content"],
      ["mc_session_read", "Read one session transcript"],
      ["mc_session_events", "Return recent events and live status for a session"],
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
      status: async () => ({}),
      readSession: async () => ({}),
      sessionTree: async () => ({}),
      observeSession: async () => ({}),
      searchSessions: async () => ({}),
      onRuntimeEvent: async () => undefined,
    }) as any)

    const hooks = await MissionControlPlugin({
      client: {
        app: {
          async log() {
            return undefined
          },
        },
      },
      directory: "/tmp/project",
      worktree: "/tmp/project",
    } as any)

    const parameters = { keep: true }
    const output = {
      description: "Search indexed session content",
      parameters,
    }

    await hooks["tool.definition"]?.({ toolID: "mc_session_search" } as any, output as any)

    expect(output.description).toContain("Search indexed session content")
    expect(output.description.length).toBeGreaterThan("Search indexed session content".length)
    expect(output.parameters).toBe(parameters)
  })

  test("tool.definition leaves unrelated tools unchanged", async () => {
    MissionControlServer.fromContext = (async () => ({
      config: DEFAULT_CONFIG,
      status: async () => ({}),
      readSession: async () => ({}),
      sessionTree: async () => ({}),
      observeSession: async () => ({}),
      searchSessions: async () => ({}),
      onRuntimeEvent: async () => undefined,
    }) as any)

    const hooks = await MissionControlPlugin({
      client: {
        app: {
          async log() {
            return undefined
          },
        },
      },
      directory: "/tmp/project",
      worktree: "/tmp/project",
    } as any)

    const output = {
      description: "Plain tool description",
      parameters: {},
    }

    await hooks["tool.definition"]?.({ toolID: "something_else" } as any, output as any)

    expect(output.description).toBe("Plain tool description")
  })
})

describe("MissionControlPlugin runtime hooks", () => {
  test("event forwards supported runtime events and normalizes properties payloads", async () => {
    const forwarded: Array<{ type: string; payload: unknown }> = []

    MissionControlServer.fromContext = (async () => ({
      config: DEFAULT_CONFIG,
      status: async () => ({}),
      readSession: async () => ({}),
      sessionTree: async () => ({}),
      observeSession: async () => ({}),
      searchSessions: async () => ({}),
      async onRuntimeEvent(type: string, payload: unknown) {
        forwarded.push({ type, payload })
      },
    }) as any)

    const hooks = await MissionControlPlugin({
      client: {
        app: {
          async log() {
            return undefined
          },
        },
      },
      directory: "/tmp/project",
      worktree: "/tmp/project",
    } as any)

    const supportedEvent = MISSION_CONTROL_EVENT_HOOKS[0] as MissionControlEventHook
    await hooks.event?.({
      event: {
        type: supportedEvent,
        properties: { sessionID: "session-1" },
      },
    } as any)
    await hooks.event?.({
      event: {
        type: "session.compacted",
        properties: { sessionID: "session-2" },
      },
    } as any)
    await hooks.event?.({
      event: {
        type: "message.removed",
        properties: { sessionID: "session-3" },
      },
    } as any)
    await hooks.event?.({
      event: {
        type: "something.else",
        properties: { sessionID: "ignored" },
      },
    } as any)

    expect(forwarded).toEqual([
      {
        type: supportedEvent,
        payload: { sessionID: "session-1" },
      },
      {
        type: "session.compacted",
        payload: { sessionID: "session-2" },
      },
      {
        type: "message.removed",
        payload: { sessionID: "session-3" },
      },
    ])
  })

  test("event disposes on official disposal events without forwarding them", async () => {
    const forwarded: Array<{ type: string; payload: unknown }> = []
    const disposed: string[] = []

    MissionControlServer.fromContext = (async () => ({
      config: DEFAULT_CONFIG,
      status: async () => ({}),
      readSession: async () => ({}),
      sessionTree: async () => ({}),
      observeSession: async () => ({}),
      searchSessions: async () => ({}),
      async onRuntimeEvent(type: string, payload: unknown) {
        forwarded.push({ type, payload })
      },
      async dispose() {
        disposed.push("disposed")
      },
    }) as any)

    const hooks = await MissionControlPlugin({
      client: {
        app: {
          async log() {
            return undefined
          },
        },
      },
      directory: "/tmp/project",
      worktree: "/tmp/project",
    } as any)

    await hooks.event?.({
      event: {
        type: "global.disposed",
        properties: { sessionID: "ignored-1" },
      },
    } as any)
    await hooks.event?.({
      event: {
        type: "server.instance.disposed",
        properties: { sessionID: "ignored-2" },
      },
    } as any)

    expect(disposed).toEqual(["disposed", "disposed"])
    expect(forwarded).toEqual([])
  })
})
