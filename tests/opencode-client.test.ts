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

describe("OpenCodeAdapter session APIs", () => {

  test("injects synthetic notifications with noReply through raw clients", async () => {
    const calls: unknown[] = []
    const adapter = new OpenCodeAdapter({
      _client: {
        async post(options: unknown) {
          calls.push(options)
          return { data: { ok: true }, response: new Response("{}") }
        },
      },
      session: {},
    })

    expect(await adapter.injectSyntheticText("ses_123", "done")).toEqual({ ok: true })
    expect(calls).toEqual([
      {
        url: "/session/ses_123/message",
        body: { parts: [{ type: "text", text: "done", synthetic: true }], noReply: true },
        throwOnError: true,
      },
    ])
  })

  test("injects synthetic notifications with noReply through public and sdk prompt clients", async () => {
    const publicCalls: unknown[] = []
    const publicAdapter = new OpenCodeAdapter(
      { session: {} },
      {
        sdkClient: {
          session: {
            async prompt(args: unknown) {
              publicCalls.push(args)
              return { ok: true }
            },
          },
        },
      },
    )

    expect(await publicAdapter.injectSyntheticText("ses_public", "done")).toEqual({ ok: true })
    expect(publicCalls[0]).toMatchObject({ sessionID: "ses_public", noReply: true })

    const sdkCalls: unknown[] = []
    const sdkAdapter = new OpenCodeAdapter({
      session: {
        async prompt(args: unknown) {
          sdkCalls.push(args)
          return { ok: true }
        },
      },
    })

    expect(await sdkAdapter.injectSyntheticText("ses_sdk", "done")).toEqual({ ok: true })
    expect(sdkCalls[0]).toMatchObject({ path: { id: "ses_sdk" }, noReply: true })
  })


  test("sends async session messages through the raw prompt_async path without noReply", async () => {
    const calls: unknown[] = []
    const adapter = new OpenCodeAdapter(
      {
        _client: {
          async post(options: unknown) {
            calls.push(options)
            return { data: { ok: true }, response: new Response("{}") }
          },
        },
        session: {},
      },
      {
        workspaceID: "workspace-1",
      },
    )

    expect(
      await adapter.sendSessionMessageAsync("ses_123", "hello", { directory: "/tmp/project" }),
    ).toEqual({ ok: true })
    expect(calls).toEqual([
      {
        url: "/session/ses_123/prompt_async",
        query: { directory: "/tmp/project", workspace: "workspace-1" },
        body: { parts: [{ type: "text", text: "hello" }] },
        throwOnError: true,
      },
    ])
  })

  test("falls back to publicClient.session.promptAsync for async session delivery", async () => {
    const publicCalls: unknown[] = []
    const adapter = new OpenCodeAdapter(
      { session: {} },
      {
        sdkClient: {
          session: {
            async promptAsync(args: unknown, options?: unknown) {
              publicCalls.push({ args, options })
              return { ok: true }
            },
          },
        },
      },
    )

    expect(await adapter.sendSessionMessageAsync("ses_public", "hello")).toEqual({ ok: true })
    expect(publicCalls[0]).toMatchObject({
      args: { sessionID: "ses_public", parts: [{ type: "text", text: "hello" }] },
      options: { responseStyle: "data", throwOnError: true },
    })
    expect((publicCalls[0] as any).args).not.toHaveProperty("noReply")
  })

  test("falls through from a throwing raw client to publicClient.session.promptAsync", async () => {
    const rawCalls: unknown[] = []
    const publicCalls: unknown[] = []
    const adapter = new OpenCodeAdapter(
      {
        _client: {
          async post(options: unknown) {
            rawCalls.push(options)
            throw new Error("raw prompt_async unavailable")
          },
        },
        session: {},
      },
      {
        sdkClient: {
          session: {
            async promptAsync(args: unknown, options?: unknown) {
              publicCalls.push({ args, options })
              return { ok: true }
            },
          },
        },
      },
    )

    expect(await adapter.sendSessionMessageAsync("ses_fallback", "hello")).toEqual({ ok: true })
    expect(rawCalls).toHaveLength(1)
    expect(publicCalls).toHaveLength(1)
    expect(publicCalls[0]).toMatchObject({
      args: { sessionID: "ses_fallback", parts: [{ type: "text", text: "hello" }] },
      options: { responseStyle: "data", throwOnError: true },
    })
  })

  test("passes directory and workspace scope through the chosen async delivery path", async () => {
    const rawCalls: unknown[] = []
    const publicCalls: unknown[] = []
    const adapter = new OpenCodeAdapter(
      {
        _client: {
          async post(options: unknown) {
            rawCalls.push(options)
            throw new Error("raw prompt_async unavailable")
          },
        },
        session: {},
      },
      {
        workspaceID: "workspace-default",
        sdkClient: {
          session: {
            async promptAsync(args: unknown, options?: unknown) {
              publicCalls.push({ args, options })
              return { ok: true }
            },
          },
        },
      },
    )

    expect(
      await adapter.sendSessionMessageAsync("ses_scope", "hello", {
        directory: "/tmp/project",
        workspaceID: "workspace-override",
      }),
    ).toEqual({ ok: true })

    // Raw attempt carries the scope query before it throws.
    expect(rawCalls[0]).toMatchObject({
      url: "/session/ses_scope/prompt_async",
      query: { directory: "/tmp/project", workspace: "workspace-override" },
    })
    // Chosen public path carries the scope on its params.
    expect(publicCalls[0]).toMatchObject({
      args: { sessionID: "ses_scope", directory: "/tmp/project", workspace: "workspace-override" },
    })
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
        args: { directory: "" },
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
        options: { method: "GET", url: "/experimental/session", query: { directory: "" }, throwOnError: true },
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
          // V2 path: /api/session/{id}/message returns {items, cursor}
          if (options.url === "/api/session/raw-session/message") {
            return {
              data: {
                items: [{ id: "msg-1", type: "user", time: { created: 1 }, text: "hello" }],
                cursor: {},
              },
            }
          }
          throw new Error(`Unexpected raw url ${options.url}`)
        },
      },
      session: {},
    })

    expect(await adapter.getSession("raw-session", "/tmp/project")).toEqual({ id: "raw-session" })
    expect(await adapter.getSessionChildren("raw-session", "/tmp/project")).toEqual([{ id: "child-session" }])

    // getSessionMessages now uses V2 and projects: raw V2 item → {info, parts}
    const messages = await adapter.getSessionMessages("raw-session", "/tmp/project")
    expect(messages).toHaveLength(1)
    expect(messages[0]?.info?.id).toBe("msg-1")
    expect(messages[0]?.info?.role).toBe("user")
    expect(messages[0]?.parts[0]?.type).toBe("text")
    expect(messages[0]?.parts[0]?.text).toBe("hello")

    expect(calls[0]).toEqual({ method: "get", options: { url: "/session/raw-session", query: { directory: "/tmp/project" }, throwOnError: true } })
    expect(calls[1]).toEqual({ method: "get", options: { url: "/session/raw-session/children", query: { directory: "/tmp/project" }, throwOnError: true } })
    // V2 message fetch: first page uses order:asc (full read); subsequent only if cursor exists
    expect(calls[2]).toMatchObject({
      method: "get",
      options: {
        url: "/api/session/raw-session/message",
        query: expect.objectContaining({ directory: "/tmp/project", order: "asc", limit: 100 }),
        throwOnError: true,
      },
    })
  })

  test("aborts sessions through the injected raw client with scope query", async () => {
    const calls: Array<{ method: string; options: unknown }> = []
    const adapter = new OpenCodeAdapter(
      {
        _client: {
          async post(options: unknown) {
            calls.push({ method: "post", options })
            return { data: { cancelled: true }, response: new Response("{}") }
          },
        },
        session: {
          async abort() {
            throw new Error("native session.abort should not be used when raw client is available")
          },
        },
      },
      {
        workspaceID: "workspace-1",
      },
    )

    expect(await adapter.abortSession("raw session/id", "/tmp/project")).toEqual({ cancelled: true })
    expect(calls).toEqual([
      {
        method: "post",
        options: {
          url: "/session/raw%20session%2Fid/abort",
          query: { directory: "/tmp/project", workspace: "workspace-1" },
          throwOnError: true,
        },
      },
    ])
  })

  test("uses V2 /api/session endpoint for paging and returns projected messages with cursor", async () => {
    const calls: Array<{ method: string; options: unknown }> = []
    const v2Item = {
      id: "msg-1",
      type: "user",
      time: { created: 1 },
      text: "hello",
    }
    const adapter = new OpenCodeAdapter({
      _client: {
        async get(options: unknown) {
          calls.push({ method: "get", options })
          return {
            data: { items: [v2Item], cursor: { next: "cursor-2" } },
          }
        },
      },
      session: {},
    })

    const result = await adapter.getSessionMessagePage("raw-session", {
      directory: "/tmp/project",
      limit: 1,
      cursor: "cursor-1",
    })

    // cursor-1 is a follow-up page (has cursor) → no order param; items reversed to ascending
    expect(result.nextCursor).toBe("cursor-2")
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.info?.id).toBe("msg-1")
    expect(result.messages[0]?.info?.role).toBe("user")
    expect(calls).toEqual([
      {
        method: "get",
        options: {
          url: "/api/session/raw-session/message",
          query: { directory: "/tmp/project", limit: 1, cursor: "cursor-1" },
          throwOnError: true,
        },
      },
    ])
  })

  test("sends order:desc on the first page request (no cursor) and omits it on follow-ups", async () => {
    const calls: Array<{ method: string; options: unknown }> = []
    const adapter = new OpenCodeAdapter({
      _client: {
        async get(options: unknown) {
          calls.push({ method: "get", options })
          return { data: { items: [], cursor: {} } }
        },
      },
      session: {},
    })

    // First page — no cursor
    await adapter.getSessionMessagePage("s1", { limit: 5 })
    expect((calls[0] as any).options.query).toMatchObject({ order: "desc", limit: 5 })
    expect((calls[0] as any).options.query.cursor).toBeUndefined()

    // Follow-up page — has cursor, no order
    await adapter.getSessionMessagePage("s1", { limit: 5, cursor: "tok-1" })
    expect((calls[1] as any).options.query.order).toBeUndefined()
    expect((calls[1] as any).options.query.cursor).toBe("tok-1")
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

  test("constructs a real v2 sdk client from serverUrl and uses V2 /api/session endpoint", async () => {
    const requests: Array<{ method: string; pathname: string; search: string }> = []
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      requests.push({
        method: req.method ?? "GET",
        pathname: url.pathname,
        search: url.search,
      })

      if (url.pathname === "/api/session/live-session/message") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            items: [
              {
                id: "msg-1",
                type: "assistant",
                time: { created: 1 },
                content: [{ type: "text", text: "live message" }],
              },
            ],
            cursor: { next: "cursor-2" },
          }),
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

      const result = await adapter.getSessionMessagePage("live-session", { limit: 2 })

      // Items returned desc by server, reversed to asc by adapter
      expect(result.nextCursor).toBe("cursor-2")
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0]?.info?.id).toBe("msg-1")
      expect(result.messages[0]?.info?.role).toBe("assistant")
      expect(result.messages[0]?.parts[0]?.text).toBe("live message")

      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        method: "GET",
        pathname: "/api/session/live-session/message",
      })
      expect(requests[0]?.search).toContain("limit=2")
      expect(requests[0]?.search).toContain("directory=%2Ftmp%2Fproject")
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
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

})
