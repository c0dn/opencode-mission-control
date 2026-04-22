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

describe("MissionControl background jobs finalization and cancellation", () => {
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
      title: "Finalize then refuse cancel",
      prompt: "Finish and become idle.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-finalized" })
    const cancelResult = await controller.cancelJob(adapter, launchResult.data.jobId, { sessionId: "parent-session" })

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
      title: "Abort me",
      prompt: "Start and wait.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    const cancelResult = await controller.cancelJob(adapter, launchResult.data.jobId, { sessionId: "parent-session" })
    expect(cancelResult.ok).toBe(true)
    if (!cancelResult.ok) {
      throw new Error("Expected cancel to succeed")
    }

    expect(cancelResult.data.jobId).toBe(launchResult.data.jobId)
    expect(cancelResult.data.sessionId).toBe("parent-session")
    expect(cancelResult.data.childSessionId).toBe("child-abortable")
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
      title: "Fallback finalize",
      prompt: "Trigger idle finalization even if transcript capture fails.",
    }, {
      sessionId: "parent-session",
      directory,
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

  test("captures tool output when the final child message is a completed tool part", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mission-control-jobs-"))
    tempDirs.push(directory)

    const adapter = new OpenCodeAdapter({
      session: {
        ...parentSessionHandlers(directory),
        async create() {
          return { id: "child-tool-output", directory }
        },
        async promptAsync() {
          return undefined
        },
        async messages() {
          return [
            {
              info: {
                id: "tool-output-message",
                role: "assistant",
                time: { created: 10 },
              },
              parts: [
                {
                  id: "tool-output-part",
                  type: "tool",
                  tool: "bash",
                  state: {
                    status: "completed",
                    output: "probe command finished successfully",
                  },
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
      title: "Tool output finalize",
      prompt: "Finish on a tool output.",
    }, {
      sessionId: "parent-session",
      directory,
    })

    expect(launchResult.ok).toBe(true)
    if (!launchResult.ok) {
      throw new Error("Expected launch to succeed")
    }

    await controller.handleEvent(adapter, "session.idle", { sessionID: "child-tool-output" })

    const result = await controller.getResult(adapter, launchResult.data.jobId, false)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected tool-output result to exist")
    }

    expect(result.data.summary).toContain("probe command finished successfully")
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
        async promptAsync(input: { body?: { noReply?: boolean; parts?: Array<{ text?: string }> } }) {
          if (input.body?.noReply) {
            relayedText = input.body.parts?.[0]?.text ?? ""
          }

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
      },
    })

    const config = createMissionControlConfig()
    const controller = new MissionControlJobController(directory, config)
    await controller.start()
    const launcher = new MissionControlJobLauncher(() => config, controller)

    const launchResult = await launcher.launch(adapter, {
      title: "Structured relay",
      prompt: "Finish with the required report headings.",
    }, {
      sessionId: "parent-session",
      directory,
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
      title: "Persist events",
      prompt: "Exercise the lifecycle log.",
    }, {
      sessionId: "parent-session",
      directory,
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
      expect.arrayContaining(["job.created", "job.launching", "job.child_bound", "job.launched", "session.idle", "job.relay_delivered"]),
    )
    expect(jobEvents.at(-1)?.state).toBe("completed")
  })
})
