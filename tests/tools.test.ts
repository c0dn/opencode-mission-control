import { describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG } from "../src/config.ts"
import { createMissionControlTools } from "../src/tools.ts"

describe("mission_control_session_search tool", () => {
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

    const searchTool = tools.mission_control_session_search
    expect(Object.keys(searchTool.args).sort()).toEqual(["exact", "global", "limit", "query", "sessionID"].sort())

    await searchTool.execute({
      query: "CTF",
      sessionID: "ses_123",
      global: true,
      exact: true,
      limit: 7,
    } as any, {} as any)

    expect(calls).toEqual([
      {
        query: "CTF",
        sessionID: "ses_123",
        global: true,
        exact: true,
        limit: 7,
      },
    ])
  })
})

describe("mission_control_session_read tool", () => {
  test("forwards beforeMessageID to the session service", async () => {
    const calls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async readSession(sessionID: string, options: unknown) {
        calls.push({ sessionID, options })
        return {
          ok: true,
          data: {
            sessionID,
            entries: [],
            includedChildSessionIDs: [],
          },
        }
      },
    } as any)

    const readTool = tools.mission_control_session_read
    expect(Object.keys(readTool.args).sort()).toEqual(
      ["beforeMessageID", "includeChildren", "includeToolOutputs", "limit", "sessionID"].sort(),
    )

    await readTool.execute(
      {
        sessionID: "ses_123",
        beforeMessageID: "msg_7",
        limit: 4,
        includeChildren: true,
        includeToolOutputs: false,
      } as any,
      {} as any,
    )

    expect(calls).toEqual([
      {
        sessionID: "ses_123",
        options: {
          beforeMessageID: "msg_7",
          limit: 4,
          includeChildren: true,
          includeToolOutputs: false,
        },
      },
    ])
  })
})
