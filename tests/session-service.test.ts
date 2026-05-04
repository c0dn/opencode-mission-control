import { describe, expect, test } from "bun:test"

import { OpenCodeAdapter } from "../src/opencode-client.ts"
import { MissionControlRuntimeState } from "../src/runtime-state.ts"
import { MissionControlSessionService } from "../src/session-service.ts"

const createPagedMessageClient = (
  messagesBySession: Record<string, any[]>,
  pagerOptions: {
    cursorHeader?: "link" | "x-next-cursor"
  } = {},
) => {
  const calls: Array<{
    method: string
    url: string
    query?: Record<string, unknown>
    responseStyle?: string
  }> = []

  return {
    calls,
    session: {
      messages: async <TData = unknown>(
        params: {
          sessionID: string
          directory?: string
          limit?: number
          before?: string
        },
        requestOptions?: {
          responseStyle?: "data" | "fields"
        },
      ) => {
        const options = {
          method: "GET",
          url: `/session/${encodeURIComponent(params.sessionID)}/message`,
          query: {
            ...(typeof params.directory === "string" ? { directory: params.directory } : {}),
            ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
            ...(typeof params.before === "string" ? { before: params.before } : {}),
          },
          responseStyle: requestOptions?.responseStyle,
        }
        calls.push({
          method: options.method,
          url: options.url,
          query: options.query,
          responseStyle: options.responseStyle,
        })

        const sessionID = params.sessionID
        const messages = messagesBySession[sessionID] ?? []
        const limit = typeof options.query?.limit === "number" ? options.query.limit : messages.length
        const before = typeof options.query?.before === "string" ? options.query.before : undefined
        const endIndex = before ? Number.parseInt(before.split(":").at(-1) ?? "", 10) : messages.length
        const normalizedEndIndex = Number.isNaN(endIndex) ? messages.length : Math.max(0, Math.min(messages.length, endIndex))
        const startIndex = Math.max(0, normalizedEndIndex - limit)
        const page = messages.slice(startIndex, normalizedEndIndex)
        const nextCursor = startIndex > 0 ? `${sessionID}:${startIndex}` : undefined

        if (options.responseStyle === "fields") {
          const headers = new Headers()
          if (nextCursor) {
            if (pagerOptions.cursorHeader === "link") {
              headers.set(
                "Link",
                `</session/${encodeURIComponent(sessionID)}/message?limit=${limit}&before=${encodeURIComponent(nextCursor)}>; rel="next"`,
              )
            } else {
              headers.set("X-Next-Cursor", nextCursor)
            }
          }

          return {
            data: page,
            request: new Request(`https://example.test${options.url}`),
            response: new Response(JSON.stringify(page), { headers }),
          } as TData
        }

        return page as TData
      },
    },
  }
}

