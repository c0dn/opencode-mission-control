import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

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

const getJobsStorePath = (directory: string) =>
  join(
    process.env.XDG_CACHE_HOME?.trim() || join(process.env.HOME || tmpdir(), ".cache"),
    "opencode-mission-control",
    createHash("sha1").update(directory).digest("hex").slice(0, 16),
    "jobs.json",
  )

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
      sessionId: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-session" }, config.jobs.autoRelayToParent)

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
    expect(status.data.job.lastObservedEvent).toBe("session.idle")
  })

  test("treats session.status=idle the same as session.idle for finalization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-status-idle", directory }
        },
        async promptAsync() {
          return undefined
        },
        async messages() {
          return [
            {
              info: { id: "status-idle-message", role: "assistant", time: { created: 10 } },
              parts: [{ id: "status-idle-part", type: "text", text: "Finished through status idle." }],
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
      title: "Status idle finalize",
      prompt: "Finalize from session.status idle.",
      sessionId: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.status", {
      sessionID: "child-status-idle",
      status: { type: "idle" },
    })

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected status-idle job to exist")
    }

    expect(status.data.job.state).toBe("completed")
    expect(status.data.result?.state).toBe("completed")
  })

  test("auto-attaches to the current session when no explicit sessionId is provided", async () => {
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
      sessionId: "parent-session",
    })

    await Promise.resolve()

    const secondLaunch = await launcher.launch(adapter, {
      title: "Second launch",
      prompt: "This should be rejected while the first slot is reserved.",
      sessionId: "parent-session",
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
      sessionId: "parent-session",
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
      safety: {
        requireExplicitParentOnAmbiguousAttach: false,
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
      sessionId: "parent-session",
      relay: "manual",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    const earlyResult = await controller.getResult(adapter, launchResult.data.jobId, false)
    expect(earlyResult.ok).toBe(false)
    expect(controller.getActiveJobCount()).toBe(1)

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-running" })
    expect(controller.getActiveJobCount()).toBe(0)

    const stableResult = await controller.getResult(adapter, launchResult.data.jobId, false)
    expect(stableResult.ok).toBe(true)
  })

  test("allows manual relay for jobs configured with relay mode manual", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let relayCount = 0
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-manual-relay" }
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
      sessionId: "parent-session",
      relay: "manual",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-manual-relay" })
    const relayResult = await controller.getResult(adapter, launchResult.data.jobId, true)

    expect(relayResult.ok).toBe(true)
    expect(relayCount).toBe(1)
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
      sessionId: "parent-session",
      relay: "on_idle",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected relay-failure launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-relay-fail" })

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected relay-failure job status to exist")
    }

    expect(status.data.job.state).toBe("idle")
    expect(status.data.job.relayState).toBe("failed")
    expect(status.data.result?.summary).toContain("Finished work before relay failure")
    expect(relayAttempts).toBe(1)

    const result = await controller.getResult(adapter, launchResult.data.jobId, false)
    expect(result.ok).toBe(true)
  })

  test("orphans unresolved idle jobs after restart instead of rebinding them live", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-restart-idle", directory }
        },
        async promptAsync() {
          return undefined
        },
        async messages() {
          return [
            {
              info: { id: "restart-idle-message", role: "assistant", time: { created: 10 } },
              parts: [{ id: "restart-idle-part", type: "text", text: "Reached idle before restart." }],
            },
          ]
        },
        async abort() {
          return true
        },
        async prompt() {
          throw new Error("relay failed")
        },
      },
    })

    const config = createMissionControlConfig({
      jobs: {
        autoRelayToParent: "on_idle",
      },
    })
    const controller1 = new MissionControlJobController(directory, config)
    await controller1.start()
    const launcher = new MissionControlJobLauncher(() => config, controller1)

    const launchResult = await launcher.launch(adapter, {
      title: "Restart idle orphan",
      prompt: "Leave this job idle with a failed relay.",
      sessionId: "parent-session",
      relay: "on_idle",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller1.handleEvent(adapter, "session.idle", { sessionID: "child-restart-idle" })

    const controller2 = new MissionControlJobController(directory, config)
    await controller2.start()
    const status = controller2.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected restarted idle job status to exist")
    }

    expect(status.data.job.state).toBe("orphaned")
    expect(status.data.result?.summary).toContain("Reached idle before restart")
    expect(controller2.getActiveJobCount()).toBe(0)

    const result = await controller2.getResult(adapter, launchResult.data.jobId, false)
    expect(result.ok).toBe(true)
  })

  test("can transition from idle back to running when relay is still pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-resume-after-idle", directory }
        },
        async promptAsync() {
          return undefined
        },
        async messages() {
          return [
            {
              info: { id: "resume-message", role: "assistant", time: { created: 10 } },
              parts: [{ id: "resume-part", type: "text", text: "Reached an idle checkpoint." }],
            },
          ]
        },
        async abort() {
          return true
        },
        async prompt() {
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
      title: "Resume after idle",
      prompt: "Pause, then continue if more work appears.",
      sessionId: "parent-session",
      relay: "on_idle",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", {
      sessionID: "child-resume-after-idle",
      time: { updated: 10 },
    })
    expect(controller.getActiveJobCount()).toBe(1)

    const idleStatus = controller.status(launchResult.data.jobId)
    expect(idleStatus.ok).toBe(true)
    if (!idleStatus.ok) {
      throw new Error("Expected idle job status to exist")
    }

    expect(idleStatus.data.job.state).toBe("idle")
    expect(idleStatus.data.job.relayState).toBe("failed")

    await controller.handleEvent(adapter, "message.updated", {
      sessionID: "child-resume-after-idle",
      time: { updated: 11 },
    })

    const resumedStatus = controller.status(launchResult.data.jobId)
    expect(resumedStatus.ok).toBe(true)
    if (!resumedStatus.ok) {
      throw new Error("Expected resumed job status to exist")
    }

    expect(resumedStatus.data.job.state).toBe("running")
    expect(resumedStatus.data.result).toBeUndefined()
    expect(controller.getActiveJobCount()).toBe(1)

    const resumedResult = await controller.getResult(adapter, launchResult.data.jobId, false)
    expect(resumedResult.ok).toBe(false)
  })

  test("does not reopen an idle job on a stale status event without a fresher timestamp", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-stale-status", directory }
        },
        async promptAsync() {
          return undefined
        },
        async messages() {
          return [
            {
              info: { id: "stale-status-message", role: "assistant", time: { created: 10 } },
              parts: [{ id: "stale-status-part", type: "text", text: "Reached idle." }],
            },
          ]
        },
        async abort() {
          return true
        },
        async prompt() {
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
      title: "Ignore stale status",
      prompt: "Do not reopen from stale status.",
      sessionId: "parent-session",
      relay: "on_idle",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", {
      sessionID: "child-stale-status",
      time: { updated: 10 },
    })
    await controller.handleEvent(adapter, "session.status", {
      sessionID: "child-stale-status",
      status: { type: "running" },
      time: { updated: 9 },
    })

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected stale-status job status to exist")
    }

    expect(status.data.job.state).toBe("idle")
  })

  test("reopens an idle job when session.status reports fresher running activity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-fresh-status", directory }
        },
        async promptAsync() {
          return undefined
        },
        async messages() {
          return [
            {
              info: { id: "fresh-status-message", role: "assistant", time: { created: 10 } },
              parts: [{ id: "fresh-status-part", type: "text", text: "Reached idle." }],
            },
          ]
        },
        async abort() {
          return true
        },
        async prompt() {
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
      title: "Fresh status resume",
      prompt: "Allow a fresh status event to reopen idle work.",
      sessionId: "parent-session",
      relay: "on_idle",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", {
      sessionID: "child-fresh-status",
      time: { updated: 10 },
    })
    await controller.handleEvent(adapter, "session.status", {
      sessionID: "child-fresh-status",
      status: { type: "running" },
      time: { updated: 11 },
    })

    const status = controller.status(launchResult.data.jobId)
    expect(status.ok).toBe(true)
    if (!status.ok) {
      throw new Error("Expected fresh-status job status to exist")
    }

    expect(status.data.job.state).toBe("running")
    expect(status.data.result).toBeUndefined()
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
      sessionId: "parent-session",
      relay: "on_completion",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.error", { sessionID: "child-failed-relay" })

    const status = controller.status(launchResult.data.jobId)
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
      sessionId: "parent-session",
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
      sessionId: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-finalized" })
    const cancelResult = await controller.cancelJob(adapter, launchResult.data.jobId)

    expect(cancelResult.ok).toBe(false)
  })

  test("returns the v2 public job shape when aborting an active job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-abortable", directory }
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
      title: "Abort me",
      prompt: "Start and wait.",
      sessionId: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    const cancelResult = await controller.cancelJob(adapter, launchResult.data.jobId)
    expect(cancelResult.ok).toBe(true)
    if (!cancelResult.ok) {
      throw new Error("Expected cancel to succeed")
    }

    expect(cancelResult.data.jobId).toBe(launchResult.data.jobId)
    expect(cancelResult.data.sessionId).toBe("parent-session")
    expect(cancelResult.data.childSessionId).toBe("child-abortable")
    expect(cancelResult.data.relay).toBe("manual")
    expect(cancelResult.data.state).toBe("aborted")
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
      sessionId: "parent-session",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-fallback" })
    const result = await controller.getResult(adapter, launchResult.data.jobId, false)

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected fallback result to exist")
    }

    expect(result.data.summary).toContain("Transcript capture failed")
  })

  test("parses structured final reports and relays the recommended next step", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let relayedText = ""
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-structured-relay", directory }
        },
        async promptAsync() {
          return undefined
        },
        async messages() {
          return [
            {
              info: {
                id: "structured-message",
                role: "assistant",
                time: { created: 10 },
              },
              parts: [
                {
                  id: "structured-part",
                  type: "text",
                  text: `Status: completed
Summary: Verified the implementation gap is closed.
Key Findings: The contract now aligns.
Blockers:
- None
Recommended Next Step: Run the full verification suite before merging.`,
                },
              ],
            },
          ]
        },
        async abort() {
          return true
        },
        async prompt({ body }: { body: { parts?: Array<{ text?: string }> } }) {
          relayedText = body.parts?.[0]?.text ?? ""
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
      title: "Structured relay",
      prompt: "Finish with the required report headings.",
      sessionId: "parent-session",
      relay: "on_completion",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-structured-relay" })

    const result = await controller.getResult(adapter, launchResult.data.jobId, false)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected structured result to exist")
    }

    expect(result.data.summary).toContain("Verified the implementation gap is closed.")
    expect(result.data.summary).toContain("Key Findings:\nThe contract now aligns.")
    expect(result.data.blockers).toEqual([])
    expect(result.data.recommendedNextStep).toBe("Run the full verification suite before merging.")
    expect(relayedText).toContain("Recommended Next Step")
    expect(relayedText).toContain("Run the full verification suite before merging.")
    expect(relayedText).not.toContain("Review the child session transcript if deeper inspection is needed.")
  })

  test("persists normalized job lifecycle events alongside jobs and results", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-event-log", directory }
        },
        async promptAsync() {
          return undefined
        },
        async messages() {
          return [
            {
              info: { id: "event-message", role: "assistant", time: { created: 10 } },
              parts: [{ id: "event-part", type: "text", text: "Finished event-log test." }],
            },
          ]
        },
        async abort() {
          return true
        },
      },
    })

    const config = createMissionControlConfig({
      jobs: {
        autoRelayToParent: "manual",
      },
    })
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Persist events",
      prompt: "Exercise the lifecycle log.",
      sessionId: "parent-session",
      relay: "manual",
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-event-log" })

    const persisted = JSON.parse(await readFile(getJobsStorePath(directory), "utf8")) as {
      events?: Array<{
        jobID: string
        type: string
        state: string
      }>
    }

    const jobEvents = persisted.events?.filter((event) => event.jobID === launchResult.data.jobId) ?? []
    expect(jobEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(["job.created", "job.launching", "job.child_bound", "job.launched", "session.idle", "job.completed"]),
    )
    expect(jobEvents.at(-1)?.state).toBe("completed")
  })

  test("returns ParentSessionNotFound when an explicit sessionId cannot be resolved", async () => {
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
      sessionId: "parent-session",
    })

    expect(launchResult.ok).toBe(false)
    if (launchResult.ok) {
      throw new Error("Expected missing explicit parent launch to fail")
    }

    expect(launchResult.error.code).toBe("ParentSessionNotFound")
    expect(createCalls).toBe(0)
  })

  test("rejects a blank explicit sessionId instead of falling back to auto-attach", async () => {
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
      sessionId: "   ",
    })

    expect(launchResult.ok).toBe(false)
    if (launchResult.ok) {
      throw new Error("Expected blank explicit parent launch to fail")
    }

    expect(launchResult.error.code).toBe("ParentSessionNotFound")
    expect(createCalls).toBe(0)
  })
})
