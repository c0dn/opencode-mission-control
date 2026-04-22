import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { createMissionControlConfig } from "../src/config.ts"
import { MissionControlJobController } from "../src/jobs.ts"
import { MissionControlJobLauncher } from "../src/launcher.ts"
import { OpenCodeAdapter } from "../src/opencode-client.ts"
import { cleanupTempDirs, getJobsStorePath, parentSessionHandlers, tempDirs } from "./job-test-helpers.ts"

afterEach(cleanupTempDirs)

describe("MissionControl background jobs blocked input - question", () => {
  test("captures pending question requests, persists them, and notifies the parent session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const parentMessages: string[] = []
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-question", directory }
        },
        async promptAsync(input: { body?: { noReply?: boolean; parts?: Array<{ text?: string }> } }) {
          if (input.body?.noReply) {
            parentMessages.push(input.body.parts?.[0]?.text ?? "")
          }

          return undefined
        },
        async messages() {
          return []
        },
        async abort() {
          return true
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Question blocked",
      prompt: "Ask before reviewing the last files.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "question.asked", {
      sessionID: "child-question",
      id: "question-1",
      questions: [
        {
          header: "Scope",
          question: "Which files should I review first?",
          options: [
            {
              label: "src/",
              description: "Review application code first",
            },
          ],
          multiple: false,
          custom: true,
        },
      ],
      tool: {
        messageID: "msg-2",
        callID: "call-2",
      },
    })

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected question-blocked job status to exist")
    }

    expect(status.data.job.state).toBe("waiting_question")
    expect(status.data.job.pendingInput).toMatchObject({
      kind: "question",
      requestId: "question-1",
      questions: [
        {
          header: "Scope",
          question: "Which files should I review first?",
        },
      ],
    })
    expect(parentMessages).toHaveLength(1)
    expect(parentMessages[0]).toContain("mc_job_question_reply")

    const persisted = JSON.parse(await readFile(getJobsStorePath(directory), "utf8")) as {
      jobs: Array<{ pendingInput?: { requestId?: string } }>
    }
    expect(persisted.jobs[0]?.pendingInput?.requestId).toBe("question-1")
  })

  test("replies to pending question requests through the native reply endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const questionReplies: Array<unknown> = []
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-question-reply", directory }
        },
        async promptAsync() {
          return undefined
        },
        async prompt() {
          return true
        },
        async messages() {
          return []
        },
        async abort() {
          return true
        },
      },
      question: {
        async reply(args: unknown) {
          questionReplies.push(args)
          return true
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Question reply",
      prompt: "Wait for the parent answer before continuing.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "question.asked", {
      sessionID: "child-question-reply",
      id: "question-2",
      questions: [
        {
          header: "Scope",
          question: "Which files should I review first?",
          options: [
            {
              label: "src/",
              description: "Review application code first",
            },
          ],
        },
      ],
    })

    const replyResult = await controller.replyQuestion(
      adapter,
      {
        jobId: launchResult.data.jobId,
        answers: [["src/"]],
      },
      { sessionId: "parent-session" },
    )

    expect(replyResult.ok).toBe(true)
    if (!replyResult.ok) {
      throw new Error("Expected question reply to succeed")
    }

    expect(questionReplies).toEqual([
      {
        requestID: "question-2",
        answers: [["src/"]],
        directory,
      },
    ])

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected question-replied job status to exist")
    }

    expect(status.data.job.state).toBe("running")
    expect(status.data.job.pendingInput).toBeUndefined()
  })

  test("rejects pending questions and finalizes the job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const questionRejects: Array<unknown> = []
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-question-reject", directory }
        },
        async promptAsync() {
          return undefined
        },
        async prompt() {
          return true
        },
        async messages() {
          return []
        },
        async abort() {
          return true
        },
      },
      question: {
        async reject(args: unknown) {
          questionRejects.push(args)
          return true
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Question reject",
      prompt: "Fail if the parent rejects the question.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "question.asked", {
      sessionID: "child-question-reject",
      id: "question-3",
      questions: [
        {
          header: "Scope",
          question: "Which files should I review first?",
          options: [],
        },
      ],
    })

    const rejectResult = await controller.rejectQuestion(adapter, launchResult.data.jobId, { sessionId: "parent-session" })
    expect(rejectResult.ok).toBe(true)
    if (!rejectResult.ok) {
      throw new Error("Expected question rejection to succeed")
    }

    expect(questionRejects).toEqual([
      {
        requestID: "question-3",
        directory,
      },
    ])

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected rejected-question job status to exist")
    }

    expect(status.data.job.state).toBe("failed")
    expect(status.data.job.pendingInput).toBeUndefined()
    expect(status.data.result?.summary).toContain("Question rejected")
  })

  test("ignores stale question replies that do not match the current pending request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-stale-question", directory }
        },
        async promptAsync() {
          return undefined
        },
        async prompt() {
          return true
        },
        async messages() {
          return []
        },
        async abort() {
          return true
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Stale question reply",
      prompt: "Keep the newest pending question active.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "question.asked", {
      sessionID: "child-stale-question",
      id: "question-a",
      questions: [{ header: "First", question: "First question?", options: [] }],
    })

    await controller.handleEvent(adapter, "question.replied", {
      sessionID: "child-stale-question",
      requestID: "question-b",
    })

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected stale-question job status to exist")
    }

    expect(status.data.job.state).toBe("waiting_question")
    expect(status.data.job.pendingInput).toMatchObject({
      kind: "question",
      requestId: "question-a",
    })
  })

  test("does not replace an active pending question with a different replayed ask event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-conflicting-ask", directory }
        },
        async promptAsync() {
          return undefined
        },
        async prompt() {
          return true
        },
        async messages() {
          return []
        },
        async abort() {
          return true
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Ignore conflicting ask replay",
      prompt: "Keep the currently pending question stable.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "question.asked", {
      sessionID: "child-conflicting-ask",
      id: "question-current",
      questions: [{ header: "Current", question: "Current question?", options: [] }],
    })
    await controller.handleEvent(adapter, "question.asked", {
      sessionID: "child-conflicting-ask",
      id: "question-stale",
      questions: [{ header: "Stale", question: "Stale question?", options: [] }],
    })

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected conflicting-ask job status to exist")
    }

    expect(status.data.job.state).toBe("waiting_question")
    expect(status.data.job.pendingInput).toMatchObject({
      kind: "question",
      requestId: "question-current",
    })

    const events = controller.jobEvents(launchResult.data.jobId, 20)
    expect(events.ok).toBe(true)
    if (!events.ok) {
      throw new Error("Expected conflicting-ask job events to exist")
    }

    expect(events.data.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "job.event_ignored",
          detail: "conflicting question request",
          metadata: expect.objectContaining({
            eventType: "question.asked",
            ignoredRequestId: "question-stale",
          }),
        }),
      ]),
    )
  })
})
