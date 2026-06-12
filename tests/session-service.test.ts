import { describe, expect, test } from "bun:test"

import { GlobalSessionDiscoveryError, OpenCodeAdapter } from "../src/opencode-client.ts"
import { MissionControlRuntimeState } from "../src/runtime-state.ts"
import { MissionControlSessionService } from "../src/session-service.ts"

// ---------------------------------------------------------------------------
// V2 SDK test helpers
// ---------------------------------------------------------------------------

/**
 * Convert a classic { info, parts } test fixture to V2 format.
 * Used to migrate test data without rewriting every fixture inline.
 */
const toV2Item = (classic: any): any => {
  const info = classic?.info ?? {}
  const parts = classic?.parts ?? []
  const time = info.time ?? { created: 0 }

  if (info.role === "user") {
    const textPart = parts.find((p: any) => p.type === "text")
    return { id: info.id, type: "user", time, text: textPart?.text ?? "" }
  }

  return {
    id: info.id,
    type: "assistant",
    time,
    ...(info.agent ? { agent: info.agent } : {}),
    content: parts.map((p: any) => {
      if (p.type === "text") return { type: "text", text: p.text ?? "" }
      if (p.type === "reasoning") return { id: p.id, type: "reasoning", text: p.text ?? "" }
      if (p.type === "tool")
        return {
          id: p.id,
          type: "tool",
          name: p.tool ?? p.toolName ?? "unknown",
          state: {
            status: p.state?.status ?? "completed",
            content: [{ type: "text", text: p.state?.output ?? p.text ?? "" }],
            input: {},
            structured: {},
          },
        }
      return { type: p.type, text: p.text ?? "" }
    }),
  }
}

/**
 * Creates a V2 SDK client mock for paged reads.
 * Simulates V2 cursor semantics: first call has order:"desc" (newest first),
 * follow-up calls have cursor only. Items are returned in desc order so the
 * adapter can reverse them to ascending within each page.
 *
 * The cursor encodes the window end index: sessionID:endIndex
 */
const createV2PagedSdkClient = (messagesBySession: Record<string, any[]>) => {
  const calls: Array<{
    sessionID: string
    directory?: string
    limit?: number
    order?: string
    cursor?: string
  }> = []

  return {
    calls,
    v2: {
      session: {
        messages: async (
          params: {
            sessionID: string
            directory?: string
            limit?: number
            order?: string
            cursor?: string
          },
          _options?: unknown,
        ) => {
          calls.push({
            sessionID: params.sessionID,
            ...(typeof params.directory === "string" ? { directory: params.directory } : {}),
            ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
            ...(typeof params.order === "string" ? { order: params.order } : {}),
            ...(typeof params.cursor === "string" ? { cursor: params.cursor } : {}),
          })

          const allMessages = (messagesBySession[params.sessionID] ?? []).map(toV2Item)
          const limit = typeof params.limit === "number" ? params.limit : allMessages.length

          // Decode cursor → endIndex (exclusive upper bound of the window)
          const endIndex = params.cursor
            ? Number.parseInt(params.cursor.split(":").at(-1) ?? "", 10)
            : allMessages.length
          const normalizedEnd = Number.isNaN(endIndex)
            ? allMessages.length
            : Math.max(0, Math.min(allMessages.length, endIndex))
          const startIndex = Math.max(0, normalizedEnd - limit)

          // Return items in desc order (newest first in window) — adapter reverses to asc
          const items = allMessages.slice(startIndex, normalizedEnd).reverse()
          const nextCursor = startIndex > 0 ? `${params.sessionID}:${startIndex}` : undefined

          return { items, cursor: { ...(nextCursor ? { next: nextCursor } : {}) } }
        },
      },
    },
  }
}

