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

describe("MissionControl background job progress and event feed", () => {
  test("persists job events across restart, including child progress updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-job-events", directory }
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
    const controller1 = new MissionControlJobController(directory, config)
    await controller1.start()
    const launcher = new MissionControlJobLauncher(() => config, controller1)

    const launchResult = await launcher.launch(adapter, {
      title: "Job events",
      prompt: "Track progress updates.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    const updateResult = await controller1.updateProgress(
      adapter,
      {
        message: "Finished scanning the last 4 files.",
      },
      {
        sessionId: "child-job-events",
      },
    )
    expect(updateResult.ok).toBe(true)

    const beforeRestart = controller1.jobEvents(launchResult.data.jobId, 10)
    expect(beforeRestart.ok).toBe(true)
    if (!beforeRestart.ok) {
      throw new Error("Expected job events before restart")
    }
    expect(beforeRestart.data.events.map((event) => event.type)).toContain("job.progress")

    const controller2 = new MissionControlJobController(directory, config)
    await controller2.start()
    const afterRestart = controller2.jobEvents(launchResult.data.jobId, 10)
    expect(afterRestart.ok).toBe(true)
    if (!afterRestart.ok) {
      throw new Error("Expected job events after restart")
    }
    expect(afterRestart.data.events.map((event) => event.type)).toContain("job.progress")
    expect(afterRestart.data.events.find((event) => event.type === "job.progress")?.detail).toBe(
      "Finished scanning the last 4 files.",
    )
  })

  for (const [notifyParent, expectedNotifications] of [
    [false, 0],
    [true, 1],
  ] as const) {
    test(`records child progress updates without finalizing the job (notifyParent=${notifyParent})`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
      tempDirs.push(directory)

      const parentMessages: string[] = []
      const adapter = new OpenCodeAdapter({
        session: {
          ...parentSessionHandlers(directory),
          async create() {
            return { id: "child-progress", directory }
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
        title: "Progress updates",
        prompt: "Send checkpoints while working.",
      }, {
        sessionId: "parent-session",
        directory,
      })

      expect(launchResult.ok).toBe(true)
      if (!launchResult.ok) {
        throw new Error("Expected launch to succeed")
      }

      const updateResult = await controller.updateProgress(
        adapter,
        {
          message: "Checkpoint complete.",
          notifyParent,
        },
        {
          sessionId: "child-progress",
        },
      )

      expect(updateResult.ok).toBe(true)
      if (!updateResult.ok) {
        throw new Error("Expected progress update to succeed")
      }

      expect(updateResult.data.eventId).toEqual(expect.any(String))
      expect(updateResult.data.state).toBe("running")
      expect(parentMessages).toHaveLength(expectedNotifications)
      if (notifyParent) {
        expect(parentMessages[0]).toContain("progress update")
      }

      const status = controller.status(launchResult.data.jobId)
      expect(status.ok).toBe(true)
      if (!status.ok) {
        throw new Error("Expected progress-updated job status to exist")
      }
      expect(status.data.job.hasResult).toBe(false)
    })
  }

  test("rejects progress updates from sessions that are not the tracked child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-expected", directory }
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
      title: "Wrong child progress",
      prompt: "Only the child session may update this job.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    const updateResult = await controller.updateProgress(
      adapter,
      {
        jobId: launchResult.data.jobId,
        message: "I should not be accepted.",
      },
      {
        sessionId: "child-other",
      },
    )

    expect(updateResult.ok).toBe(false)
    if (updateResult.ok) {
      throw new Error("Expected wrong-child progress update to fail")
    }

    const events = controller.jobEvents(launchResult.data.jobId, 10)
    expect(events.ok).toBe(true)
    if (!events.ok) {
      throw new Error("Expected job events to exist")
    }
    expect(events.data.events.map((event) => event.type)).not.toContain("job.progress")
  })
})
