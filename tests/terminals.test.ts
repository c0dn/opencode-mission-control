import { writeFile } from "node:fs/promises"

import { describe, expect, test } from "bun:test"

import { MissionControlTerminalRegistry } from "../src/terminals/registry.ts"
import {
  getPreferredPane,
  normalizePaneID,
  normalizePanes,
  parsePaneList,
  parseSessionList,
  validateRunArgs,
  validateSessionName,
  ZellijAdapter,
  type ZellijRunner,
} from "../src/terminals/zellij.ts"

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
    const pane = await adapter.newPane({
      sessionName: "mc-ses-1",
      command: ["bun", "test"],
      cwd: "/tmp/project",
      title: "tests",
      floating: true,
    })

    expect(pane.paneId).toBe("7")
    expect(pane.appliedDirection).toBeNull()
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

  test("listNormalizedPanes includes --all by default and omits it when all is false", async () => {
    const calls: string[][] = []
    const adapter = new ZellijAdapter(async (argv) => {
      calls.push(argv)
      return { stdout: "[]", stderr: "", exitCode: 0 }
    })

    await adapter.listNormalizedPanes("mc-ses-1")
    await adapter.listNormalizedPanes("mc-ses-1", { all: false })

    expect(calls[0]).toEqual(["--session", "mc-ses-1", "action", "list-panes", "--json", "--all"])
    expect(calls[1]).toEqual(["--session", "mc-ses-1", "action", "list-panes", "--json"])
  })

  test("parses zellij terminal pane ids", async () => {
    const adapter = new ZellijAdapter(async (argv) => {
      if (argv.includes("list-panes")) {
        return { stdout: "[]", stderr: "", exitCode: 0 }
      }
      return { stdout: "terminal_42", stderr: "", exitCode: 0 }
    })

    await expect(adapter.newPane({ sessionName: "mc-ses-1", command: ["true"] })).resolves.toMatchObject({ paneId: "42" })
  })

  test("newPane appends run-option flags in order", async () => {
    let newPaneArgv: string[] = []
    const adapter = new ZellijAdapter(async (argv) => {
      if (argv.includes("list-panes")) {
        return { stdout: newPaneArgv.length === 0 ? "[]" : '[{"pane_id":21}]', stderr: "", exitCode: 0 }
      }
      if (argv.includes("new-pane")) {
        newPaneArgv = argv
        return { stdout: "", stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    })

    const pane = await adapter.newPane({
      sessionName: "mc-ses-1",
      command: ["bash"],
      cwd: "/tmp",
      title: "dbg",
      closeOnExit: true,
      startSuspended: true,
      direction: "right",
    })

    expect(pane.paneId).toBe("21")
    expect(pane.appliedDirection).toBe("right")
    expect(newPaneArgv).toEqual([
      "--session", "mc-ses-1", "action", "new-pane",
      "--cwd", "/tmp",
      "--name", "dbg",
      "--close-on-exit",
      "--start-suspended",
      "--direction", "right",
      "--", "bash",
    ])
  })

  test("newPane includes --in-place when requested", async () => {
    let newPaneArgv: string[] = []
    const adapter = new ZellijAdapter(async (argv) => {
      if (argv.includes("list-panes")) {
        return { stdout: newPaneArgv.length === 0 ? "[]" : '[{"pane_id":22}]', stderr: "", exitCode: 0 }
      }
      if (argv.includes("new-pane")) {
        newPaneArgv = argv
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    })

    await adapter.newPane({ sessionName: "mc-ses-1", command: ["bash"], inPlace: true })
    expect(newPaneArgv).toContain("--in-place")
    expect(newPaneArgv).not.toContain("--direction")
  })

  test("directed newPane does not retry without --direction when pane id is undiscoverable", async () => {
    const newPaneCalls: string[][] = []
    // list-panes always returns the same set so the before/after diff is empty -> no discovered id.
    const adapter = new ZellijAdapter(async (argv) => {
      if (argv.includes("list-panes")) {
        return { stdout: '[{"pane_id":30}]', stderr: "", exitCode: 0 }
      }
      if (argv.includes("new-pane")) {
        newPaneCalls.push(argv)
        // No pane id in stdout/stderr, and the diff is empty -> undefined paneId.
        return { stdout: "", stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    })

    await expect(
      adapter.newPane({ sessionName: "mc-ses-1", command: ["gdb"], direction: "down" }),
    ).rejects.toThrow(/did not report a pane id/)

    // Do not retry: a successful directed new-pane may already have created a pane.
    expect(newPaneCalls).toHaveLength(1)
    expect(newPaneCalls[0]).toContain("--direction")
  })

  test("directed newPane propagates Zellij command failures without fallback", async () => {
    const newPaneCalls: string[][] = []
    const adapter = new ZellijAdapter(async (argv) => {
      if (argv.includes("list-panes")) {
        return { stdout: "[]", stderr: "", exitCode: 0 }
      }
      if (argv.includes("new-pane")) {
        newPaneCalls.push(argv)
        return { stdout: "", stderr: "split failed", exitCode: 1 }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    })

    await expect(
      adapter.newPane({ sessionName: "mc-ses-1", command: ["gdb"], direction: "down" }),
    ).rejects.toThrow(/zellij --session failed/)
    expect(newPaneCalls).toHaveLength(1)
    expect(newPaneCalls[0]).toContain("--direction")
  })

  test("validateRunArgs rejects incompatible run options", () => {
    expect(() => validateRunArgs({ direction: "right", floating: true })).toThrow(/direction cannot be combined with floating/)
    expect(() => validateRunArgs({ direction: "down", inPlace: true })).toThrow(/direction cannot be combined with inPlace/)
    expect(() => validateRunArgs({ floating: true, inPlace: true })).toThrow(/floating cannot be combined with inPlace/)
    expect(() => validateRunArgs({ floating: true })).not.toThrow()
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

  test("normalizePanes maps zellij JSON fields and getPreferredPane picks the focused terminal pane", () => {
    const panes = normalizePanes([
      { pane_id: 0, is_plugin: true, is_focused: true, is_selectable: true, is_floating: false, exited: false, title: "plugin" },
      { paneId: 5, is_plugin: false, is_focused: false, is_selectable: true, is_floating: false, exited: false, title: "old" },
      { id: 9, is_plugin: false, is_focused: true, is_selectable: true, is_floating: false, exited: false, title: "active", pane_command: "bash", pane_cwd: "/tmp" },
      { id: "not-a-number", is_plugin: false, is_focused: true, is_selectable: true },
      { is_plugin: false, is_focused: true, is_selectable: true },
    ])

    expect(panes).toHaveLength(3)
    expect(panes[0]!.paneID).toBe("plugin_0")
    expect(panes[1]!.paneID).toBe("terminal_5")
    expect(panes[2]!).toMatchObject({ paneID: "terminal_9", isPlugin: false, focused: true, paneCommand: "bash", cwd: "/tmp" })
    expect(getPreferredPane(panes)?.paneID).toBe("terminal_9")
  })

  test("getPreferredPane skips exited/plugin/floating panes via fallback chain", () => {
    const panes = normalizePanes([
      { id: 1, is_plugin: false, is_focused: true, is_selectable: true, is_floating: false, exited: true },
      { id: 2, is_plugin: false, is_focused: false, is_selectable: true, is_floating: true, exited: false },
      { id: 3, is_plugin: false, is_focused: false, is_selectable: true, is_floating: false, exited: false },
    ])
    expect(getPreferredPane(panes)?.paneID).toBe("terminal_3")
  })

  test("validateSessionName and normalizePaneID enforce the standalone contracts", () => {
    expect(validateSessionName("mc-ses_1")).toBe("mc-ses_1")
    expect(() => validateSessionName("bad name")).toThrow(/Invalid session name/)
    expect(normalizePaneID("11")).toBe("terminal_11")
    expect(normalizePaneID("plugin_4")).toBe("plugin_4")
    expect(() => normalizePaneID("nope")).toThrow(/Invalid pane ID/)
  })

  test("listSessions parses (current) flag tolerantly", async () => {
    const adapter = new ZellijAdapter(async (argv) => {
      expect(argv).toEqual(["list-sessions"])
      return { stdout: "mc-ses_1 [created]\nmc-ses_2 (current)", stderr: "", exitCode: 0 }
    })
    const sessions = await adapter.listSessions()
    expect(sessions).toEqual([
      { name: "mc-ses_1", current: false, raw: "mc-ses_1 [created]" },
      { name: "mc-ses_2", current: true, raw: "mc-ses_2 (current)" },
    ])
  })

  test("listSessions tolerates non-zero exit (no sessions) without throwing", async () => {
    const adapter = new ZellijAdapter(async () => ({ stdout: "", stderr: "No active zellij sessions found.", exitCode: 1 }))
    await expect(adapter.listSessions()).resolves.toEqual([])
  })

  test("listSessions throws command errors for non-zero zellij failures", async () => {
    const adapter = new ZellijAdapter(async () => ({ stdout: "partial", stderr: "permission denied", exitCode: 2 }))
    await expect(adapter.listSessions()).rejects.toThrow(/zellij list-sessions failed/)
  })

  test("parseSessionList strips ANSI styling", () => {
    expect(parseSessionList("\x1B[32mmc-ses_1\x1B[0m (current)")).toEqual([
      { name: "mc-ses_1", current: true, raw: "mc-ses_1 (current)" },
    ])
  })

  test("captureByPane builds dump-screen argv and omits --pane-id when null", async () => {
    const calls: string[][] = []
    const adapter = new ZellijAdapter(async (argv) => {
      calls.push(argv)
      return { stdout: "screen", stderr: "", exitCode: 0 }
    })

    await adapter.captureByPane("mc-ses_1", "terminal_9", { full: true, ansi: true })
    await adapter.captureByPane("mc-ses_1", null)

    expect(calls[0]).toEqual([
      "--session", "mc-ses_1", "action", "dump-screen", "--pane-id", "terminal_9", "--full", "--ansi",
    ])
    expect(calls[1]).toEqual(["--session", "mc-ses_1", "action", "dump-screen"])
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

  test("start throws a clear error when no owner session id is available", async () => {
    const registry = new MissionControlTerminalRegistry(
      new ZellijAdapter(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      { debug: async () => undefined, injectSyntheticText: async () => ({ ok: true }) } as any,
    )

    await expect(registry.start({ command: ["true"] } as any)).rejects.toThrow(
      /requires a session id/,
    )
    registry.dispose()
  })

  test("explicit sessionName overrides the derived zellij session while notify owner stays the session id", async () => {
    let sentinel = ""
    const notifyTargets: string[] = []
    const calls: string[][] = []
    const registry = new MissionControlTerminalRegistry(
      new ZellijAdapter(async (argv) => {
        calls.push(argv)
        if (argv.includes("list-panes")) {
          return { stdout: '[{"pane_id":40}]', stderr: "", exitCode: 0 }
        }
        if (argv.includes("new-pane")) {
          const idx = argv.indexOf("mc-terminal")
          if (idx >= 0) sentinel = argv[idx + 1]!
          return { stdout: "pane id 40", stderr: "", exitCode: 0 }
        }
        if (argv.includes("dump-screen")) {
          return { stdout: "done", stderr: "", exitCode: 0 }
        }
        return { stdout: "", stderr: "", exitCode: 0 }
      }),
      {
        debug: async () => undefined,
        injectSyntheticText: async (sessionId: string) => {
          notifyTargets.push(sessionId)
          return { ok: true }
        },
      } as any,
    )

    const started = await registry.start({
      sessionId: "ses_owner",
      sessionName: "debug-lab",
      command: ["true"],
    })

    expect(started.terminal.zellijSessionName).toBe("debug-lab")
    expect(started.terminal.sessionId).toBe("ses_owner")
    expect(calls.some((call) => call.includes("debug-lab"))).toBe(true)
    expect(calls.every((call) => !call.includes("mc-ses_owner"))).toBe(true)

    await writeFile(sentinel, "0")
    await registry.get(started.terminal.id)
    expect(notifyTargets).toEqual(["ses_owner"])
    registry.dispose()
  })

  test("start rejects incompatible run options before creating a pane", async () => {
    const calls: string[][] = []
    const registry = new MissionControlTerminalRegistry(
      new ZellijAdapter(async (argv) => {
        calls.push(argv)
        return { stdout: "", stderr: "", exitCode: 0 }
      }),
      { debug: async () => undefined, injectSyntheticText: async () => ({ ok: true }) } as any,
    )

    await expect(
      registry.start({ sessionId: "ses_x", command: ["true"], direction: "right", floating: true }),
    ).rejects.toThrow(/cannot be combined/)
    expect(calls.some((call) => call.includes("new-pane"))).toBe(false)
    registry.dispose()
  })

  test("threads run-option flags from start into newPane argv", async () => {
    let newPaneArgv: string[] = []
    const registry = new MissionControlTerminalRegistry(
      new ZellijAdapter(async (argv) => {
        if (argv.includes("list-panes")) {
          return { stdout: newPaneArgv.length === 0 ? "[]" : '[{"pane_id":41}]', stderr: "", exitCode: 0 }
        }
        if (argv.includes("new-pane")) {
          newPaneArgv = argv
          return { stdout: "", stderr: "", exitCode: 0 }
        }
        return { stdout: "", stderr: "", exitCode: 0 }
      }),
      { debug: async () => undefined, injectSyntheticText: async () => ({ ok: true }) } as any,
    )

    await registry.start({
      sessionId: "ses_flags",
      command: ["bash"],
      closeOnExit: true,
      startSuspended: true,
      direction: "down",
    })

    expect(newPaneArgv).toContain("--close-on-exit")
    expect(newPaneArgv).toContain("--start-suspended")
    expect(newPaneArgv).toContain("--direction")
    expect(newPaneArgv[newPaneArgv.indexOf("--direction") + 1]).toBe("down")
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

  test("listPanesLive resolves an owner sessionId to the mc-<id> zellij session", async () => {
    const calls: string[][] = []
    const registry = new MissionControlTerminalRegistry(
      new ZellijAdapter(async (argv) => {
        calls.push(argv)
        return {
          stdout: '[{"pane_id":9,"is_plugin":false,"is_focused":true,"is_selectable":true,"is_floating":false,"exited":false}]',
          stderr: "",
          exitCode: 0,
        }
      }),
      { debug: async () => undefined, injectSyntheticText: async () => ({ ok: true }) } as any,
    )

    const result = await registry.listPanesLive({ sessionId: "ses_77" })
    expect(result.session).toBe("mc-ses_77")
    expect(result.focusedPaneID).toBe("terminal_9")
    expect(result.focusedPaneIDs).toEqual(["terminal_9"])
    expect(calls[0]).toEqual(["--session", "mc-ses_77", "action", "list-panes", "--json", "--all"])
    registry.dispose()
  })

  test("listPanesLive returns all top-priority focused pane ids when multiple tabs report focused panes", async () => {
    const registry = new MissionControlTerminalRegistry(
      new ZellijAdapter(async () => ({
        stdout: JSON.stringify([
          { pane_id: 7, tab_name: "one", is_plugin: false, is_focused: true, is_selectable: true, is_floating: false, exited: false },
          { pane_id: 9, tab_name: "two", is_plugin: false, is_focused: true, is_selectable: true, is_floating: false, exited: false },
          { pane_id: 11, tab_name: "three", is_plugin: false, is_focused: false, is_selectable: true, is_floating: false, exited: false },
        ]),
        stderr: "",
        exitCode: 0,
      })),
      { debug: async () => undefined, injectSyntheticText: async () => ({ ok: true }) } as any,
    )

    const result = await registry.listPanesLive({ session: "mc-ses_77" })
    expect(result.focusedPaneIDs).toEqual(["terminal_7", "terminal_9"])
    expect(result.focusedPaneID).toBeNull()
    registry.dispose()
  })

  test("listPanesLive omits --all when all is false", async () => {
    const calls: string[][] = []
    const registry = new MissionControlTerminalRegistry(
      new ZellijAdapter(async (argv) => {
        calls.push(argv)
        return { stdout: "[]", stderr: "", exitCode: 0 }
      }),
      { debug: async () => undefined, injectSyntheticText: async () => ({ ok: true }) } as any,
    )

    await registry.listPanesLive({ session: "mc-ses_77", all: false })
    expect(calls[0]).toEqual(["--session", "mc-ses_77", "action", "list-panes", "--json"])
    registry.dispose()
  })

  test("capturePaneLive normalizes a bare paneId to terminal_<n> in the dump-screen argv", async () => {
    const calls: string[][] = []
    const registry = new MissionControlTerminalRegistry(
      new ZellijAdapter(async (argv) => {
        calls.push(argv)
        return { stdout: "captured", stderr: "", exitCode: 0 }
      }),
      { debug: async () => undefined, injectSyntheticText: async () => ({ ok: true }) } as any,
    )

    const result = await registry.capturePaneLive({ session: "mc-ses_1", paneId: "9", full: true })
    expect(result.paneId).toBe("terminal_9")
    expect(calls[0]).toEqual([
      "--session", "mc-ses_1", "action", "dump-screen", "--pane-id", "terminal_9", "--full",
    ])
    registry.dispose()
  })

  test("capturePaneLive without paneId lets Zellij capture the active pane without listing panes", async () => {
    const calls: string[][] = []
    const registry = new MissionControlTerminalRegistry(
      new ZellijAdapter(async (argv) => {
        calls.push(argv)
        if (argv.includes("list-panes")) {
          throw new Error("capturePaneLive without paneId should not list panes")
        }
        return { stdout: "captured", stderr: "", exitCode: 0 }
      }),
      { debug: async () => undefined, injectSyntheticText: async () => ({ ok: true }) } as any,
    )

    const result = await registry.capturePaneLive({ session: "mc-ses_1", full: true })
    expect(result.paneId).toBeNull()
    expect(calls).toEqual([["--session", "mc-ses_1", "action", "dump-screen", "--full"]])
    registry.dispose()
  })

  test("listZellijSessions reports the current session", async () => {
    const registry = new MissionControlTerminalRegistry(
      new ZellijAdapter(async () => ({ stdout: "mc-a\nmc-b (current)", stderr: "", exitCode: 0 })),
      { debug: async () => undefined, injectSyntheticText: async () => ({ ok: true }) } as any,
    )
    const result = await registry.listZellijSessions()
    expect(result.count).toBe(2)
    expect(result.currentSession).toBe("mc-b")
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
