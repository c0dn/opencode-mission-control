import { createServer } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { OpenCodeAdapter } from "../src/opencode-client.ts"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop()
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

describe("OpenCodeAdapter pending input APIs", () => {
  test("calls native permission and question reply endpoints with directory scope", async () => {
    const calls: Array<{ method: string; args: unknown }> = []
    const adapter = new OpenCodeAdapter({
      permission: {
        async reply(args: unknown) {
          calls.push({ method: "permission.reply", args })
          return true
        },
      },
      question: {
        async reply(args: unknown) {
          calls.push({ method: "question.reply", args })
          return true
        },
        async reject(args: unknown) {
          calls.push({ method: "question.reject", args })
          return true
        },
      },
      session: {},
    })

    await adapter.replyPermissionRequest("perm-1", "once", "allow it", "/tmp/project")
    await adapter.replyQuestionRequest("question-1", [["src/"]], "/tmp/project")
    await adapter.rejectQuestionRequest("question-2", "/tmp/project")

    expect(calls).toEqual([
      {
        method: "permission.reply",
        args: {
          requestID: "perm-1",
          reply: "once",
          message: "allow it",
          directory: "/tmp/project",
        },
      },
      {
        method: "question.reply",
        args: {
          requestID: "question-1",
          answers: [["src/"]],
          directory: "/tmp/project",
        },
      },
      {
        method: "question.reject",
        args: {
          requestID: "question-2",
          directory: "/tmp/project",
        },
      },
    ])
  })

  test("lists pending permission and question requests via native SDK endpoints", async () => {
    const calls: Array<{ method: string; args: unknown }> = []
    const adapter = new OpenCodeAdapter({
      permission: {
        async list(args: unknown) {
          calls.push({ method: "permission.list", args })
          return [{ id: "perm-1" }]
        },
      },
      question: {
        async list(args: unknown) {
          calls.push({ method: "question.list", args })
          return [{ id: "question-1" }]
        },
      },
      session: {},
    })

    expect(await adapter.listPendingPermissions("/tmp/project")).toEqual([{ id: "perm-1" }])
    expect(await adapter.listPendingQuestions("/tmp/project")).toEqual([{ id: "question-1" }])
    expect(calls).toEqual([
      { method: "permission.list", args: { directory: "/tmp/project" } },
      { method: "question.list", args: { directory: "/tmp/project" } },
    ])
  })

  test("uses the official sdk client for permission and question APIs", async () => {
    const calls: Array<{ method: string; args: unknown; options?: unknown }> = []
    const adapter = new OpenCodeAdapter(
      { session: {} },
      {
        sdkClient: {
          permission: {
            async list(args: unknown, options?: unknown) {
              calls.push({ method: "permission.list", args, options })
              return [{ id: "perm-sdk" }]
            },
            async reply(args: unknown, options?: unknown) {
              calls.push({ method: "permission.reply", args, options })
              return true
            },
          },
          question: {
            async list(args: unknown, options?: unknown) {
              calls.push({ method: "question.list", args, options })
              return [{ id: "question-sdk" }]
            },
            async reply(args: unknown, options?: unknown) {
              calls.push({ method: "question.reply", args, options })
              return true
            },
            async reject(args: unknown, options?: unknown) {
              calls.push({ method: "question.reject", args, options })
              return true
            },
          },
          session: {
            async messages() {
              return []
            },
          },
        },
      },
    )

    expect(adapter.supportsPermissionReply()).toBe(true)
    expect(adapter.supportsQuestionReply()).toBe(true)
    expect(adapter.supportsQuestionReject()).toBe(true)
    expect(adapter.supportsParentReplies()).toBe(true)
    expect(adapter.supportsSessionMessagePaging()).toBe(true)

    expect(await adapter.listPendingPermissions("/tmp/project")).toEqual([{ id: "perm-sdk" }])
    expect(await adapter.listPendingQuestions("/tmp/project")).toEqual([{ id: "question-sdk" }])
    expect(await adapter.replyPermissionRequest("perm-1", "once", "allow it", "/tmp/project")).toBe(true)
    expect(await adapter.replyQuestionRequest("question-1", [["src/"]], "/tmp/project")).toBe(true)
    expect(await adapter.rejectQuestionRequest("question-2", "/tmp/project")).toBe(true)

    expect(calls).toEqual([
      {
        method: "permission.list",
        args: { directory: "/tmp/project" },
        options: { responseStyle: "data", throwOnError: true },
      },
      {
        method: "question.list",
        args: { directory: "/tmp/project" },
        options: { responseStyle: "data", throwOnError: true },
      },
      {
        method: "permission.reply",
        args: {
          requestID: "perm-1",
          reply: "once",
          message: "allow it",
          directory: "/tmp/project",
        },
        options: { responseStyle: "data", throwOnError: true },
      },
      {
        method: "question.reply",
        args: {
          requestID: "question-1",
          answers: [["src/"]],
          directory: "/tmp/project",
        },
        options: { responseStyle: "data", throwOnError: true },
      },
      {
        method: "question.reject",
        args: {
          requestID: "question-2",
          directory: "/tmp/project",
        },
        options: { responseStyle: "data", throwOnError: true },
      },
    ])
  })

  test("uses experimental session listing for unscoped global discovery when an sdk client is available", async () => {
    const calls: Array<{ method: string; args: unknown; options?: unknown }> = []
    const adapter = new OpenCodeAdapter(
      { session: {} },
      {
        sdkClient: {
          experimental: {
            session: {
              async list(args: unknown, options?: unknown) {
                calls.push({ method: "experimental.session.list", args, options })
                return [{ id: "global-session" }]
              },
            },
          },
          session: {
            async list() {
              throw new Error("scoped session.list should not be used for global discovery")
            },
          },
        },
      },
    )

    expect(await adapter.listSessions({ global: true })).toEqual([{ id: "global-session" }])
    expect(calls).toEqual([
      {
        method: "experimental.session.list",
        args: {},
        options: { responseStyle: "data", throwOnError: true },
      },
    ])
  })

  test("lists local sessions through the injected raw client with directory scope", async () => {
    const calls: Array<{ method: string; options: unknown }> = []
    const adapter = new OpenCodeAdapter({
      _client: {
        async get(options: unknown) {
          calls.push({ method: "get", options })
          return { data: [{ id: "raw-local" }], response: new Response("[]") }
        },
      },
      session: {
        async list() {
          throw new Error("native session.list should not be used when raw client is available")
        },
      },
    })

    expect(await adapter.listSessions({ directory: "/tmp/project" })).toEqual([{ id: "raw-local" }])
    expect(calls).toEqual([
      {
        method: "get",
        options: { url: "/session", query: { directory: "/tmp/project" }, throwOnError: true },
      },
    ])
  })

  test("lists global sessions through the injected raw experimental endpoint", async () => {
    const calls: Array<{ method: string; options: unknown }> = []
    const adapter = new OpenCodeAdapter(
      {
        _client: {
          async request(options: unknown) {
            calls.push({ method: "request", options })
            return { data: [{ id: "raw-global" }], response: new Response("[]") }
          },
        },
        session: {},
      },
      {
        sdkClient: {
          experimental: {
            session: {
              async list() {
                throw new Error("public experimental.session.list should not be used when raw client is available")
              },
            },
          },
          session: {},
        },
      },
    )

    expect(await adapter.listSessions({ global: true, directory: "/tmp/project" })).toEqual([{ id: "raw-global" }])
    expect(calls).toEqual([
      {
        method: "request",
        options: { method: "GET", url: "/experimental/session", throwOnError: true },
      },
    ])
  })

  test("reads session details, children, and messages through the injected raw client", async () => {
    const calls: Array<{ method: string; options: { url?: string; query?: unknown } }> = []
    const adapter = new OpenCodeAdapter({
      _client: {
        async get(options: { url?: string; query?: unknown }) {
          calls.push({ method: "get", options })
          if (options.url === "/session/raw-session") {
            return { data: { id: "raw-session" }, response: new Response("{}") }
          }
          if (options.url === "/session/raw-session/children") {
            return { data: [{ id: "child-session" }], response: new Response("[]") }
          }
          if (options.url === "/session/raw-session/message") {
            return { data: [{ info: { id: "msg-1" }, parts: [] }], response: new Response("[]") }
          }
          throw new Error(`Unexpected raw url ${options.url}`)
        },
      },
      session: {},
    })

    expect(await adapter.getSession("raw-session", "/tmp/project")).toEqual({ id: "raw-session" })
    expect(await adapter.getSessionChildren("raw-session", "/tmp/project")).toEqual([{ id: "child-session" }])
    expect(await adapter.getSessionMessages("raw-session", "/tmp/project")).toEqual([{ info: { id: "msg-1" }, parts: [] }])
    expect(calls).toEqual([
      { method: "get", options: { url: "/session/raw-session", query: { directory: "/tmp/project" }, throwOnError: true } },
      {
        method: "get",
        options: { url: "/session/raw-session/children", query: { directory: "/tmp/project" }, throwOnError: true },
      },
      {
        method: "get",
        options: { url: "/session/raw-session/message", query: { directory: "/tmp/project" }, throwOnError: true },
      },
    ])
  })

  test("preserves raw session message paging cursor from response headers", async () => {
    const calls: Array<{ method: string; options: unknown }> = []
    const adapter = new OpenCodeAdapter({
      _client: {
        async get(options: unknown) {
          calls.push({ method: "get", options })
          return {
            data: [{ info: { id: "msg-1" }, parts: [] }],
            response: new Response("[]", { headers: { "x-next-cursor": "cursor-2" } }),
          }
        },
      },
      session: {},
    })

    expect(
      await adapter.getSessionMessagePage("raw-session", {
        directory: "/tmp/project",
        limit: 1,
        before: "cursor-1",
      }),
    ).toEqual({
      messages: [{ info: { id: "msg-1" }, parts: [] }],
      nextCursor: "cursor-2",
    })
    expect(calls).toEqual([
      {
        method: "get",
        options: {
          url: "/session/raw-session/message",
          query: { directory: "/tmp/project", limit: 1, before: "cursor-1" },
          responseStyle: "fields",
          throwOnError: true,
        },
      },
    ])
  })

  test("prefers raw session listing over a stale serverUrl and public sdk client", async () => {
    const calls: Array<{ method: string; options: unknown }> = []
    const adapter = new OpenCodeAdapter(
      {
        _client: {
          getConfig: () => ({ baseUrl: "http://127.0.0.1:1" }),
          async get(options: unknown) {
            calls.push({ method: "get", options })
            return { data: [{ id: "raw-preferred" }], response: new Response("[]") }
          },
        },
        session: {},
      },
      {
        serverUrl: new URL("http://127.0.0.1:1"),
        sdkClient: {
          session: {
            async list() {
              throw new Error("public session.list should not be used when raw client is available")
            },
          },
        },
      },
    )

    expect(await adapter.listSessions({ directory: "/tmp/project" })).toEqual([{ id: "raw-preferred" }])
    expect(calls).toEqual([
      {
        method: "get",
        options: { url: "/session", query: { directory: "/tmp/project" }, throwOnError: true },
      },
    ])
  })

  test("constructs a real v2 sdk client from serverUrl and uses public HTTP endpoints", async () => {
    const requests: Array<{ method: string; pathname: string; search: string }> = []
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      requests.push({
        method: req.method ?? "GET",
        pathname: url.pathname,
        search: url.search,
      })

      if (url.pathname === "/permission") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify([{ id: "perm-live" }]))
        return
      }

      if (url.pathname === "/session/live-session/message") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-next-cursor": "cursor-2",
        })
        res.end(
          JSON.stringify([
            {
              info: { id: "msg-1", role: "assistant", time: { created: 1 } },
              parts: [{ id: "part-1", type: "text", text: "live message" }],
            },
          ]),
        )
        return
      }

      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ message: `Unexpected path: ${url.pathname}` }))
    })

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })

    try {
      const address = server.address()
      if (!address || typeof address === "string") {
        throw new Error("Expected an ephemeral TCP server address")
      }

      const adapter = new OpenCodeAdapter(
        { session: {} },
        {
          serverUrl: new URL(`http://127.0.0.1:${address.port}`),
          directory: "/tmp/project",
        },
      )

      expect(await adapter.listPendingPermissions()).toEqual([{ id: "perm-live" }])

      expect(
        await adapter.getSessionMessagePage("live-session", {
          limit: 2,
        }),
      ).toEqual({
        messages: [
          {
            info: { id: "msg-1", role: "assistant", time: { created: 1 } },
            parts: [{ id: "part-1", type: "text", text: "live message" }],
          },
        ],
        nextCursor: "cursor-2",
      })

      expect(requests).toHaveLength(2)
      expect(requests[0]).toEqual({
        method: "GET",
        pathname: "/permission",
        search: "?directory=%2Ftmp%2Fproject",
      })
      expect(requests[1]).toMatchObject({
        method: "GET",
        pathname: "/session/live-session/message",
      })
      expect(requests[1]?.search).toContain("limit=2")
      expect(requests[1]?.search).toContain("directory=%2Ftmp%2Fproject")
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  test("recovers serverUrl from the hidden internal client baseUrl config", async () => {
    const requests: Array<{ method: string; pathname: string; search: string }> = []
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      requests.push({
        method: req.method ?? "GET",
        pathname: url.pathname,
        search: url.search,
      })

      if (url.pathname === "/permission") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify([{ id: "perm-hidden" }]))
        return
      }

      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ message: `Unexpected path: ${url.pathname}` }))
    })

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })

    try {
      const address = server.address()
      if (!address || typeof address === "string") {
        throw new Error("Expected an ephemeral TCP server address")
      }

      const adapter = new OpenCodeAdapter(
        {
          _client: {
            getConfig: () => ({
              baseUrl: `http://127.0.0.1:${address.port}`,
            }),
          },
          session: {},
        },
        {
          directory: "/tmp/project",
        },
      )

      expect(await adapter.listPendingPermissions()).toEqual([{ id: "perm-hidden" }])
      expect(requests).toEqual([
        {
          method: "GET",
          pathname: "/permission",
          search: "?directory=%2Ftmp%2Fproject",
        },
      ])
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  test("prefers hidden internal client baseUrl over a stale context serverUrl", async () => {
    const requests: Array<{ method: string; pathname: string; search: string }> = []
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      requests.push({
        method: req.method ?? "GET",
        pathname: url.pathname,
        search: url.search,
      })

      if (url.pathname === "/permission") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify([{ id: "perm-preferred" }]))
        return
      }

      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ message: `Unexpected path: ${url.pathname}` }))
    })

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })

    try {
      const address = server.address()
      if (!address || typeof address === "string") {
        throw new Error("Expected an ephemeral TCP server address")
      }

      const adapter = new OpenCodeAdapter(
        {
          _client: {
            getConfig: () => ({
              baseUrl: `http://127.0.0.1:${address.port}`,
            }),
          },
          session: {},
        },
        {
          serverUrl: new URL("http://127.0.0.1:1"),
          directory: "/tmp/project",
        },
      )

      expect(await adapter.listPendingPermissions()).toEqual([{ id: "perm-preferred" }])
      expect(requests).toEqual([
        {
          method: "GET",
          pathname: "/permission",
          search: "?directory=%2Ftmp%2Fproject",
        },
      ])
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  test("prefers session.prompt for fire-and-forget parent relays when it succeeds", async () => {
    const calls: Array<{ method: string; args: unknown }> = []
    const adapter = new OpenCodeAdapter({
      session: {
        async promptAsync(args: unknown) {
          calls.push({ method: "session.promptAsync", args })
          return true
        },
        async prompt(args: unknown) {
          calls.push({ method: "session.prompt", args })
          return true
        },
      },
    })

    await adapter.promptNoReply("parent-session", "relay payload", "/tmp/project")

    expect(calls).toEqual([
      {
        method: "session.prompt",
        args: {
          query: { directory: "/tmp/project" },
          path: { id: "parent-session" },
          body: {
            noReply: true,
            parts: [{ type: "text", text: "relay payload" }],
          },
        },
      },
    ])
  })

  test("treats empty no-reply prompt responses as success instead of surfacing JSON EOF parse errors", async () => {
    const calls: Array<{ method: string; args: unknown }> = []
    const adapter = new OpenCodeAdapter({
      session: {
        async prompt(args: unknown) {
          calls.push({ method: "session.prompt", args })
          throw new Error("JSON Parse error: Unexpected EOF")
        },
        async promptAsync(args: unknown) {
          calls.push({ method: "session.promptAsync", args })
          return true
        },
      },
    })

    await adapter.promptNoReply("parent-session", "relay payload", "/tmp/project")

    expect(calls).toEqual([
      {
        method: "session.prompt",
        args: {
          query: { directory: "/tmp/project" },
          path: { id: "parent-session" },
          body: {
            noReply: true,
            parts: [{ type: "text", text: "relay payload" }],
          },
        },
      },
    ])
  })

  test("treats empty no-reply promptAsync responses as success when session.prompt is unavailable", async () => {
    const calls: Array<{ method: string; args: unknown }> = []
    const adapter = new OpenCodeAdapter({
      session: {
        async promptAsync(args: unknown) {
          calls.push({ method: "session.promptAsync", args })
          throw new Error("JSON Parse error: Unexpected end of JSON input")
        },
      },
    })

    await adapter.promptNoReply("parent-session", "relay payload", "/tmp/project")

    expect(calls).toEqual([
      {
        method: "session.promptAsync",
        args: {
          query: { directory: "/tmp/project" },
          path: { id: "parent-session" },
          body: {
            noReply: true,
            parts: [{ type: "text", text: "relay payload" }],
          },
        },
      },
    ])
  })

  test("writes structured debug entries to a dedicated debug file when enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-debug-"))
    tempDirs.push(directory)
    const debugFilePath = join(directory, "debug.jsonl")

    const adapter = new OpenCodeAdapter(
      {
        session: {},
      },
      {
        rootDir: directory,
        debug: {
          enabled: true,
          filePath: debugFilePath,
        },
      },
    )

    await adapter.debug("caller resolution failed", {
      sessionId: "ses_test",
      messageId: "msg_test",
    })

    const content = await readFile(debugFilePath, "utf8")
    const entries = content.trim().split("\n").map((line) => JSON.parse(line)) as Array<Record<string, unknown>>

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      service: "opencode-mission-control",
      level: "debug",
      message: "caller resolution failed",
      extra: {
        sessionId: "ses_test",
        messageId: "msg_test",
      },
    })
  })

  test("recovers the actual caller session from the current message id", async () => {
    const adapter = new OpenCodeAdapter({
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory: "/tmp/project",
            title: path.id,
            time: { created: 1, updated: path.id === "actual-session" ? 20 : 10 },
          }
        },
        async list() {
          return [
            { id: "stale-session", directory: "/tmp/project", time: { created: 1, updated: 10 } },
            { id: "actual-session", directory: "/tmp/project", time: { created: 2, updated: 20 } },
          ]
        },
        async messages({ path }: { path: { id: string } }) {
          return path.id === "actual-session"
            ? [{ info: { id: "message-1" }, parts: [] }]
            : [{ info: { id: "other-message" }, parts: [] }]
        },
      },
    })

    const resolved = await adapter.resolveCallerSession({
      sessionId: "stale-session",
      messageId: "message-1",
      directory: "/tmp/project",
    })

    expect(resolved).toEqual({
      sessionID: "actual-session",
      directory: "/tmp/project",
      mode: "message_owner_session",
    })
  })

  test("fails closed when caller message ownership cannot be proven", async () => {
    const adapter = new OpenCodeAdapter({
      session: {
        async get() {
          throw new Error("not found")
        },
        async list() {
          return [
            { id: "stale-session", directory: "/tmp/project", time: { created: 1, updated: 10 } },
            { id: "other-session", directory: "/tmp/project", time: { created: 2, updated: 20 } },
          ]
        },
        async messages() {
          return [{ info: { id: "different-message" }, parts: [] }]
        },
      },
    })

    const resolved = await adapter.resolveCallerSession({
      sessionId: "stale-session",
      messageId: "message-1",
      directory: "/tmp/project",
    })

    expect(resolved).toBeUndefined()
  })

})
