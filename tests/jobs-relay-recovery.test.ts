import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { createMissionControlConfig } from "../src/config.ts"
import { MissionControlJobController } from "../src/jobs.ts"
import { MissionControlJobLauncher } from "../src/launcher.ts"
import { OpenCodeAdapter } from "../src/opencode-client.ts"
import { cleanupTempDirs, parentSessionHandlers, tempDirs } from "./job-test-helpers.ts"

afterEach(cleanupTempDirs)

describe("MissionControl background jobs relay and recovery", () => {
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
        async prompt() {
          return undefined
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
    }, {
      sessionId: "parent-session",
      directory,
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

  test("allows explicit re-delivery of a stored result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let relayCount = 0
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async list() {
          return [
            { id: "stale-session", directory, time: { created: 1, updated: 10 } },
            { id: "parent-session", directory, time: { created: 2, updated: 20 } },
          ]
        },
        async create() {
          return { id: "child-manual-relay" }
        },
        async promptAsync(input: { body?: { noReply?: boolean } }) {
          if (input.body?.noReply) {
            relayCount += 1
          }
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
            {
              info: {
                id: "message-1",
                role: "assistant",
                time: { created: 11 },
              },
              parts: [],
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
      title: "Re-deliver result",
      prompt: "Finish and allow a later explicit re-send.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-manual-relay" })

    const relayResult = await controller.getResult(adapter, launchResult.data.jobId, true, {
      sessionId: "stale-session",
      messageId: "message-1",
      directory,
    })

    expect(relayResult.ok).toBe(true)
    expect(relayCount).toBe(2)
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
        async promptAsync(input: { body?: { noReply?: boolean } }) {
          if (input.body?.noReply) {
            relayAttempts += 1
            throw new Error("relay failed")
          }
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
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Relay failure job",
      prompt: "Finish even if relay fails.",
    }, {
      sessionId: "parent-session",
      directory,
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
    expect(status.data.job.hasResult).toBe(true)
    expect(relayAttempts).toBe(1)

    const result = await controller.getResult(adapter, launchResult.data.jobId, false)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected relay-failure result to exist")
    }
    expect(result.data.summary).toContain("Finished work before relay failure")
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
        async promptAsync(input: { body?: { noReply?: boolean } }) {
          if (input.body?.noReply) {
            throw new Error("relay failed")
          }
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
      },
    })

    const config = createMissionControlConfig()
    const controller1 = new MissionControlJobController(directory, config)
    await controller1.start()
    const launcher = new MissionControlJobLauncher(() => config, controller1)

    const launchResult = await launcher.launch(adapter, {
      title: "Restart idle orphan",
      prompt: "Leave this job idle with a failed relay.",
    }, {
      sessionId: "parent-session",
      directory,
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
    expect(status.data.job.hasResult).toBe(true)
    expect(controller2.getActiveJobCount()).toBe(0)

    const result = await controller2.getResult(adapter, launchResult.data.jobId, false)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected orphaned idle result to exist")
    }
    expect(result.data.summary).toContain("Reached idle before restart")
  })

  test("can re-send a stored result after restart when the job became orphaned", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const initialAdapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-orphan-resend", directory }
        },
        async promptAsync(input: { body?: { noReply?: boolean } }) {
          if (input.body?.noReply) {
            throw new Error("relay failed before restart")
          }
          return undefined
        },
        async messages() {
          return [
            {
              info: { id: "orphan-resend-message", role: "assistant", time: { created: 10 } },
              parts: [{ id: "orphan-resend-part", type: "text", text: "Reached idle before restart." }],
            },
          ]
        },
        async abort() {
          return true
        },
      },
    })

    const config = createMissionControlConfig()
    const controller1 = new MissionControlJobController(directory, config)
    await controller1.start()
    const launcher = new MissionControlJobLauncher(() => config, controller1)

    const launchResult = await launcher.launch(initialAdapter, {
      title: "Orphan resend",
      prompt: "Allow a later explicit re-send after restart.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller1.handleEvent(initialAdapter, "session.idle", { sessionID: "child-orphan-resend" })

    let relayedText = ""
    const resendAdapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async promptAsync(input: { body?: { noReply?: boolean; parts?: Array<{ text?: string }> } }) {
          if (!input.body?.noReply) {
            return undefined
          }

          const body = input.body
          relayedText = body.parts?.[0]?.text ?? ""
          return true
        },
        async messages() {
          return [
            {
              info: { id: "orphan-resend-message", role: "assistant", time: { created: 10 } },
              parts: [{ id: "orphan-resend-part", type: "text", text: "Reached idle before restart." }],
            },
          ]
        },
      },
    })

    const controller2 = new MissionControlJobController(directory, config)
    await controller2.start()

    const result = await controller2.getResult(resendAdapter, launchResult.data.jobId, true, { sessionId: "parent-session" })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected orphaned result re-send to succeed")
    }

    expect(relayedText).toContain("Attached background session update")
    expect(relayedText).toContain("Reached idle before restart")
  })

  test("rejects result re-send requests from sessions other than the parent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let relayCalls = 0
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-resend-scope", directory }
        },
        async promptAsync(input: { body?: { noReply?: boolean } }) {
          if (input.body?.noReply) {
            relayCalls += 1
          }
          return undefined
        },
        async messages() {
          return [
            {
              info: { id: "resend-scope-message", role: "assistant", time: { created: 10 } },
              parts: [{ id: "resend-scope-part", type: "text", text: "Finished work." }],
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
      title: "Resend scope",
      prompt: "Finish and protect the resend path.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-resend-scope" })

    const resendResult = await controller.getResult(adapter, launchResult.data.jobId, true, { sessionId: "other-session" })
    expect(resendResult.ok).toBe(false)
    expect(relayCalls).toBe(1)
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
        async promptAsync(input: { body?: { noReply?: boolean } }) {
          if (input.body?.noReply) {
            throw new Error("relay failed")
          }
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
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Resume after idle",
      prompt: "Pause, then continue if more work appears.",
    }, {
      sessionId: "parent-session",
      directory,
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
    expect(idleStatus.data.job.hasResult).toBe(true)

    const idleEvents = controller.jobEvents(launchResult.data.jobId, 10)
    expect(idleEvents.ok).toBe(true)
    if (!idleEvents.ok) {
      throw new Error("Expected idle job events to exist")
    }
    expect(idleEvents.data.events.map((event) => event.type)).toContain("job.relay_failed")

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
    expect(resumedStatus.data.job.hasResult).toBe(false)
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
        async promptAsync(input: { body?: { noReply?: boolean } }) {
          if (input.body?.noReply) {
            throw new Error("relay failed")
          }
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
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Ignore stale status",
      prompt: "Do not reopen from stale status.",
    }, {
      sessionId: "parent-session",
      directory,
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
        async promptAsync(input: { body?: { noReply?: boolean } }) {
          if (input.body?.noReply) {
            throw new Error("relay failed")
          }
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
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Fresh status resume",
      prompt: "Allow a fresh status event to reopen idle work.",
    }, {
      sessionId: "parent-session",
      directory,
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
    expect(status.data.job.hasResult).toBe(false)
  })

  test("auto-relays failed jobs to the parent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    let relayCount = 0
    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-failed-relay", directory }
        },
        async promptAsync(input: { body?: { noReply?: boolean } }) {
          if (input.body?.noReply) {
            relayCount += 1
          }
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
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Fail and relay",
      prompt: "Relay failure state on completion.",
    }, {
      sessionId: "parent-session",
      directory,
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
    expect(status.data.job.hasResult).toBe(true)
    expect(relayCount).toBe(1)

    const events = controller.jobEvents(launchResult.data.jobId, 10)
    expect(events.ok).toBe(true)
    if (!events.ok) {
      throw new Error("Expected failed-relay job events to exist")
    }
    expect(events.data.events.map((event) => event.type)).toContain("job.relay_delivered")
  })
})
