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

  test("falls back to raw client requests for permission and question APIs", async () => {
    const calls: Array<Record<string, unknown>> = []
    const adapter = new OpenCodeAdapter({
      _client: {
        async request(args: Record<string, unknown>) {
          calls.push(args)

          switch (args.url) {
            case "/permission":
              return [{ id: "perm-raw" }]
            case "/question":
              return [{ id: "question-raw" }]
            default:
              return true
          }
        },
      },
      session: {},
    })

    expect(adapter.supportsPermissionReply()).toBe(true)
    expect(adapter.supportsQuestionReply()).toBe(true)
    expect(adapter.supportsQuestionReject()).toBe(true)
    expect(adapter.supportsParentReplies()).toBe(true)

    expect(await adapter.listPendingPermissions("/tmp/project")).toEqual([{ id: "perm-raw" }])
    expect(await adapter.listPendingQuestions("/tmp/project")).toEqual([{ id: "question-raw" }])
    expect(await adapter.replyPermissionRequest("perm-1", "once", "allow it", "/tmp/project")).toBe(true)
    expect(await adapter.replyQuestionRequest("question-1", [["src/"]], "/tmp/project")).toBe(true)
    expect(await adapter.rejectQuestionRequest("question-2", "/tmp/project")).toBe(true)

    expect(calls).toEqual([
      {
        method: "GET",
        url: "/permission",
        query: { directory: "/tmp/project" },
        body: undefined,
        responseStyle: "data",
        throwOnError: true,
        parseAs: "auto",
      },
      {
        method: "GET",
        url: "/question",
        query: { directory: "/tmp/project" },
        body: undefined,
        responseStyle: "data",
        throwOnError: true,
        parseAs: "auto",
      },
      {
        method: "POST",
        url: "/permission/perm-1/reply",
        query: { directory: "/tmp/project" },
        body: {
          reply: "once",
          message: "allow it",
        },
        responseStyle: "data",
        throwOnError: true,
        parseAs: "auto",
      },
      {
        method: "POST",
        url: "/question/question-1/reply",
        query: { directory: "/tmp/project" },
        body: {
          answers: [["src/"]],
        },
        responseStyle: "data",
        throwOnError: true,
        parseAs: "auto",
      },
      {
        method: "POST",
        url: "/question/question-2/reject",
        query: { directory: "/tmp/project" },
        body: undefined,
        responseStyle: "data",
        throwOnError: true,
        parseAs: "auto",
      },
    ])
  })

  test("normalizes raw-client fallback errors into real Error messages", async () => {
    const adapter = new OpenCodeAdapter({
      _client: {
        async request() {
          const error = new Error("route failed") as Error & {
            data?: {
              message?: string
            }
          }
          error.data = {
            message: "missing request",
          }
          throw error
        },
      },
      session: {},
    })

    await expect(adapter.replyQuestionRequest("question-1", [["src/"]], "/tmp/project")).rejects.toThrow(
      "missing request",
    )
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
