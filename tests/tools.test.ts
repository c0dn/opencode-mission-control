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
    expect(Object.keys(searchTool.args).sort()).toEqual(["exact", "limit", "query", "scope", "sessionId"].sort())

    await searchTool.execute({
      query: "CTF",
      sessionId: "ses_123",
      scope: "global",
      exact: true,
      limit: 7,
    } as any, {} as any)

    expect(calls).toEqual([
        {
          query: "CTF",
          sessionId: "ses_123",
          scope: "global",
          exact: true,
          limit: 7,
        },
    ])
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
          },
        }
      },
    } as any)

    const readTool = tools.mc_session_read
    expect(Object.keys(readTool.args).sort()).toEqual(
      ["beforeMessageId", "limit", "sessionId", "withChildren", "withToolOutputs"].sort(),
    )

    await readTool.execute(
      {
        sessionId: "ses_123",
        beforeMessageId: "msg_7",
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
          limit: 4,
          withChildren: true,
          withToolOutputs: false,
        },
      },
    ])
  })
})