describe("MissionControlSessionService", () => {
  test("reads a session outside the current directory by resolving its actual directory first", async () => {
    const remoteDirectory = "/tmp/remote-project"
    let globalListCalls = 0

    const adapter = new OpenCodeAdapter({
      session: {
        async get({ path, query }: { path: { id: string }; query?: { directory?: string } }) {
          if (path.id !== "remote-session") {
            throw new Error("not found")
          }

          if (query?.directory === remoteDirectory) {
            return {
              id: "remote-session",
              directory: remoteDirectory,
              title: "Remote Session",
              time: { created: 1, updated: 2 },
            }
          }

          throw new Error("not found")
        },
        async list({ query }: { query?: { directory?: string } } = {}) {
          if (query?.directory === "") {
            globalListCalls += 1
            return [
              {
                id: "remote-session",
                directory: remoteDirectory,
                title: "Remote Session",
                time: { created: 1, updated: 2 },
              },
            ]
          }

          return []
        },
        async messages({ path, query }: { path: { id: string }; query?: { directory?: string } }) {
          expect(path.id).toBe("remote-session")
          expect(query?.directory).toBe(remoteDirectory)

          return [
            {
              info: {
                id: "remote-message",
                role: "assistant",
                time: { created: 3 },
              },
              parts: [
                {
                  id: "remote-part",
                  type: "text",
                  text: "Cross-directory transcript content",
                },
              ],
            },
          ]
        },
      },
    })

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "remote-session", {})

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected cross-directory session read to succeed")
    }

    expect(result.data.entries[0]?.parts[0]?.text).toContain("Cross-directory transcript")
    expect(result.data.offset).toBe(0)
    expect(result.data.hasMore).toBe(false)
    expect(result.data.totalEntries).toBe(1)
    expect(result.data.totalEntriesExact).toBe(true)
    expect(globalListCalls).toBe(1)
  })

  test("applies beforeMessageId before limit across parent and child transcript entries", async () => {
    const pagedClient = createPagedMessageClient({
      "root-session": [
        {
          info: { id: "msg-1", role: "assistant", time: { created: 1 } },
          parts: [{ id: "part-1", type: "text", text: "root-1" }],
        },
        {
          info: { id: "msg-3", role: "assistant", time: { created: 3 } },
          parts: [{ id: "part-3", type: "text", text: "root-3" }],
        },
      ],
      "child-session": [
        {
          info: { id: "msg-2", role: "assistant", time: { created: 2 } },
          parts: [{ id: "part-2", type: "text", text: "child-2" }],
        },
        {
          info: { id: "msg-4", role: "assistant", time: { created: 4 } },
          parts: [{ id: "part-4", type: "text", text: "child-4" }],
        },
      ],
    })

    const adapter = new OpenCodeAdapter(
      {
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory: "/tmp/project",
            title: path.id,
            time: { created: 1, updated: 2 },
          }
        },
        async children() {
          return [
            {
              id: "child-session",
              directory: "/tmp/project",
              parentID: "root-session",
              title: "Child Session",
              time: { created: 3, updated: 4 },
            },
          ]
        },
        async messages() {
          throw new Error("public session client should handle the exact full-history fallback too")
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
    if (!result.ok) {
      throw new Error("Expected session read with beforeMessageId to succeed")
    }

    expect(result.data.entries.map((entry) => entry.messageId)).toEqual(["msg-2", "msg-3"])
    expect(result.data.includedChildSessionIds).toEqual(["child-session"])
    expect(result.data.hasMore).toBe(true)
    expect(result.data.nextOffset).toBe(2)
    expect(result.data.totalEntries).toBe(3)
    expect(result.data.totalEntriesExact).toBe(true)
    expect(pagedClient.calls).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "/session/root-session/message",
        query: { directory: "/tmp/project" },
        responseStyle: "data",
      }),
      expect.objectContaining({
        method: "GET",
        url: "/session/child-session/message",
        query: { directory: "/tmp/project" },
        responseStyle: "data",
      }),
    ])
  })

  test("treats beforeMessageId as a hard boundary even when the cursor message is filtered out", async () => {
    const adapter = new OpenCodeAdapter({
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory: "/tmp/project",
            title: path.id,
            time: { created: 1, updated: 2 },
          }
        },
        async messages() {
          return [
            {
              info: { id: "msg-1", role: "assistant", time: { created: 1 } },
              parts: [{ id: "part-1", type: "text", text: "visible before cursor" }],
            },
            {
              info: { id: "msg-2", role: "assistant", time: { created: 2 } },
              parts: [
                {
                  id: "part-2",
                  type: "tool",
                  tool: "read",
                  state: { output: "tool output boundary" },
                },
              ],
            },
            {
              info: { id: "msg-3", role: "assistant", time: { created: 3 } },
              parts: [{ id: "part-3", type: "text", text: "should not leak past cursor" }],
            },
          ]
        },
      },
    })

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "root-session", {
      beforeMessageId: "msg-2",
      withToolOutputs: false,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected filtered cursor session read to succeed")
    }

    expect(result.data.entries.map((entry) => entry.messageId)).toEqual(["msg-1"])
    expect(result.data.totalEntriesExact).toBe(true)
  })

  test("uses cached child directories when withChildren child records omit directory", async () => {
    const state = new MissionControlRuntimeState(20)
    state.recordEvent("session.created", {
      sessionID: "child-session",
      parentID: "root-session",
      directory: "/tmp/child-project",
      title: "Child Session",
      time: { created: 2, updated: 3 },
    })

    const adapter = new OpenCodeAdapter({
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory: "/tmp/root-project",
            title: path.id,
            time: { created: 1, updated: 2 },
          }
        },
        async children() {
          return [
            {
              id: "child-session",
              parentID: "root-session",
              title: "Child Session",
            },
          ]
        },
        async messages({ path, query }: { path: { id: string }; query?: { directory?: string } }) {
          if (path.id === "root-session") {
            expect(query?.directory).toBe("/tmp/root-project")
            return [
              {
                info: { id: "root-message", role: "assistant", time: { created: 1 } },
                parts: [{ id: "root-part", type: "text", text: "root" }],
              },
            ]
          }

          expect(path.id).toBe("child-session")
          expect(query?.directory).toBe("/tmp/child-project")
          return [
            {
              info: { id: "child-message", role: "assistant", time: { created: 2 } },
              parts: [{ id: "child-part", type: "text", text: "child" }],
            },
          ]
        },
      },
    })

    const service = new MissionControlSessionService(state)
    const result = await service.readSession(adapter, "root-session", {
      withChildren: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected cached-child-directory read to succeed")
    }

    expect(result.data.entries.map((entry) => entry.messageId)).toEqual(["root-message", "child-message"])
    expect(result.data.totalEntriesExact).toBe(true)
  })

  test("pages transcript entries from the newest messages using offset and limit", async () => {
    const adapter = new OpenCodeAdapter({
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory: "/tmp/project",
            title: path.id,
            time: { created: 1, updated: 2 },
          }
        },
        async messages() {
          return [
            { info: { id: "msg-1", role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: "one" }] },
            { info: { id: "msg-2", role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "two" }] },
            { info: { id: "msg-3", role: "assistant", time: { created: 3 } }, parts: [{ type: "text", text: "three" }] },
            { info: { id: "msg-4", role: "assistant", time: { created: 4 } }, parts: [{ type: "text", text: "four" }] },
          ]
        },
      },
    })

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "root-session", {
      offset: 1,
      limit: 2,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected paged session read to succeed")
    }

    expect(result.data.entries.map((entry) => entry.messageId)).toEqual(["msg-2", "msg-3"])
    expect(result.data.offset).toBe(1)
    expect(result.data.hasMore).toBe(true)
    expect(result.data.nextOffset).toBe(3)
    expect(result.data.totalEntries).toBe(4)
    expect(result.data.totalEntriesExact).toBe(true)
  })

  test("uses the optimized limited-page path across parent and child sessions in chronological order", async () => {
    const adapter = new OpenCodeAdapter({
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory: "/tmp/project",
            title: path.id,
            time: { created: 1, updated: 2 },
          }
        },
        async children() {
          return [
            {
              id: "child-session",
              directory: "/tmp/project",
              parentID: "root-session",
              title: "Child Session",
              time: { created: 3, updated: 4 },
            },
          ]
        },
        async messages({ path }: { path: { id: string } }) {
          if (path.id === "root-session") {
            return [
              {
                info: { id: "msg-1", role: "assistant", time: { created: 1 } },
                parts: [{ id: "part-1", type: "text", text: "root-1" }],
              },
              {
                info: { id: "msg-3", role: "assistant", time: { created: 3 } },
                parts: [{ id: "part-3", type: "text", text: "root-3" }],
              },
            ]
          }

          return [
            {
              info: { id: "msg-2", role: "assistant", time: { created: 2 } },
              parts: [{ id: "part-2", type: "text", text: "child-2" }],
            },
            {
              info: { id: "msg-4", role: "assistant", time: { created: 4 } },
              parts: [{ id: "part-4", type: "text", text: "child-4" }],
            },
          ]
        },
      },
    })

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "root-session", {
      withChildren: true,
      limit: 2,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected optimized cross-session session read to succeed")
    }

    expect(result.data.entries.map((entry) => entry.messageId)).toEqual(["msg-3", "msg-4"])
    expect(result.data.includedChildSessionIds).toEqual(["child-session"])
    expect(result.data.offset).toBe(0)
    expect(result.data.hasMore).toBe(true)
    expect(result.data.nextOffset).toBe(2)
    expect(result.data.totalEntries).toBe(4)
    expect(result.data.totalEntriesExact).toBe(true)
  })

  test("uses public session-message paging for limited parent+child reads and reports a lower-bound total", async () => {
    const pagedClient = createPagedMessageClient({
      "root-session": [
        {
          info: { id: "msg-1", role: "assistant", time: { created: 1 } },
          parts: [{ id: "part-1", type: "text", text: "root-1" }],
        },
        {
          info: { id: "msg-3", role: "assistant", time: { created: 3 } },
          parts: [{ id: "part-3", type: "text", text: "root-3" }],
        },
      ],
      "child-session": [
        {
          info: { id: "msg-2", role: "assistant", time: { created: 2 } },
          parts: [{ id: "part-2", type: "text", text: "child-2" }],
        },
        {
          info: { id: "msg-4", role: "assistant", time: { created: 4 } },
          parts: [{ id: "part-4", type: "text", text: "child-4" }],
        },
      ],
    })

    const adapter = new OpenCodeAdapter(
      {
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory: "/tmp/project",
            title: path.id,
            time: { created: 1, updated: 2 },
          }
        },
        async children() {
          return [
            {
              id: "child-session",
              directory: "/tmp/project",
              parentID: "root-session",
              title: "Child Session",
              time: { created: 3, updated: 4 },
            },
          ]
        },
        async messages() {
          throw new Error("limited public-paged reads should not fall back to session.messages")
        },
      },
      },
      { sdkClient: pagedClient },
    )

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "root-session", {
      withChildren: true,
      limit: 2,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected public-paged cross-session session read to succeed")
    }

    expect(result.data.entries.map((entry) => entry.messageId)).toEqual(["msg-3", "msg-4"])
    expect(result.data.includedChildSessionIds).toEqual(["child-session"])
    expect(result.data.offset).toBe(0)
    expect(result.data.hasMore).toBe(true)
    expect(result.data.nextOffset).toBe(2)
    expect(result.data.totalEntries).toBe(3)
    expect(result.data.totalEntriesExact).toBe(false)
    expect(pagedClient.calls).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "/session/root-session/message",
        query: { directory: "/tmp/project", limit: 25 },
        responseStyle: "fields",
      }),
      expect.objectContaining({
        method: "GET",
        url: "/session/child-session/message",
        query: { directory: "/tmp/project", limit: 25 },
        responseStyle: "fields",
      }),
    ])
  })

  test("follows Link-header before cursors when a limited public read needs older pages", async () => {
    const pagedClient = createPagedMessageClient(
      {
        "root-session": Array.from({ length: 250 }, (_, index) => ({
          info: { id: `msg-${index + 1}`, role: "assistant", time: { created: index + 1 } },
          parts: [{ id: `part-${index + 1}`, type: "text", text: `root-${index + 1}` }],
        })),
      },
      { cursorHeader: "link" },
    )

    const adapter = new OpenCodeAdapter(
      {
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory: "/tmp/project",
            title: path.id,
            time: { created: 1, updated: 2 },
          }
        },
        async messages() {
          throw new Error("large limited public-paged reads should not fall back to session.messages")
        },
      },
      },
      { sdkClient: pagedClient },
    )

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "root-session", {
      offset: 205,
      limit: 2,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected Link-header public paging read to succeed")
    }

    expect(result.data.entries.map((entry) => entry.messageId)).toEqual(["msg-44", "msg-45"])
    expect(result.data.hasMore).toBe(true)
    expect(result.data.nextOffset).toBe(207)
    expect(result.data.totalEntries).toBe(208)
    expect(result.data.totalEntriesExact).toBe(false)
    expect(pagedClient.calls[0]).toEqual(
      expect.objectContaining({
        method: "GET",
        url: "/session/root-session/message",
        query: { directory: "/tmp/project", limit: 200 },
        responseStyle: "fields",
      }),
    )
    expect(pagedClient.calls[1]).toEqual(
      expect.objectContaining({
        method: "GET",
        url: "/session/root-session/message",
        query: { directory: "/tmp/project", limit: 200, before: "root-session:50" },
        responseStyle: "fields",
      }),
    )
  })

  test("uses public session-message paging for limited tails and keeps newest-relative ordering", async () => {
    const pagedClient = createPagedMessageClient({
      "root-session": [
        {
          info: { id: "msg-1", role: "assistant", time: { created: 1 } },
          parts: [{ id: "part-1", type: "text", text: "root-1" }],
        },
        {
          info: { id: "msg-3", role: "assistant", time: { created: 3 } },
          parts: [{ id: "part-3", type: "text", text: "root-3" }],
        },
      ],
      "child-session": [
        {
          info: { id: "msg-2", role: "assistant", time: { created: 2 } },
          parts: [{ id: "part-2", type: "text", text: "child-2" }],
        },
        {
          info: { id: "msg-4", role: "assistant", time: { created: 4 } },
          parts: [{ id: "part-4", type: "text", text: "child-4" }],
        },
      ],
    })

    const adapter = new OpenCodeAdapter(
      {
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory: "/tmp/project",
            title: path.id,
            time: { created: 1, updated: 2 },
          }
        },
        async children() {
          return [
            {
              id: "child-session",
              directory: "/tmp/project",
              parentID: "root-session",
              title: "Child Session",
              time: { created: 3, updated: 4 },
            },
          ]
        },
        async messages() {
          throw new Error("limited public-paged tails should not fall back to session.messages")
        },
      },
      },
      { sdkClient: pagedClient },
    )

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.tailSession(adapter, "root-session", {
      withChildren: true,
      offset: 1,
      limit: 1,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected public-paged session tail to succeed")
    }

    expect(result.data.entries).toEqual([
      expect.objectContaining({
        messageId: "msg-3",
        text: "root-3",
      }),
    ])
    expect(result.data.includedChildSessionIds).toEqual(["child-session"])
    expect(result.data.offset).toBe(1)
    expect(result.data.hasMore).toBe(true)
    expect(result.data.nextOffset).toBe(2)
    expect(result.data.totalEntries).toBe(3)
    expect(result.data.totalEntriesExact).toBe(false)
  })

  test("returns a text-only tail view without step markers or tool outputs", async () => {
    const adapter = new OpenCodeAdapter({
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory: "/tmp/project",
            title: path.id,
            time: { created: 1, updated: 2 },
          }
        },
        async messages() {
          return [
            {
              info: { id: "msg-1", role: "assistant", time: { created: 1 } },
              parts: [
                { id: "part-step", type: "step-start", text: "hash" },
                { id: "part-reasoning", type: "reasoning", text: "internal chain" },
                { id: "part-text", type: "text", text: "human text" },
                { id: "part-tool", type: "tool", text: "tool output" },
              ],
            },
            {
              info: { id: "msg-2", role: "assistant", time: { created: 2 } },
              parts: [{ id: "part-tool-only", type: "tool", text: "tool only" }],
            },
          ]
        },
      },
    })

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.tailSession(adapter, "root-session", { limit: 10 })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected session tail to succeed")
    }

    expect(result.data.entries).toEqual([
      expect.objectContaining({
        messageId: "msg-1",
        text: "human text",
      }),
    ])
    expect(result.data.totalEntries).toBe(1)
    expect(result.data.totalEntriesExact).toBe(true)
  })
})
