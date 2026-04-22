import { describe, expect, test } from "bun:test"

import { OpenCodeAdapter } from "../src/opencode-client.ts"

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
})
