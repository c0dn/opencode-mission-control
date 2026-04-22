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

describe("MissionControl background jobs blocked input - permission", () => {
  test("captures pending permission requests, persists them, and notifies the parent session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const parentMessages: string[] = []
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-permission", directory }
        },
        async promptAsync() {
          return undefined
        },
        async prompt(input: { body: { parts?: Array<{ text?: string }> } }) {
          parentMessages.push(input.body.parts?.[0]?.text ?? "")
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
      title: "Permission blocked",
      prompt: "Run repo checks when allowed.",
      sessionId: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "permission.asked", {
      sessionID: "child-permission",
      id: "perm-1",
      permission: "bash",
      patterns: ["git push"],
      always: ["git status"],
      metadata: {
        reason: "Need to inspect the current branch",
      },
      tool: {
        messageID: "msg-1",
        callID: "call-1",
      },
    })

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected permission-blocked job status to exist")
    }

    expect(status.data.job.state).toBe("waiting_permission")
    expect(status.data.job.pendingInput).toMatchObject({
      kind: "permission",
      requestId: "perm-1",
      permission: "bash",
      patterns: ["git push"],
    })
    expect(parentMessages).toHaveLength(1)
    expect(parentMessages[0]).toContain("mc_job_permission_reply")

    const persisted = JSON.parse(await readFile(getJobsStorePath(directory), "utf8")) as {
      jobs: Array<{ pendingInput?: { requestId?: string } }>
    }
    expect(persisted.jobs[0]?.pendingInput?.requestId).toBe("perm-1")
  })

  test("falls back to native pending-permission listing when the runtime event payload is sparse", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const parentMessages: string[] = []
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-sparse-permission", directory }
        },
        async promptAsync() {
          return undefined
        },
        async prompt(input: { body: { parts?: Array<{ text?: string }> } }) {
          parentMessages.push(input.body.parts?.[0]?.text ?? "")
          return true
        },
        async messages() {
          return []
        },
        async abort() {
          return true
        },
      },
      permission: {
        async list() {
          return [
            {
              id: "perm-fallback",
              sessionID: "child-sparse-permission",
              permission: "bash",
              patterns: ["git push"],
              always: [],
              metadata: {},
            },
          ]
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Sparse permission",
      prompt: "Recover pending permission from the native list API.",
      sessionId: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "permission.asked", {
      sessionID: "child-sparse-permission",
    })

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected sparse-permission job status to exist")
    }

    expect(status.data.job.pendingInput).toMatchObject({
      kind: "permission",
      requestId: "perm-fallback",
      permission: "bash",
    })
    expect(parentMessages).toHaveLength(1)
  })

  test("notifies the parent when blocked permission state is discovered through session.status fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const parentMessages: string[] = []
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-status-permission", directory }
        },
        async promptAsync() {
          return undefined
        },
        async prompt(input: { body: { parts?: Array<{ text?: string }> } }) {
          parentMessages.push(input.body.parts?.[0]?.text ?? "")
          return true
        },
        async messages() {
          return []
        },
        async abort() {
          return true
        },
      },
      permission: {
        async list() {
          return [
            {
              id: "perm-status-fallback",
              sessionID: "child-status-permission",
              permission: "edit",
              patterns: ["README.md"],
              always: [],
              metadata: {},
            },
          ]
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Status fallback permission",
      prompt: "Recover blocked permission from session.status only.",
      sessionId: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.status", {
      sessionID: "child-status-permission",
      status: { type: "waiting_permission" },
    })

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected status-fallback permission job status to exist")
    }

    expect(status.data.job.state).toBe("waiting_permission")
    expect(status.data.job.pendingInput).toMatchObject({
      kind: "permission",
      requestId: "perm-status-fallback",
      permission: "edit",
    })
    expect(parentMessages).toHaveLength(1)
  })

  test("marks the job blocked and sends a generic notification when session.status reports waiting without request details", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const parentMessages: string[] = []
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-status-sparse", directory }
        },
        async promptAsync() {
          return undefined
        },
        async prompt(input: { body: { parts?: Array<{ text?: string }> } }) {
          parentMessages.push(input.body.parts?.[0]?.text ?? "")
          return true
        },
        async messages() {
          return []
        },
        async abort() {
          return true
        },
      },
      permission: {
        async list() {
          return []
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Status sparse blocked",
      prompt: "Show blocked state even when request details are unavailable.",
      sessionId: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.status", {
      sessionID: "child-status-sparse",
      status: { type: "waiting_permission" },
    })

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected status-sparse job status to exist")
    }

    expect(status.data.job.state).toBe("waiting_permission")
    expect(status.data.job.pendingInput).toBeUndefined()
    expect(parentMessages).toHaveLength(1)
    expect(parentMessages[0]).toContain("blocked")
  })

  test("replies to pending permission requests through the native reply endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const permissionReplies: Array<unknown> = []
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-permission-reply", directory }
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
      permission: {
        async reply(args: unknown) {
          permissionReplies.push(args)
          return true
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Permission reply",
      prompt: "Wait for permission before continuing.",
      sessionId: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "permission.asked", {
      sessionID: "child-permission-reply",
      id: "perm-2",
      permission: "bash",
      patterns: ["git push"],
      always: [],
      metadata: {},
    })

    const replyResult = await controller.replyPermission(
      adapter,
      {
        jobId: launchResult.data.jobId,
        reply: "once",
        message: "Proceed",
      },
      { sessionId: "parent-session" },
    )

    expect(replyResult.ok).toBe(true)
    if (!replyResult.ok) {
      throw new Error("Expected permission reply to succeed")
    }

    expect(permissionReplies).toEqual([
      {
        requestID: "perm-2",
        reply: "once",
        message: "Proceed",
        directory,
      },
    ])

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected permission-replied job status to exist")
    }

    expect(status.data.job.state).toBe("running")
    expect(status.data.job.pendingInput).toBeUndefined()
  })

  test("does not reopen a replied permission request when session.status fallback still returns the just-answered request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-no-reopen-listed", directory }
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
      permission: {
        async list() {
          return [
            {
              id: "perm-no-reopen-listed",
              sessionID: "child-no-reopen-listed",
              permission: "bash",
              patterns: ["git push"],
              always: [],
              metadata: {},
            },
          ]
        },
        async reply() {
          return true
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "No reopen from listed request",
      prompt: "Ignore the just-answered listed request.",
      sessionId: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "permission.asked", {
      sessionID: "child-no-reopen-listed",
      id: "perm-no-reopen-listed",
      permission: "bash",
      patterns: ["git push"],
      always: [],
      metadata: {},
    })
    await controller.replyPermission(
      adapter,
      {
        jobId: launchResult.data.jobId,
        reply: "once",
      },
      { sessionId: "parent-session" },
    )

    await controller.handleEvent(adapter, "session.status", {
      sessionID: "child-no-reopen-listed",
      status: { type: "waiting_permission" },
    })

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected no-reopen-listed job status to exist")
    }

    expect(status.data.job.state).toBe("running")
    expect(status.data.job.pendingInput).toBeUndefined()
  })

  test("rejects blocked-input replies from sessions other than the parent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let replyCalls = 0
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-parent-scope", directory }
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
      permission: {
        async reply() {
          replyCalls += 1
          return true
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Parent scoped reply",
      prompt: "Only the parent may answer this.",
      sessionId: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "permission.asked", {
      sessionID: "child-parent-scope",
      id: "perm-parent-scope",
      permission: "bash",
      patterns: ["git push"],
      always: [],
      metadata: {},
    })

    const replyResult = await controller.replyPermission(
      adapter,
      {
        jobId: launchResult.data.jobId,
        reply: "once",
      },
      { sessionId: "other-session" },
    )

    expect(replyResult.ok).toBe(false)
    expect(replyCalls).toBe(0)
    if (replyResult.ok) {
      throw new Error("Expected non-parent reply to fail")
    }
  })

  test("does not reopen a permission request when the same ask event is replayed after the parent already answered", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-stale-ask", directory }
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
      permission: {
        async reply() {
          return true
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Ignore stale permission ask",
      prompt: "Do not reopen after the request was already answered.",
      sessionId: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    const askPayload = {
      sessionID: "child-stale-ask",
      id: "perm-stale-ask",
      permission: "bash",
      patterns: ["git push"],
      always: [],
      metadata: {},
    }

    await controller.handleEvent(adapter, "permission.asked", askPayload)
    await controller.replyPermission(
      adapter,
      {
        jobId: launchResult.data.jobId,
        reply: "once",
      },
      { sessionId: "parent-session" },
    )
    await controller.handleEvent(adapter, "permission.asked", askPayload)

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected stale-ask job status to exist")
    }

    expect(status.data.job.state).toBe("running")
    expect(status.data.job.pendingInput).toBeUndefined()
  })

  test("fails fast when replying to a permission request that is not pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let replyCalls = 0
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-no-permission", directory }
        },
        async promptAsync() {
          return undefined
        },
        async messages() {
          return []
        },
        async abort() {
          return true
        },
      },
      permission: {
        async reply() {
          replyCalls += 1
          return true
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "No pending permission",
      prompt: "Do not block.",
      sessionId: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    const replyResult = await controller.replyPermission(
      adapter,
      {
        jobId: launchResult.data.jobId,
        reply: "once",
      },
      { sessionId: "parent-session" },
    )

    expect(replyResult.ok).toBe(false)
    expect(replyCalls).toBe(0)
    if (replyResult.ok) {
      throw new Error("Expected permission reply to fail")
    }
    expect(replyResult.error.code).toBe("JobBlockedOnPermission")
  })
})
