import { describe, expect, test } from "bun:test"

import { applyMissionControlToolGuidance, MissionControlPlugin } from "../src/plugin.ts"

describe("MissionControlPlugin tool guidance", () => {
  test("appends built-in guidance for mc_session_search", () => {
    const description = applyMissionControlToolGuidance("mc_session_search", "Search indexed session content")

    expect(description).toContain("Search indexed session content")
    expect(description).toContain("Prefer mc_session_read when you need raw tool outputs")
    expect(description).toContain("scope: 'global'")
  })

  test("tool.definition augments known Mission Control tools", async () => {
    const hooks = await MissionControlPlugin({
      client: {
        app: {
          async log() {
            return undefined
          },
        },
      },
      directory: "/tmp/project",
      worktree: "/tmp/project",
    } as any)

    const output = {
      description: "Launch a background child-session job",
      parameters: {},
    }

    await hooks["tool.definition"]?.({ toolID: "mc_job_start" } as any, output as any)

    expect(output.description).toContain("Launch a background child-session job")
    expect(output.description).toContain("Relay guide")
    expect(output.description).toContain("on_completion")
  })

  test("tool.definition leaves unrelated tools unchanged", async () => {
    const hooks = await MissionControlPlugin({
      client: {
        app: {
          async log() {
            return undefined
          },
        },
      },
      directory: "/tmp/project",
      worktree: "/tmp/project",
    } as any)

    const output = {
      description: "Plain tool description",
      parameters: {},
    }

    await hooks["tool.definition"]?.({ toolID: "something_else" } as any, output as any)

    expect(output.description).toBe("Plain tool description")
  })
})