describe("MissionControlSessionService", () => {
  test("gets normalized session metadata without reading transcript entries", async () => {
    let messagesCalled = false
    const adapter = new OpenCodeAdapter(
      {
        session: {
          async get({ path }: { path: { id: string } }) {
            return {
              id: path.id,
              directory: "/tmp/project",
              parentID: "parent-session",
              title: "Build notes",
              status: "idle",
              time: { created: 10, updated: 20 },
            }
          },
        },
      },
      {
        sdkClient: {
          v2: {
            session: {
              async messages() {
                messagesCalled = true
                return { items: [], cursor: {} }
              },
            },
          },
        },
      },
    )

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.getSession(adapter, "ses_123")

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected session metadata lookup to succeed")
    }

    expect(result.data.session).toEqual({
      sessionId: "ses_123",
      title: "Build notes",
      directory: "/tmp/project",
      parentSessionId: "parent-session",
      createdAt: 10,
      updatedAt: 20,
      status: "idle",
    })
    expect(messagesCalled).toBe(false)
  })

  test("aborts a resolved session using recovered directory and workspace scope", async () => {
    const calls: unknown[] = []
    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const adapter = {
      async resolveSession(sessionId: string) {
        calls.push({ method: "resolveSession", sessionId })
        return {
          session: { id: sessionId, directory: "/tmp/project", workspaceID: "workspace-1" },
          directory: "/tmp/project",
          workspaceID: "workspace-1",
        }
      },
      async abortSession(sessionId: string, directory?: string, workspaceID?: string) {
        calls.push({ method: "abortSession", sessionId, directory, workspaceID })
        return false
      },
      async debug() {},
    } as unknown as OpenCodeAdapter

    const result = await service.abortSession(adapter, "ses_child")

    expect(result).toEqual({
      ok: true,
      data: {
        sessionId: "ses_child",
        requestAccepted: true,
        aborted: false,
        result: false,
        note: "Abort requested through OpenCode. This is most useful for background subagents by subagent session ID; foreground subagents can block the parent tool loop until they return.",
      },
    })
    expect(calls).toEqual([
      { method: "resolveSession", sessionId: "ses_child" },
      { method: "abortSession", sessionId: "ses_child", directory: "/tmp/project", workspaceID: "workspace-1" },
    ])
  })

  test("sendMessageAsync resolves scope then delivers with sender envelope", async () => {
    const calls: unknown[] = []
    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const adapter = {
      async resolveSession(sessionId: string) {
        calls.push({ method: "resolveSession", sessionId })
        return {
          session: { id: sessionId, directory: "/tmp/project", workspaceID: "workspace-1" },
          directory: "/tmp/project",
          workspaceID: "workspace-1",
        }
      },
      async sendSessionMessageAsync(sessionId: string, text: string, options?: unknown) {
        calls.push({ method: "sendSessionMessageAsync", sessionId, text, options })
        return { ok: true }
      },
      async debug() {},
    } as unknown as OpenCodeAdapter

    const result = await service.sendMessageAsync(adapter, "ses_target", "hello there", "ses_sender")

    expect(result).toEqual({
      ok: true,
      data: {
        targetSessionId: "ses_target",
        fromSessionId: "ses_sender",
        delivery: "async",
        requestAccepted: true,
        note: "Message queued via OpenCode prompt_async; the target session processes it at its next loop boundary, not mid-response.",
      },
    })
    expect(calls).toEqual([
      { method: "resolveSession", sessionId: "ses_target" },
      {
        method: "sendSessionMessageAsync",
        sessionId: "ses_target",
        text: '<inter_agent_message from="ses_sender">\nhello there\n</inter_agent_message>',
        options: { directory: "/tmp/project", workspaceID: "workspace-1" },
      },
    ])
  })

  test("sendMessageAsync returns SessionNotFound when resolve fails", async () => {
    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const adapter = {
      async resolveSession() {
        throw new Error("not found")
      },
      async sendSessionMessageAsync() {
        throw new Error("delivery should not be attempted when resolve fails")
      },
      async debug() {},
    } as unknown as OpenCodeAdapter

    const result = await service.sendMessageAsync(adapter, "ses_missing", "hi")

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error("Expected resolve failure")
    }
    expect(result.error.code).toBe("SessionNotFound")
  })

  test("sendMessageAsync returns SessionLookupUnavailable when delivery returns ok:false", async () => {
    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const adapter = {
      async resolveSession(sessionId: string) {
        return { session: { id: sessionId }, directory: "/tmp/project", workspaceID: "workspace-1" }
      },
      async sendSessionMessageAsync() {
        return { ok: false }
      },
      async debug() {},
    } as unknown as OpenCodeAdapter

    const result = await service.sendMessageAsync(adapter, "ses_target", "hi")

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error("Expected delivery failure")
    }
    expect(result.error.code).toBe("SessionLookupUnavailable")
  })

  test("sendMessageAsync rejects child/subagent targets before delivery", async () => {
    const calls: unknown[] = []
    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const adapter = {
      async resolveSession(sessionId: string) {
        calls.push({ method: "resolveSession", sessionId })
        return {
          session: { id: sessionId, parentID: "ses_parent" },
          directory: "/tmp/project",
          workspaceID: "workspace-1",
        }
      },
      async sendSessionMessageAsync() {
        calls.push({ method: "sendSessionMessageAsync" })
        return { ok: true }
      },
      async debug() {},
    } as unknown as OpenCodeAdapter

    const result = await service.sendMessageAsync(adapter, "ses_child", "hi")

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error("Expected child-session rejection")
    }
    expect(result.error.code).toBe("SubagentPromptRejected")
    expect(result.error.message).toContain("ses_parent")
    expect(calls).toEqual([{ method: "resolveSession", sessionId: "ses_child" }])
  })

  test("sendMessageInterrupt aborts before delivering and still delivers when abort throws", async () => {
    const order: string[] = []
    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const adapter = {
      async resolveSession(sessionId: string) {
        return { session: { id: sessionId }, directory: "/tmp/project", workspaceID: "workspace-1" }
      },
      async abortSession(sessionId: string, directory?: string, workspaceID?: string) {
        order.push(`abort:${sessionId}:${directory}:${workspaceID}`)
        throw new Error("abort failed")
      },
      async sendSessionMessageAsync(sessionId: string, text: string, options?: unknown) {
        order.push(`deliver:${sessionId}`)
        return { ok: true }
      },
      async debug() {},
    } as unknown as OpenCodeAdapter

    const result = await service.sendMessageInterrupt(adapter, "ses_target", "stop now", "ses_sender")

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected interrupt delivery to succeed despite abort failure")
    }
    expect(result.data).toEqual({
      targetSessionId: "ses_target",
      fromSessionId: "ses_sender",
      delivery: "interrupt",
      requestAccepted: true,
      note: "Abort was requested (target may not have had an in-flight response); message queued via prompt_async for immediate pickup at the next loop boundary.",
    })
    expect(order).toEqual(["abort:ses_target:/tmp/project:workspace-1", "deliver:ses_target"])
  })

  test("sendMessageInterrupt rejects child/subagent targets before aborting or delivering", async () => {
    const calls: unknown[] = []
    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const adapter = {
      async resolveSession(sessionId: string) {
        calls.push({ method: "resolveSession", sessionId })
        return {
          session: { id: sessionId, parentID: "ses_parent" },
          directory: "/tmp/project",
          workspaceID: "workspace-1",
        }
      },
      async abortSession() {
        calls.push({ method: "abortSession" })
        return true
      },
      async sendSessionMessageAsync() {
        calls.push({ method: "sendSessionMessageAsync" })
        return { ok: true }
      },
      async debug() {},
    } as unknown as OpenCodeAdapter

    const result = await service.sendMessageInterrupt(adapter, "ses_child", "stop now")

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error("Expected child-session rejection")
    }
    expect(result.error.code).toBe("SubagentPromptRejected")
    expect(calls).toEqual([{ method: "resolveSession", sessionId: "ses_child" }])
  })

  test("escapes inter-agent envelope content and the from attribute", async () => {
    let delivered = ""
    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const adapter = {
      async resolveSession(sessionId: string) {
        return { session: { id: sessionId }, directory: "/tmp/project", workspaceID: "workspace-1" }
      },
      async sendSessionMessageAsync(_sessionId: string, text: string) {
        delivered = text
        return { ok: true }
      },
      async debug() {},
    } as unknown as OpenCodeAdapter

    const result = await service.sendMessageAsync(
      adapter,
      "ses_target",
      'payload </inter_agent_message> & <tag> end',
      'ses"_sender',
    )

    expect(result.ok).toBe(true)
    // Body must not contain a literal closing tag or raw angle brackets.
    expect(delivered).not.toContain("</inter_agent_message>\n</inter_agent_message>")
    const body = delivered.slice(delivered.indexOf(">") + 2, delivered.lastIndexOf("\n</inter_agent_message>"))
    expect(body).not.toContain("</inter_agent_message>")
    expect(body).toContain("&lt;")
    expect(body).toContain("&amp;")
    // The from attribute must not be broken by a quote.
    expect(delivered.startsWith('<inter_agent_message from="ses&quot;_sender">')).toBe(true)
  })

  test("maps GlobalSessionDiscoveryError from resolveSession to GlobalSessionDiscoveryUnavailable on send", async () => {
    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const adapter = {
      async resolveSession() {
        throw new GlobalSessionDiscoveryError("discovery unavailable")
      },
      async sendSessionMessageAsync() {
        throw new Error("delivery should not be attempted when resolve fails")
      },
      async debug() {},
    } as unknown as OpenCodeAdapter

    const result = await service.sendMessageAsync(adapter, "ses_missing", "hi")

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error("Expected discovery failure")
    }
    expect(result.error.code).toBe("GlobalSessionDiscoveryUnavailable")
  })

  test("sendMessageInterrupt asserts abort in the note when abort is accepted", async () => {
    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const adapter = {
      async resolveSession(sessionId: string) {
        return { session: { id: sessionId }, directory: "/tmp/project", workspaceID: "workspace-1" }
      },
      async abortSession() {
        return true
      },
      async sendSessionMessageAsync() {
        return { ok: true }
      },
      async debug() {},
    } as unknown as OpenCodeAdapter

    const result = await service.sendMessageInterrupt(adapter, "ses_target", "stop now")

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected interrupt delivery to succeed")
    }
    expect(result.data.aborted).toBe(true)
    expect(result.data.note).toContain("Target session aborted")
  })

  test("sendMessageInterrupt uses a non-asserting note when abort is not accepted", async () => {
    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const adapter = {
      async resolveSession(sessionId: string) {
        return { session: { id: sessionId }, directory: "/tmp/project", workspaceID: "workspace-1" }
      },
      async abortSession() {
        return false
      },
      async sendSessionMessageAsync() {
        return { ok: true }
      },
      async debug() {},
    } as unknown as OpenCodeAdapter

    const result = await service.sendMessageInterrupt(adapter, "ses_target", "stop now")

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected interrupt delivery to succeed")
    }
    expect(result.data.aborted).toBe(false)
    expect(result.data.note).not.toContain("Target session aborted")
    expect(result.data.note).toContain("Abort was requested")
  })

  test("sendMessageInterrupt surfaces abort state when delivery fails after an accepted abort", async () => {
    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const adapter = {
      async resolveSession(sessionId: string) {
        return { session: { id: sessionId }, directory: "/tmp/project", workspaceID: "workspace-1" }
      },
      async abortSession() {
        return true
      },
      async sendSessionMessageAsync() {
        return { ok: false }
      },
      async debug() {},
    } as unknown as OpenCodeAdapter

    const result = await service.sendMessageInterrupt(adapter, "ses_target", "stop now")

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error("Expected delivery failure")
    }
    expect(result.error.code).toBe("SessionLookupUnavailable")
    expect(result.error.message).toContain("may already have been aborted")
  })

  test("finds sessions by exact title and flags ambiguity", async () => {
    const adapter = new OpenCodeAdapter({
      session: {
        async list() {
          return [
            {
              id: "ses_1",
              directory: "/tmp/project",
              title: "Build notes",
              time: { created: 1, updated: 2 },
            },
            {
              id: "ses_2",
              directory: "/tmp/project",
              title: "Build notes",
              parentID: "ses_1",
              time: { created: 3, updated: 4 },
            },
            {
              id: "ses_3",
              directory: "/tmp/project",
              title: "build notes",
              time: { created: 5, updated: 6 },
            },
          ]
        },
      },
    })

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.findSessions(adapter, { title: "Build notes" })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected exact-title session lookup to succeed")
    }

    expect(result.data).toEqual({
      title: "Build notes",
      scope: "local",
      ambiguous: true,
      candidates: [
        {
          sessionId: "ses_2",
          title: "Build notes",
          directory: "/tmp/project",
          parentSessionId: "ses_1",
          createdAt: 3,
          updatedAt: 4,
          status: undefined,
        },
        {
          sessionId: "ses_1",
          title: "Build notes",
          directory: "/tmp/project",
          parentSessionId: undefined,
          createdAt: 1,
          updatedAt: 2,
          status: undefined,
        },
      ],
    })
  })

  test("maps global title lookup discovery failures to actionable errors", async () => {
    const adapter = new OpenCodeAdapter({
      session: {
        async list() {
          throw new Error("global discovery unavailable")
        },
      },
    })

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.findSessions(adapter, { title: "Build notes", scope: "global" })

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error("Expected global discovery failure")
    }

    expect(result.error.code).toBe("GlobalSessionDiscoveryUnavailable")
    expect(result.error.suggestion).toContain("scope: 'local'")
  })

  test("reads a session outside the current directory by resolving its actual directory first", async () => {
    const remoteDirectory = "/tmp/remote-project"
    let globalListCalls = 0
    let messageParams: { sessionID?: string; directory?: string } = {}

    const v2SdkClient = {
      v2: {
        session: {
          async messages(params: { sessionID: string; directory?: string; limit?: number; order?: string }) {
            messageParams = { sessionID: params.sessionID, directory: params.directory }
            return {
              items: [
                {
                  id: "remote-message",
                  type: "assistant",
                  time: { created: 3 },
                  content: [{ type: "text", text: "Cross-directory transcript content" }],
                },
              ],
              cursor: {},
            }
          },
        },
      },
    }

    const adapter = new OpenCodeAdapter(
      {
        session: {
          async get({ path, query }: { path: { id: string }; query?: { directory?: string } }) {
            if (path.id !== "remote-session") throw new Error("not found")
            if (query?.directory === remoteDirectory) {
              return { id: "remote-session", directory: remoteDirectory, title: "Remote Session", time: { created: 1, updated: 2 } }
            }
            throw new Error("not found")
          },
          async list({ query }: { query?: { directory?: string } } = {}) {
            if (query?.directory === "") {
              globalListCalls += 1
              return [{ id: "remote-session", directory: remoteDirectory, title: "Remote Session", time: { created: 1, updated: 2 } }]
            }
            return []
          },
        },
      },
      { sdkClient: v2SdkClient },
    )

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "remote-session", {})

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected cross-directory session read to succeed")

    expect(result.data.entries[0]?.parts[0]?.text).toContain("Cross-directory transcript")
    expect(result.data.offset).toBe(0)
    expect(result.data.hasMore).toBe(false)
    expect(result.data.totalEntries).toBe(1)
    expect(result.data.totalEntriesExact).toBe(true)
    expect(globalListCalls).toBe(1)
    expect(messageParams.sessionID).toBe("remote-session")
    expect(messageParams.directory).toBe(remoteDirectory)
  })

  test("applies beforeMessageId before limit across parent and child transcript entries", async () => {
    const pagedClient = createV2PagedSdkClient({
      "root-session": [
        { info: { id: "msg-1", role: "assistant", time: { created: 1 } }, parts: [{ id: "part-1", type: "text", text: "root-1" }] },
        { info: { id: "msg-3", role: "assistant", time: { created: 3 } }, parts: [{ id: "part-3", type: "text", text: "root-3" }] },
      ],
      "child-session": [
        { info: { id: "msg-2", role: "assistant", time: { created: 2 } }, parts: [{ id: "part-2", type: "text", text: "child-2" }] },
        { info: { id: "msg-4", role: "assistant", time: { created: 4 } }, parts: [{ id: "part-4", type: "text", text: "child-4" }] },
      ],
    })

    const adapter = new OpenCodeAdapter(
      {
        session: {
          async get({ path }: { path: { id: string } }) {
            return { id: path.id, directory: "/tmp/project", title: path.id, time: { created: 1, updated: 2 } }
          },
          async children() {
            return [{ id: "child-session", directory: "/tmp/project", parentID: "root-session", title: "Child Session", time: { created: 3, updated: 4 } }]
          },
        },
      },
      { sdkClient: pagedClient },
    )

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "root-session", {
      beforeMessageId: "msg-4",
      withChildren: true,
      limit: 2,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected session read with beforeMessageId to succeed")

    expect(result.data.entries.map((entry) => entry.messageId)).toEqual(["msg-2", "msg-3"])
    expect(result.data.includedChildSessionIds).toEqual(["child-session"])
    expect(result.data.hasMore).toBe(true)
    expect(result.data.nextOffset).toBe(2)
    expect(result.data.totalEntries).toBe(3)
    expect(result.data.totalEntriesExact).toBe(true)
    // beforeMessageId forces full-history path; full read uses V2 paginate-to-completion
    expect(pagedClient.calls.every((c) => c.order === "asc" || c.cursor !== undefined)).toBe(true)
  })

  test("treats beforeMessageId as a hard boundary even when the cursor message is filtered out", async () => {
    const v2SdkClient = {
      v2: {
        session: {
          async messages(_params: unknown) {
            return {
              items: [
                { id: "msg-1", type: "assistant", time: { created: 1 }, content: [{ type: "text", text: "visible before cursor" }] },
                { id: "msg-2", type: "assistant", time: { created: 2 }, content: [{ id: "part-2", type: "tool", name: "read", state: { status: "completed", content: [{ type: "text", text: "tool output boundary" }], input: {}, structured: {} } }] },
                { id: "msg-3", type: "assistant", time: { created: 3 }, content: [{ type: "text", text: "should not leak past cursor" }] },
              ],
              cursor: {},
            }
          },
        },
      },
    }

    const adapter = new OpenCodeAdapter(
      {
        session: {
          async get({ path }: { path: { id: string } }) {
            return { id: path.id, directory: "/tmp/project", title: path.id, time: { created: 1, updated: 2 } }
          },
        },
      },
      { sdkClient: v2SdkClient },
    )

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "root-session", { beforeMessageId: "msg-2", withToolOutputs: false })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected filtered cursor session read to succeed")

    expect(result.data.entries.map((entry) => entry.messageId)).toEqual(["msg-1"])
    expect(result.data.totalEntriesExact).toBe(true)
  })

  test("uses cached child directories when withChildren child records omit directory", async () => {
    const runtimeState = new MissionControlRuntimeState(20)
    runtimeState.recordEvent("session.created", {
      sessionID: "child-session",
      parentID: "root-session",
      directory: "/tmp/child-project",
      title: "Child Session",
      time: { created: 2, updated: 3 },
    })

    const seenDirectories: Record<string, string | undefined> = {}

    const v2SdkClient = {
      v2: {
        session: {
          async messages(params: { sessionID: string; directory?: string; limit?: number; order?: string }) {
            seenDirectories[params.sessionID] = params.directory
            if (params.sessionID === "root-session") {
              return { items: [{ id: "root-message", type: "assistant", time: { created: 1 }, content: [{ type: "text", text: "root" }] }], cursor: {} }
            }
            return { items: [{ id: "child-message", type: "assistant", time: { created: 2 }, content: [{ type: "text", text: "child" }] }], cursor: {} }
          },
        },
      },
    }

    const adapter = new OpenCodeAdapter(
      {
        session: {
          async get({ path }: { path: { id: string } }) {
            return { id: path.id, directory: "/tmp/root-project", title: path.id, time: { created: 1, updated: 2 } }
          },
          async children() {
            return [{ id: "child-session", parentID: "root-session", title: "Child Session" }]
          },
        },
      },
      { sdkClient: v2SdkClient },
    )

    const service = new MissionControlSessionService(runtimeState)
    const result = await service.readSession(adapter, "root-session", { withChildren: true })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected cached-child-directory read to succeed")

    expect(result.data.entries.map((entry) => entry.messageId)).toEqual(["root-message", "child-message"])
    expect(result.data.totalEntriesExact).toBe(true)
    expect(seenDirectories["root-session"]).toBe("/tmp/root-project")
    expect(seenDirectories["child-session"]).toBe("/tmp/child-project")
  })

  test("pages transcript entries from the newest messages using offset and limit", async () => {
    const pagedClient = createV2PagedSdkClient({
      "root-session": [
        { info: { id: "msg-1", role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: "one" }] },
        { info: { id: "msg-2", role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "two" }] },
        { info: { id: "msg-3", role: "assistant", time: { created: 3 } }, parts: [{ type: "text", text: "three" }] },
        { info: { id: "msg-4", role: "assistant", time: { created: 4 } }, parts: [{ type: "text", text: "four" }] },
      ],
    })

    const adapter = new OpenCodeAdapter(
      {
        session: {
          async get({ path }: { path: { id: string } }) {
            return { id: path.id, directory: "/tmp/project", title: path.id, time: { created: 1, updated: 2 } }
          },
        },
      },
      { sdkClient: pagedClient },
    )

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "root-session", { offset: 1, limit: 2 })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected paged session read to succeed")

    expect(result.data.entries.map((entry) => entry.messageId)).toEqual(["msg-2", "msg-3"])
    expect(result.data.offset).toBe(1)
    expect(result.data.hasMore).toBe(true)
    expect(result.data.nextOffset).toBe(3)
    expect(result.data.totalEntries).toBe(4)
  })

  test("uses the optimized limited-page path across parent and child sessions in chronological order", async () => {
    const pagedClient = createV2PagedSdkClient({
      "root-session": [
        { info: { id: "msg-1", role: "assistant", time: { created: 1 } }, parts: [{ id: "part-1", type: "text", text: "root-1" }] },
        { info: { id: "msg-3", role: "assistant", time: { created: 3 } }, parts: [{ id: "part-3", type: "text", text: "root-3" }] },
      ],
      "child-session": [
        { info: { id: "msg-2", role: "assistant", time: { created: 2 } }, parts: [{ id: "part-2", type: "text", text: "child-2" }] },
        { info: { id: "msg-4", role: "assistant", time: { created: 4 } }, parts: [{ id: "part-4", type: "text", text: "child-4" }] },
      ],
    })

    const adapter = new OpenCodeAdapter(
      {
        session: {
          async get({ path }: { path: { id: string } }) {
            return { id: path.id, directory: "/tmp/project", title: path.id, time: { created: 1, updated: 2 } }
          },
          async children() {
            return [{ id: "child-session", directory: "/tmp/project", parentID: "root-session", title: "Child Session", time: { created: 3, updated: 4 } }]
          },
        },
      },
      { sdkClient: pagedClient },
    )

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "root-session", { withChildren: true, limit: 2 })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected optimized cross-session session read to succeed")

    expect(result.data.entries.map((entry) => entry.messageId)).toEqual(["msg-3", "msg-4"])
    expect(result.data.includedChildSessionIds).toEqual(["child-session"])
    expect(result.data.offset).toBe(0)
    expect(result.data.hasMore).toBe(true)
    expect(result.data.nextOffset).toBe(2)
    // paged path probes offset+limit+1=3 records; totalEntries is a lower bound
    expect(result.data.totalEntries).toBe(3)
    expect(result.data.totalEntriesExact).toBe(false)
  })

  test("uses V2 session-message paging for limited parent+child reads and reports a lower-bound total", async () => {
    const pagedClient = createV2PagedSdkClient({
      "root-session": [
        { info: { id: "msg-1", role: "assistant", time: { created: 1 } }, parts: [{ id: "part-1", type: "text", text: "root-1" }] },
        { info: { id: "msg-3", role: "assistant", time: { created: 3 } }, parts: [{ id: "part-3", type: "text", text: "root-3" }] },
      ],
      "child-session": [
        { info: { id: "msg-2", role: "assistant", time: { created: 2 } }, parts: [{ id: "part-2", type: "text", text: "child-2" }] },
        { info: { id: "msg-4", role: "assistant", time: { created: 4 } }, parts: [{ id: "part-4", type: "text", text: "child-4" }] },
      ],
    })

    const adapter = new OpenCodeAdapter(
      {
        session: {
          async get({ path }: { path: { id: string } }) {
            return { id: path.id, directory: "/tmp/project", title: path.id, time: { created: 1, updated: 2 } }
          },
          async children() {
            return [{ id: "child-session", directory: "/tmp/project", parentID: "root-session", title: "Child Session", time: { created: 3, updated: 4 } }]
          },
        },
      },
      { sdkClient: pagedClient },
    )

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "root-session", { withChildren: true, limit: 2 })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected V2-paged cross-session read to succeed")

    expect(result.data.entries.map((entry) => entry.messageId)).toEqual(["msg-3", "msg-4"])
    expect(result.data.includedChildSessionIds).toEqual(["child-session"])
    expect(result.data.offset).toBe(0)
    expect(result.data.hasMore).toBe(true)
    expect(result.data.nextOffset).toBe(2)
    expect(result.data.totalEntries).toBe(3)
    expect(result.data.totalEntriesExact).toBe(false)
    // V2 paged calls: first per session uses order:desc, subsequent use cursor
    const rootCalls = pagedClient.calls.filter((c) => c.sessionID === "root-session")
    expect(rootCalls[0]).toMatchObject({ order: "desc", limit: 25 })
  })

  test("follows V2 cursor pages when a limited read needs to walk into older messages", async () => {
    const pagedClient = createV2PagedSdkClient({
      "root-session": Array.from({ length: 250 }, (_, index) => ({
        info: { id: `msg-${index + 1}`, role: "assistant", time: { created: index + 1 } },
        parts: [{ id: `part-${index + 1}`, type: "text", text: `root-${index + 1}` }],
      })),
    })

    const adapter = new OpenCodeAdapter(
      {
        session: {
          async get({ path }: { path: { id: string } }) {
            return { id: path.id, directory: "/tmp/project", title: path.id, time: { created: 1, updated: 2 } }
          },
        },
      },
      { sdkClient: pagedClient },
    )

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "root-session", { offset: 205, limit: 2 })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected V2 cursor paging read to succeed")

    expect(result.data.entries.map((entry) => entry.messageId)).toEqual(["msg-44", "msg-45"])
    expect(result.data.hasMore).toBe(true)
    expect(result.data.nextOffset).toBe(207)
    expect(result.data.totalEntries).toBe(208)
    expect(result.data.totalEntriesExact).toBe(false)
    // First call must be desc (no cursor); subsequent calls use cursor (no order)
    expect(pagedClient.calls[0]).toMatchObject({ sessionID: "root-session", order: "desc" })
    expect(pagedClient.calls[0]).not.toMatchObject({ cursor: expect.anything() })
    if (pagedClient.calls.length > 1) {
      expect(pagedClient.calls[1]?.order).toBeUndefined()
      expect(typeof pagedClient.calls[1]?.cursor).toBe("string")
    }
  })

  test("uses V2 session-message paging for limited tails and keeps newest-relative ordering", async () => {
    const pagedClient = createV2PagedSdkClient({
      "root-session": [
        { info: { id: "msg-1", role: "assistant", time: { created: 1 } }, parts: [{ id: "part-1", type: "text", text: "root-1" }] },
        { info: { id: "msg-3", role: "assistant", time: { created: 3 } }, parts: [{ id: "part-3", type: "text", text: "root-3" }] },
      ],
      "child-session": [
        { info: { id: "msg-2", role: "assistant", time: { created: 2 } }, parts: [{ id: "part-2", type: "text", text: "child-2" }] },
        { info: { id: "msg-4", role: "assistant", time: { created: 4 } }, parts: [{ id: "part-4", type: "text", text: "child-4" }] },
      ],
    })

    const adapter = new OpenCodeAdapter(
      {
        session: {
          async get({ path }: { path: { id: string } }) {
            return { id: path.id, directory: "/tmp/project", title: path.id, time: { created: 1, updated: 2 } }
          },
          async children() {
            return [{ id: "child-session", directory: "/tmp/project", parentID: "root-session", title: "Child Session", time: { created: 3, updated: 4 } }]
          },
        },
      },
      { sdkClient: pagedClient },
    )

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.tailSession(adapter, "root-session", { withChildren: true, offset: 1, limit: 1 })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected V2-paged session tail to succeed")

    expect(result.data.entries).toEqual([expect.objectContaining({ messageId: "msg-3", text: "root-3" })])
    expect(result.data.includedChildSessionIds).toEqual(["child-session"])
    expect(result.data.offset).toBe(1)
    expect(result.data.hasMore).toBe(true)
    expect(result.data.nextOffset).toBe(2)
    expect(result.data.totalEntries).toBe(3)
    expect(result.data.totalEntriesExact).toBe(false)
  })

  test("returns a text-only tail view without step markers, tool outputs, agent-switches, or model-switches", async () => {
    const pagedClient = createV2PagedSdkClient({
      "root-session": [
        {
          // V2 assistant message: text + reasoning + tool content
          info: { id: "msg-1", role: "assistant", time: { created: 1 } },
          parts: [
            { id: "part-text", type: "text", text: "human text" },
            { id: "part-reasoning", type: "reasoning", text: "internal chain" },
            { id: "part-tool", type: "tool", tool: "bash", toolName: "bash", state: { output: "tool output" } },
          ],
        },
        {
          // Tool-only message — should be filtered from tail
          info: { id: "msg-2", role: "assistant", time: { created: 2 } },
          parts: [{ id: "part-tool-only", type: "tool", tool: "read", toolName: "read", state: { output: "tool only" } }],
        },
      ],
    })

    const adapter = new OpenCodeAdapter(
      {
        session: {
          async get({ path }: { path: { id: string } }) {
            return { id: path.id, directory: "/tmp/project", title: path.id, time: { created: 1, updated: 2 } }
          },
        },
      },
      { sdkClient: pagedClient },
    )

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.tailSession(adapter, "root-session", { limit: 10 })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected session tail to succeed")

    expect(result.data.entries).toEqual([expect.objectContaining({ messageId: "msg-1", text: "human text" })])
    expect(result.data.totalEntries).toBe(1)
    // Both messages fit in one page; cursor.next absent → not hasMore → exact count
    expect(result.data.totalEntriesExact).toBe(true)
  })

  test("tail excludes agent-switched and model-switched but includes compaction summary", async () => {
    const pagedClient = createV2PagedSdkClient({
      "root-session": [
        // classic fixtures — toV2Item converts them for the mock
        { info: { id: "msg-sw", role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: "before" }] },
      ],
    })

    // Inject V2 events directly — not representable in classic fixture format
    const v2SdkClient = {
      v2: {
        session: {
          async messages(_params: unknown) {
            return {
              items: [
                { id: "msg-ag", type: "agent-switched", time: { created: 1 }, agent: "gpt-4o" },
                { id: "msg-mdl", type: "model-switched", time: { created: 2 }, model: { id: "claude-opus-4", providerID: "anthropic", variant: "default" } },
                { id: "msg-comp", type: "compaction", time: { created: 3 }, reason: "manual", summary: "summary of work" },
                { id: "msg-txt", type: "user", time: { created: 4 }, text: "continue" },
              ],
              cursor: {},
            }
          },
        },
      },
    }

    const adapter = new OpenCodeAdapter(
      {
        session: {
          async get({ path }: { path: { id: string } }) {
            return { id: path.id, directory: "/tmp/project", title: path.id, time: { created: 1, updated: 2 } }
          },
        },
      },
      { sdkClient: v2SdkClient },
    )

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.tailSession(adapter, "root-session", { limit: 10 })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected tail with events to succeed")

    const ids = result.data.entries.map((e) => e.messageId)
    // compaction summary text and user text appear; switches do not
    expect(ids).toContain("msg-comp")
    expect(ids).toContain("msg-txt")
    expect(ids).not.toContain("msg-ag")
    expect(ids).not.toContain("msg-mdl")
  })
})
