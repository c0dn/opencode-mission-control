import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { createMissionControlConfig } from "../src/config.ts"
import { MissionControlJobController } from "../src/jobs.ts"
import { MissionControlJobLauncher } from "../src/launcher.ts"
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

const parentSessionHandlers = (directory: string) => ({
  async get({ path }: { path: { id: string } }) {
    if (path.id !== "parent-session") {
      throw new Error("not found")
    }

    return {
      id: path.id,
      directory,
      title: "Parent Session",
      time: { created: 1, updated: 2 },
    }
  },
})

describe("MissionControl background jobs", () => {
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
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()

    const launcher = new MissionControlJobLauncher(() => config, controller)
    const launchResult = await launcher.launch(adapter, {
      title: "Analyze session",
      prompt: "Inspect the current codebase state.",
      parentSessionID: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-session" }, config.jobs.autoRelayToParent)

    const status = controller.status(launchResult.data.jobID)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected job status to exist")
    }

    expect(status.data.job.childSessionID).toBe("child-session")
    expect(status.data.result?.summary).toContain("Completed background analysis")
    expect(status.data.job.state).toBe("completed")
    expect(status.data.result?.state).toBe("completed")
    expect(status.data.job.completedAt).toBeDefined()
    expect(status.data.job.lastObservedEvent).toBe("session.idle")
  })

  test("auto-attaches to the current session when no explicit parentSessionID is provided", async () => {
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

    const config = createMissionControlConfig({
      jobs: {
        autoAttachToCurrentSession: true,
      },
    })
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
        sessionID: "current-session",
        directory,
      },
    )

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected auto-attach launch to succeed")
    }

    expect(launchResult.data.parentSessionID).toBe("current-session")
    expect(createdParentID).toBe("current-session")
  })

  test("fails with AmbiguousParentSession when fallback attach sees multiple root sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let createCalls = 0
    const adapter = new OpenCodeAdapter({
      session: {
        async list() {
          return [
            {
              id: "root-a",
              directory,
              title: "Root A",
              time: { created: 1, updated: 11 },
            },
            {
              id: "root-b",
              directory,
              title: "Root B",
              time: { created: 2, updated: 10 },
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
        autoAttachToCurrentSession: true,
        allowLatestSessionFallback: true,
      },
    })
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Ambiguous attach",
      prompt: "Do not pick a random root session.",
    })

    expect(launchResult.ok).toBe(false)
    if (launchResult.ok) {
      throw new Error("Expected ambiguous attach launch to fail")
    }

    expect(launchResult.error.code).toBe("AmbiguousParentSession")
    expect(createCalls).toBe(0)
  })

  test("does not expose stable results before the child session reaches a stable state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-running" }
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
    const launchResult = await launcher.launch(adapter, {
      title: "Run analysis",
      prompt: "Do work in the background.",
      parentSessionID: "parent-session",
      relayToParent: "never",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    const earlyResult = await controller.getResult(adapter, launchResult.data.jobID, false)
    expect(earlyResult.ok).toBe(false)
    expect(controller.getActiveJobCount()).toBe(1)

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-running" })
    expect(controller.getActiveJobCount()).toBe(0)

    const stableResult = await controller.getResult(adapter, launchResult.data.jobID, false)
    expect(stableResult.ok).toBe(true)
  })

  test("rejects manual relay for jobs configured with relayMode never", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let relayCount = 0
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-never-relay" }
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
                  text: "Finished work.",
                },
              ],
            },
          ]
        },
        async abort() {
          return true
        },
        async prompt() {
          relayCount += 1
          return undefined
        },
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "No relay job",
      prompt: "Do not relay this result.",
      parentSessionID: "parent-session",
      relayToParent: "never",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-never-relay" })
    const relayResult = await controller.getResult(adapter, launchResult.data.jobID, true)

    expect(relayResult.ok).toBe(false)
    expect(relayCount).toBe(0)
  })

  test("keeps the stable result snapshot when automatic relay delivery fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let relayAttempts = 0
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-relay-fail", directory }
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
                  text: "Finished work before relay failure.",
                },
              ],
            },
          ]
        },
        async abort() {
          return true
        },
        async prompt() {
          relayAttempts += 1
          throw new Error("relay failed")
        },
      },
    })

    const config = createMissionControlConfig({
      jobs: {
        autoRelayToParent: "on_idle",
      },
    })
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Relay failure job",
      prompt: "Finish even if relay fails.",
      parentSessionID: "parent-session",
      relayToParent: "on_idle",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected relay-failure launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-relay-fail" })

    const status = controller.status(launchResult.data.jobID)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected relay-failure job status to exist")
    }

    expect(status.data.job.state).toBe("idle")
    expect(status.data.job.relayState).toBe("failed")
    expect(status.data.result?.summary).toContain("Finished work before relay failure")
    expect(relayAttempts).toBe(1)

    const result = await controller.getResult(adapter, launchResult.data.jobID, false)
    expect(result.ok).toBe(true)
  })

  test("auto-relays failed jobs when relay mode is on_completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let relayCount = 0
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-failed-relay", directory }
        },
        async promptAsync() {
          return undefined
        },
        async messages() {
          return [
            {
              info: { id: "failed-message", role: "assistant", time: { created: 10 } },
              parts: [{ id: "failed-part", type: "text", text: "failure summary" }],
            },
          ]
        },
        async abort() {
          return true
        },
        async prompt() {
          relayCount += 1
          return undefined
        },
      },
    })

    const config = createMissionControlConfig({
      jobs: {
        autoRelayToParent: "on_completion",
      },
    })
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Fail and relay",
      prompt: "Relay failure state on completion.",
      parentSessionID: "parent-session",
      relayToParent: "on_completion",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.error", { sessionID: "child-failed-relay" })

    const status = controller.status(launchResult.data.jobID)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected failed job status to exist")
    }

    expect(status.data.job.state).toBe("failed")
    expect(status.data.job.relayState).toBe("delivered")
    expect(relayCount).toBe(1)
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
      parentSessionID: "parent-session",
    })

    expect(launchResult.ok).toBe(false)
    expect(abortCount).toBe(1)

    const listResult = controller.listJobs()
    expect(listResult.ok).toBe(true)
    if (!listResult.ok) {
      throw new Error("Expected tracked jobs to be listed")
    }

    expect(listResult.data[0]?.childSessionID).toBe("child-partial-failure")
    expect(listResult.data[0]?.state).toBe("failed")
  })

  test("refuses to cancel a finalized idle job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-finalized" }
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
                  text: "Done.",
                },
              ],
            },
          ]
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
      title: "Finalize then refuse cancel",
      prompt: "Finish and become idle.",
      parentSessionID: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-finalized" })
    const cancelResult = await controller.cancelJob(adapter, launchResult.data.jobID)

    expect(cancelResult.ok).toBe(false)
  })

  test("finalizes with a fallback snapshot when transcript capture fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-fallback" }
        },
        async promptAsync() {
          return undefined
        },
        async messages() {
          throw new Error("transient read failure")
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
      title: "Fallback finalize",
      prompt: "Trigger idle finalization even if transcript capture fails.",
      parentSessionID: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-fallback" })
    const result = await controller.getResult(adapter, launchResult.data.jobID, false)

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected fallback result to exist")
    }

    expect(result.data.summary).toContain("Transcript capture failed")
  })

  test("returns ParentSessionNotFound when an explicit parentSessionID cannot be resolved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let createCalls = 0
    const adapter = new OpenCodeAdapter({
      session: {
        async get() {
          throw new Error("not found")
        },
        async list() {
          return []
        },
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
      title: "Missing explicit parent",
      prompt: "This should fail early.",
      parentSessionID: "parent-session",
    })

    expect(launchResult.ok).toBe(false)
    if (launchResult.ok) {
      throw new Error("Expected missing explicit parent launch to fail")
    }

    expect(launchResult.error.code).toBe("ParentSessionNotFound")
    expect(createCalls).toBe(0)
  })

  test("rejects a blank explicit parentSessionID instead of falling back to auto-attach", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let createCalls = 0
    const adapter = new OpenCodeAdapter({
      session: {
        async get() {
          throw new Error("not found")
        },
        async list() {
          return [
            {
              id: "root-session",
              directory,
              title: "Root Session",
              time: { created: 1, updated: 10 },
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
        autoAttachToCurrentSession: true,
        allowLatestSessionFallback: true,
      },
    })
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Blank explicit parent",
      prompt: "Do not auto-attach.",
      parentSessionID: "   ",
      attach: "auto",
    })

    expect(launchResult.ok).toBe(false)
    if (launchResult.ok) {
      throw new Error("Expected blank explicit parent launch to fail")
    }

    expect(launchResult.error.code).toBe("ParentSessionNotFound")
    expect(createCalls).toBe(0)
  })
})
