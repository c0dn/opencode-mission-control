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

describe("job tools", () => {
  test("mc_job_start forwards caller session and message context", async () => {
    const calls: unknown[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async startJob(args: unknown, caller: unknown) {
        calls.push({ args, caller })
        return {
          ok: true,
          data: {
            jobId: "job_123",
            sessionId: "ses_parent",
            childSessionId: "ses_child",
            state: "running",
          },
        }
      },
    } as any)

    await tools.mc_job_start.execute(
      {
        prompt: "Do work",
        title: "Background work",
      } as any,
      {
        sessionID: "parent-session",
        messageID: "message-1",
        directory: "/tmp/project",
        worktree: "/tmp/project",
      } as any,
    )

    expect(calls).toEqual([
      {
        args: {
          prompt: "Do work",
          title: "Background work",
        },
        caller: {
          sessionId: "parent-session",
          messageId: "message-1",
          directory: "/tmp/project",
          worktree: "/tmp/project",
        },
      },
    ])
  })

  test("mc_job_start no longer exposes sessionId in its public tool args", () => {
    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      async startJob() {
        return {
          ok: true,
          data: {
            jobId: "job_123",
            sessionId: "ses_parent",
            childSessionId: "ses_child",
            state: "running",
          },
        }
      },
    } as any)

    expect((tools.mc_job_start as any).args.sessionId).toBeUndefined()
  })

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
            jobId: "job_123",
            state: "running",
            eventId: "evt_1",
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
        messageID: "message-1",
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
          messageId: "message-1",
          directory: "/tmp/project",
          worktree: "/tmp/project",
        },
      },
    ])
  })

  test("mc_job_pending_input forwards the job id unchanged", async () => {
    const calls: string[] = []

    const tools = createMissionControlTools({
      config: DEFAULT_CONFIG,
      jobPendingInput(jobId: string) {
        calls.push(jobId)
        return {
          ok: true,
          data: {
            jobId,
            state: "running",
            pendingInput: {
              kind: "permission",
              requestId: "per_1",
              permission: "bash",
              patterns: ["git push"],
              always: [],
            },
          },
        }
      },
    } as any)

    expect(Object.keys(tools.mc_job_pending_input.args)).toEqual(["jobId"])
    await tools.mc_job_pending_input.execute({ jobId: "job_123" } as any, {} as any)
    expect(calls).toEqual(["job_123"])
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

  test("jobs-only tool surface excludes session inspection tools", () => {
    const tools = createMissionControlTools({
      config: {
        ...DEFAULT_CONFIG,
        tools: {
          surface: "jobs-only",
        },
      },
    } as any)

    expect(tools.mc_job_status).toBeDefined()
    expect(tools.mc_job_pending_input).toBeDefined()
    expect(tools.mc_session_read).toBeUndefined()
    expect(tools.mc_session_get).toBeUndefined()
    expect(tools.mc_session_find).toBeUndefined()
    expect(tools.mc_session_tail).toBeUndefined()
    expect(tools.mc_session_search).toBeUndefined()
  })

  test("inspect-only tool surface excludes job orchestration tools", () => {
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
    expect(tools.mc_job_status).toBeUndefined()
    expect(tools.mc_job_start).toBeUndefined()
    expect(tools.mc_job_pending_input).toBeUndefined()
  })
})
