import { writeFile } from "node:fs/promises"

import { describe, expect, test } from "bun:test"

import { MissionControlTerminalRegistry } from "../src/terminals/registry.ts"
import { parsePaneList, ZellijAdapter, type ZellijRunner } from "../src/terminals/zellij.ts"

describe("ZellijAdapter", () => {
  test("passes zellij commands as argv arrays and discovers created pane id", async () => {
    const calls: string[][] = []
    const runner: ZellijRunner = async (argv) => {
      calls.push(argv)
      if (argv.includes("list-panes")) {
        expect(argv).toContain("--json")
        expect(argv).toContain("--all")
        return { stdout: calls.filter((call) => call.includes("list-panes")).length === 1 ? "[]" : '[{"pane_id":7}]', stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    }

    const adapter = new ZellijAdapter(runner)
    const paneId = await adapter.newPane({
      sessionName: "mc-ses-1",
      command: ["bun", "test"],
      cwd: "/tmp/project",
      title: "tests",
      floating: true,
    })

    expect(paneId).toBe("7")
    expect(calls[1]).toEqual([
      "--session",
      "mc-ses-1",
      "action",
      "new-pane",
      "--cwd",
      "/tmp/project",
      "--name",
      "tests",
      "--floating",
      "--",
      "bun",
      "test",
    ])
  })

  test("parses JSON and text pane listings", () => {
    expect(parsePaneList('[{"pane_id":3,"title":"server"}]')).toEqual([{ paneId: "3", title: "server" }])
    expect(parsePaneList('[{"id":5,"pane_command":"bash","exited":true,"exit_status":0}]')).toEqual([
      { paneId: "5", command: "bash", exited: true, exitStatus: 0 },
    ])
    expect(parsePaneList("PaneId: 4 title=worker")).toEqual([{ paneId: "4", title: "worker" }])
  })

  test("parses zellij terminal pane ids", async () => {
    const adapter = new ZellijAdapter(async (argv) => {
      if (argv.includes("list-panes")) {
        return { stdout: "[]", stderr: "", exitCode: 0 }
      }
      return { stdout: "terminal_42", stderr: "", exitCode: 0 }
    })

    await expect(adapter.newPane({ sessionName: "mc-ses-1", command: ["true"] })).resolves.toBe("42")
  })

  test("uses end-of-options markers before sent text and keys", async () => {
    const calls: string[][] = []
    const adapter = new ZellijAdapter(async (argv) => {
      calls.push(argv)
      return { stdout: "", stderr: "", exitCode: 0 }
    })

    await adapter.sendText("mc-ses-1", "7", "--not-a-zellij-option")
    await adapter.sendKey("mc-ses-1", "7", "--leading-hyphen-key")

    expect(calls).toEqual([
      ["--session", "mc-ses-1", "action", "write-chars", "--pane-id", "7", "--", "--not-a-zellij-option"],
      ["--session", "mc-ses-1", "action", "send-keys", "--pane-id", "7", "--", "--leading-hyphen-key"],
    ])
  })

  test("tolerates existing background sessions", async () => {
    const calls: string[][] = []
    const adapter = new ZellijAdapter(async (argv) => {
      calls.push(argv)
      return {
        stdout: "",
        stderr: "Session already exists",
        exitCode: 1,
      }
    })

    await expect(adapter.ensureBackgroundSession("mc-ses-1")).resolves.toBeUndefined()
    expect(calls).toEqual([["attach", "--create-background", "mc-ses-1"]])
  })
})

describe("MissionControlTerminalRegistry", () => {
  test("starts, lists, reads, sends, cancels, and injects cancellation notice", async () => {
    const calls: string[][] = []
    const runner: ZellijRunner = async (argv) => {
      calls.push(argv)
      if (argv.includes("list-panes")) {
        return { stdout: calls.filter((call) => call.includes("list-panes")).length === 1 ? "[]" : '[{"pane_id":11}]', stderr: "", exitCode: 0 }
      }
      if (argv.includes("dump-screen")) {
        return { stdout: "line 1\nline 2\nline 3", stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    }
    const notices: string[] = []
    const registry = new MissionControlTerminalRegistry(new ZellijAdapter(runner), {
      debug: async () => undefined,
      injectSyntheticText: async (_sessionId: string, text: string) => {
        notices.push(text)
        return { ok: true }
      },
    } as any)

    const started = await registry.start({ sessionId: "ses_123", command: ["printf", "ok"], title: "demo" })
    expect(started.terminal.zellijSessionName).toBe("mc-ses_123")
    expect(started.terminal.paneId).toBe("11")
    expect(started.followCommand).toBe("zellij attach mc-ses_123")

    expect(registry.list({ sessionId: "ses_123", status: "running" })).toHaveLength(1)

    const read = await registry.read(started.terminal.id, { offset: 1, limit: 1 })
    expect(read.lines).toEqual(["line 2"])
    expect(read.hasMore).toBe(true)

    await registry.send(started.terminal.id, { text: "hello", keys: ["Enter"] })
    await registry.cancel(started.terminal.id, { closePane: true })

    expect(calls.some((call) => call.includes("write-chars") && call.includes("hello"))).toBe(true)
    expect(calls.some((call) => call.includes("send-keys") && call.includes("Enter"))).toBe(true)
    expect(calls.some((call) => call.includes("close-pane"))).toBe(true)
    expect(notices[0]).toContain('<terminal id="')
    expect(notices[0]).toContain('state="cancelled"')
    registry.dispose()
  })

  test("cancel preserves pane by default", async () => {
    const calls: string[][] = []
    const registry = new MissionControlTerminalRegistry(new ZellijAdapter(async (argv) => {
      calls.push(argv)
      if (argv.includes("list-panes")) {
        return { stdout: '[{"pane_id":13}]', stderr: "", exitCode: 0 }
      }
      if (argv.includes("dump-screen")) {
        return { stdout: "preview", stderr: "", exitCode: 0 }
      }
      return { stdout: "pane id 13", stderr: "", exitCode: 0 }
    }), {
      debug: async () => undefined,
      injectSyntheticText: async () => ({ ok: true }),
    } as any)

    const started = await registry.start({ sessionId: "ses_default_cancel", command: ["sleep", "10"] })
    await registry.cancel(started.terminal.id)

    expect(calls.some((call) => call.includes("close-pane"))).toBe(false)
    expect(calls.some((call) => call.includes("send-keys") && call.includes("Ctrl c"))).toBe(true)
    registry.dispose()
  })

  test("cancel returns completed terminal without overwriting status", async () => {
    let sentinel = ""
    const calls: string[][] = []
    const registry = new MissionControlTerminalRegistry(new ZellijAdapter(async (argv) => {
      calls.push(argv)
      if (argv.includes("list-panes")) {
        return { stdout: '[{"pane_id":14}]', stderr: "", exitCode: 0 }
      }
      if (argv.includes("new-pane")) {
        const idx = argv.indexOf("mc-terminal")
        if (idx >= 0) {
          sentinel = argv[idx + 1]!
        }
        return { stdout: "pane id 14", stderr: "", exitCode: 0 }
      }
      if (argv.includes("dump-screen")) {
        return { stdout: "already done", stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    }), {
      debug: async () => undefined,
      injectSyntheticText: async () => ({ ok: true }),
    } as any)

    const started = await registry.start({ sessionId: "ses_completed_cancel", command: ["true"] })
    await writeFile(sentinel, "0")

    const cancelled = await registry.cancel(started.terminal.id, { closePane: true })

    expect(cancelled.terminal.status).toBe("completed")
    expect(cancelled.terminal.exitCode).toBe(0)
    expect(calls.some((call) => call.includes("send-keys") && call.includes("Ctrl c"))).toBe(false)
    expect(calls.some((call) => call.includes("close-pane"))).toBe(false)
    registry.dispose()
  })

  test("marks a terminal completed when the sentinel file appears", async () => {
    let sentinel = ""
    const runner: ZellijRunner = async (argv) => {
      if (argv.includes("list-panes")) {
        return { stdout: '[{"pane_id":12}]', stderr: "", exitCode: 0 }
      }
      if (argv.includes("new-pane")) {
        const idx = argv.indexOf("mc-terminal")
        if (idx >= 0) {
          sentinel = argv[idx + 1]!
        }
        return { stdout: "pane id 12", stderr: "", exitCode: 0 }
      }
      if (argv.includes("dump-screen")) {
        return { stdout: "done", stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    }
    const notices: string[] = []
    const registry = new MissionControlTerminalRegistry(new ZellijAdapter(runner), {
      debug: async () => undefined,
      injectSyntheticText: async (_sessionId: string, text: string) => {
        notices.push(text)
        return { ok: true }
      },
    } as any)

    const started = await registry.start({ sessionId: "ses_456", command: ["true"] })
    await writeFile(sentinel, "0")

    const inspected = await registry.get(started.terminal.id)
    expect(inspected.terminal.status).toBe("completed")
    expect(inspected.terminal.exitCode).toBe(0)
    expect(notices[0]).toContain('state="completed"')
    registry.dispose()
  })
})
