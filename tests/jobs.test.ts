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

describe("MissionControl background jobs launch and attachment", () => {
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

})
