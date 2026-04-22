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

describe("job tools", () => {
  test("mc_job_events forwards the public args unchanged", async () => {
    const calls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      jobEvents(args: unknown) {
        calls.push(args)
        return {
          ok: true,
          data: {
            jobId: "job_123",
            events: [],
          },
        }
      },
    } as any)

    await tools.mc_job_events.execute({ jobId: "job_123", limit: 15 } as any, {} as any)

    expect(Object.keys(tools.mc_job_events.args).sort()).toEqual(["jobId", "limit"])
    expect(calls).toEqual([{ jobId: "job_123", limit: 15 }])
  })

  test("mc_job_update forwards caller context for child-session inference", async () => {
    const calls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async updateJobProgress(args: unknown, caller: unknown) {
        calls.push({ args, caller })
        return {
          ok: true,
          data: {
            job: {
              jobId: "job_123",
              sessionId: "ses_parent",
              title: "Background work",
              prompt: "Do work",
              state: "running",
              createdAt: 1,
              updatedAt: 2,
              relayState: "pending",
            },
            event: {
              eventId: "evt_1",
              jobId: "job_123",
              sessionId: "ses_parent",
              type: "job.progress",
              state: "running",
              at: 2,
              detail: "checkpoint",
            },
          },
        }
      },
    } as any)

    await tools.mc_job_update.execute(
      {
        message: "checkpoint",
        notifyParent: true,
      } as any,
      {
        sessionID: "child-session",
        directory: "/tmp/project",
        worktree: "/tmp/project",
      } as any,
    )

    expect(Object.keys(tools.mc_job_update.args).sort()).toEqual(["jobId", "message", "notifyParent"].sort())
    expect(calls).toEqual([
      {
        args: {
          jobId: undefined,
          message: "checkpoint",
          notifyParent: true,
        },
        caller: {
          sessionId: "child-session",
          directory: "/tmp/project",
          worktree: "/tmp/project",
        },
      },
    ])
  })

  test("permission and question reply tools forward the public v2 args", async () => {
    const permissionCalls: unknown[] = []
    const questionCalls: unknown[] = []
    const rejectCalls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async replyJobPermission(args: unknown) {
        permissionCalls.push(args)
        return { ok: true, data: {} }
      },
      async replyJobQuestion(args: unknown) {
        questionCalls.push(args)
        return { ok: true, data: {} }
      },
      async rejectJobQuestion(jobId: string) {
        rejectCalls.push(jobId)
        return { ok: true, data: {} }
      },
    } as any)

    await tools.mc_job_permission_reply.execute({ jobId: "job_123", reply: "once", message: "ok" } as any, {} as any)
    await tools.mc_job_question_reply.execute({ jobId: "job_123", answers: [["src/"]] } as any, {} as any)
    await tools.mc_job_question_reject.execute({ jobId: "job_123" } as any, {} as any)

    expect(permissionCalls).toEqual([{ jobId: "job_123", reply: "once", message: "ok" }])
    expect(questionCalls).toEqual([{ jobId: "job_123", answers: [["src/"]] }])
    expect(rejectCalls).toEqual(["job_123"])
  })
})
