import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { createMissionControlConfig } from "../src/config.ts"
import { MissionControlJobController } from "../src/jobs.ts"
import { MissionControlJobLauncher } from "../src/launcher.ts"
import { OpenCodeAdapter } from "../src/opencode-client.ts"
import { cleanupTempDirs, parentSessionHandlers, tempDirs } from "./job-test-helpers.ts"

afterEach(cleanupTempDirs)

describe("MissionControl background jobs launch, attachment, and bootstrap failures", () => {
  test("launches a child session and captures an idle result snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-session" }
        },
        async promptAsync() {
          return undefined
        },
        async messages() {
          return [
            {
              info: {
                id: "child-message",
                role: "assistant",
                time: { created: 10 },
              },
              parts: [
                {
                  id: "child-part",
                  type: "text",
                  text: "Completed background analysis successfully.",
                },
              ],
            },
          ]
        },
        async abort() {
          return true
        },
        async prompt() {
          return undefined
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()

    const launcher = new MissionControlJobLauncher(() => config, controller)
    const launchResult = await launcher.launch(adapter, {
      title: "Analyze session",
      prompt: "Inspect the current codebase state.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-session" })

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected job status to exist")
    }

    expect(status.data.job.childSessionId).toBe("child-session")
    expect(status.data.result?.summary).toContain("Completed background analysis")
    expect(status.data.job.state).toBe("completed")
    expect(status.data.result?.state).toBe("completed")
    expect(status.data.job.completedAt).toBeDefined()
    expect(status.data.job.lastObservedEvent).toBe("job.relay_delivered")
  })

  test("attaches to the current session when caller context includes a session id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let createdParentID: string | undefined
    const adapter = new OpenCodeAdapter({
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory,
            title: "Resolved Session",
            time: { created: 1, updated: 2 },
          }
        },
        async create({ body }: { body: { parentID?: string } }) {
          createdParentID = body.parentID
          return { id: "child-auto", directory }
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
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(
      adapter,
      {
        title: "Auto attach",
        prompt: "Follow the current session.",
      },
      {
        sessionId: "current-session",
        directory,
      },
    )

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected auto-attach launch to succeed")
    }

    expect(launchResult.data.sessionId).toBe("current-session")
    expect(createdParentID).toBe("current-session")
  })

  test("writes launch and tracked-event diagnostics to the debug file when enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)
    const debugFilePath = join(directory, "debug.jsonl")

    const adapter = new OpenCodeAdapter(
      {
        session: {
          ...parentSessionHandlers(directory),
          async create() {
            return { id: "child-session", directory }
          },
          async promptAsync() {
            return undefined
          },
          async messages() {
            return [
              {
                info: {
                  id: "child-message",
                  role: "assistant",
                  time: { created: 10 },
                },
                parts: [
                  {
                    id: "child-part",
                    type: "text",
                    text: "Completed background analysis successfully.",
                  },
                ],
              },
            ]
          },
          async abort() {
            return true
          },
          async prompt() {
            return undefined
          },
        },
      },
      {
        rootDir: directory,
        debug: {
          enabled: true,
          filePath: debugFilePath,
        },
      },
    )

    const config = createMissionControlConfig({
      debug: {
        enabled: true,
        filePath: debugFilePath,
      },
    })
    const controller = new MissionControlJobController(directory, config)
    await controller.start()

    const launcher = new MissionControlJobLauncher(() => config, controller)
    const launchResult = await launcher.launch(adapter, {
      title: "Analyze session",
      prompt: "Inspect the current codebase state.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "message.updated", {
      sessionID: "child-session",
      time: { updated: 20 },
    })
    await controller.handleEvent(adapter, "session.idle", {
      sessionID: "child-session",
      time: { updated: 30 },
    })

    const content = await readFile(debugFilePath, "utf8")
    const messages = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message: string })
      .map((entry) => entry.message)

    expect(messages).toEqual(
      expect.arrayContaining([
        "launch created job record",
        "launch child session created",
        "launch child async prompt submitted",
        "handleEvent received tracked child event",
        "handleEvent updated tracked child event",
        "handleIdleTransition finalizing idle job",
        "captureResult stored snapshot",
        "relayResult delivered stored snapshot",
      ]),
    )
  })

  test("recovers the actual current session from the current message when tool context sessionId is stale", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let createdParentID: string | undefined
    const adapter = new OpenCodeAdapter({
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory,
            title: path.id,
            time: { created: 1, updated: path.id === "actual-session" ? 20 : 10 },
          }
        },
        async list() {
          return [
            { id: "stale-session", directory, title: "Stale", time: { created: 1, updated: 10 } },
            { id: "actual-session", directory, title: "Actual", time: { created: 2, updated: 20 } },
          ]
        },
        async messages({ path }: { path: { id: string } }) {
          return path.id === "actual-session"
            ? [{ info: { id: "message-1" }, parts: [] }]
            : [{ info: { id: "different-message" }, parts: [] }]
        },
        async create({ body }: { body: { parentID?: string } }) {
          createdParentID = body.parentID
          return { id: "child-auto", directory }
        },
        async promptAsync() {
          return undefined
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

    const launchResult = await launcher.launch(
      adapter,
      {
        title: "Recovered auto attach",
        prompt: "Follow the actual current session.",
      },
      {
        sessionId: "stale-session",
        messageId: "message-1",
        directory,
      },
    )

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected recovered auto-attach launch to succeed")
    }

    expect(launchResult.data.sessionId).toBe("actual-session")
    expect(createdParentID).toBe("actual-session")
  })

  test("reserves concurrency slots during launch so overlapping starts cannot exceed maxConcurrent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let releaseParentResolution: (() => void) | undefined
    const parentResolutionBlocked = new Promise<void>((resolve) => {
      releaseParentResolution = resolve
    })

    let resolveCalls = 0
    const adapter = new OpenCodeAdapter({
      session: {
        async get({ path }: { path: { id: string } }) {
          resolveCalls += 1
          if (resolveCalls === 1) {
            await parentResolutionBlocked
          }

          return {
            id: path.id,
            directory,
            title: "Parent Session",
            time: { created: 1, updated: 2 },
          }
        },
        async create() {
          return { id: `child-${resolveCalls}`, directory }
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
    })

    const config = createMissionControlConfig({
      jobs: {
        maxConcurrent: 1,
      },
    })
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const firstLaunch = launcher.launch(adapter, {
      title: "First launch",
      prompt: "Hold the slot briefly.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    await Promise.resolve()

    const secondLaunch = await launcher.launch(adapter, {
      title: "Second launch",
      prompt: "This should be rejected while the first slot is reserved.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(secondLaunch.ok).toBe(false)
    if (secondLaunch.ok) {
      throw new Error("Expected second launch to fail the concurrency gate")
    }
    expect(secondLaunch.error.code).toBe("JobLaunchFailed")

    releaseParentResolution?.()

    const firstResult = await firstLaunch
    expect(firstResult.ok).toBe(true)
  })

  test("rolls back a queued job cleanly when initial job persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "should-not-launch", directory }
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
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const originalPersist = (controller as any).persist.bind(controller)
    let persistCalls = 0
    ;(controller as any).persist = async () => {
      persistCalls += 1
      if (persistCalls === 1) {
        throw new Error("persist failed")
      }

      return originalPersist()
    }

    const launcher = new MissionControlJobLauncher(() => config, controller)
    const launchResult = await launcher.launch(adapter, {
      title: "Rollback queued job",
      prompt: "This launch should fail before the queued job sticks.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(false)
    expect(controller.getActiveJobCount()).toBe(0)

    const jobs = controller.listJobs()
    expect(jobs.ok).toBe(true)
    if (!jobs.ok) {
      throw new Error("Expected job list to be readable")
    }

    expect(jobs.data).toHaveLength(0)
  })

  test("fails with ParentSessionScopeUnavailable when no current caller session context is available", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let createCalls = 0
    const adapter = new OpenCodeAdapter({
      session: {
        async create() {
          createCalls += 1
          return { id: "should-not-exist" }
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
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Missing caller context",
      prompt: "Launch should fail without a current parent session.",
    })

    expect(launchResult.ok).toBe(false)
    if (launchResult.ok) {
      throw new Error("Expected launch to fail without caller context")
    }

    expect(launchResult.error.code).toBe("ParentSessionScopeUnavailable")
    expect(createCalls).toBe(0)
  })

  test("fails closed when the current caller session cannot be verified from the current message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let createCalls = 0
    const adapter = new OpenCodeAdapter({
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory,
            title: path.id,
            time: { created: 1, updated: 10 },
          }
        },
        async list() {
          return [
            {
              id: "stale-session",
              directory,
              title: "Stale",
              time: { created: 1, updated: 10 },
            },
            {
              id: "other-session",
              directory,
              title: "Other",
              time: { created: 2, updated: 20 },
            },
          ]
        },
        async create() {
          createCalls += 1
          return { id: "should-not-exist" }
        },
        async promptAsync() {
          return undefined
        },
        async messages({ path }: { path: { id: string } }) {
          return path.id === "stale-session"
            ? [{ info: { id: "different-message" }, parts: [] }]
            : [{ info: { id: "other-message" }, parts: [] }]
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
      title: "Unverified caller session",
      prompt: "Do not guess another parent session.",
    }, {
      sessionId: "stale-session",
      messageId: "message-1",
      directory,
    })

    expect(launchResult.ok).toBe(false)
    if (launchResult.ok) {
      throw new Error("Expected launch to fail when caller message ownership cannot be proven")
    }

    expect(launchResult.error.code).toBe("ParentSessionScopeUnavailable")
    expect(createCalls).toBe(0)
  })

  test("tracks a created child session when promptAsync fails after creation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let abortCount = 0
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-partial-failure" }
        },
        async promptAsync() {
          throw new Error("promptAsync failed")
        },
        async messages() {
          return []
        },
        async abort() {
          abortCount += 1
          return true
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Partial failure job",
      prompt: "This launch will fail after child creation.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(false)
    expect(abortCount).toBe(1)

    const listResult = controller.listJobs()
    expect(listResult.ok).toBe(true)
    if (!listResult.ok) {
      throw new Error("Expected tracked jobs to be listed")
    }

    expect(listResult.data[0]?.childSessionId).toBe("child-partial-failure")
    expect(listResult.data[0]?.state).toBe("failed")
  })

})
