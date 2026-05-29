export interface ZellijRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

declare const Bun: {
  spawn: (argv: string[], options: { cwd?: string; stdout: "pipe"; stderr: "pipe" }) => {
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    exited: Promise<number>
  }
}

export type ZellijRunner = (argv: string[], options?: { cwd?: string }) => Promise<ZellijRunResult>

export interface ZellijPane {
  paneId: string
  title?: string
  command?: string
  exited?: boolean
  exitStatus?: number | null
}

export interface NormalizedZellijPane {
  paneID: string
  id: number
  isPlugin: boolean
  title: string | null
  focused: boolean
  floating: boolean
  exited: boolean
  selectable: boolean
  tabName: unknown
  paneCommand: unknown
  cwd: unknown
}

export interface ZellijSessionSummary {
  name: string
  current: boolean
  raw: string
}

export interface NewPaneResult {
  paneId: string
  warning?: string
  appliedDirection: "right" | "down" | null
}

const ANSI_PATTERN = /\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g
const SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const PANE_ID_PATTERN = /^(?:terminal_|plugin_)?\d+$/

export const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "")

export const validateSessionName = (session: string): string => {
  if (!SESSION_NAME_PATTERN.test(session)) {
    throw new Error("Invalid session name. Use 1-64 chars from: letters, numbers, dot, underscore, colon, hyphen.")
  }
  return session
}

export const normalizePaneID = (paneID: string): string => {
  if (!PANE_ID_PATTERN.test(paneID)) {
    throw new Error("Invalid pane ID. Use terminal_<n>, plugin_<n>, or a bare integer.")
  }
  return /^\d+$/.test(paneID) ? `terminal_${paneID}` : paneID
}

export const normalizePanes = (panes: Array<Record<string, unknown>>): NormalizedZellijPane[] =>
  panes.flatMap((pane) => {
    const rawId = pane.pane_id ?? pane.paneId ?? pane.id
    const id = typeof rawId === "string" || typeof rawId === "number" ? Number(rawId) : Number.NaN
    if (!Number.isSafeInteger(id) || id < 0) {
      return []
    }

    const isPlugin = Boolean(pane.is_plugin)
    return {
      paneID: `${isPlugin ? "plugin" : "terminal"}_${id}`,
      id,
      isPlugin,
      title: typeof pane.title === "string" ? pane.title : null,
      focused: Boolean(pane.is_focused),
      floating: Boolean(pane.is_floating),
      exited: Boolean(pane.exited),
      selectable: Boolean(pane.is_selectable),
      tabName: pane.tab_name ?? null,
      paneCommand: pane.pane_command ?? pane.terminal_command ?? null,
      cwd: pane.pane_cwd ?? null,
    }
  })

export const validateRunArgs = (args: { floating?: boolean; inPlace?: boolean; direction?: "right" | "down" }): void => {
  if (args.direction && args.floating) {
    throw new Error("direction cannot be combined with floating for mc_terminal_start")
  }
  if (args.direction && args.inPlace) {
    throw new Error("direction cannot be combined with inPlace for mc_terminal_start")
  }
  if (args.floating && args.inPlace) {
    throw new Error("floating cannot be combined with inPlace for mc_terminal_start")
  }
}

export const getPreferredPanes = (panes: NormalizedZellijPane[]): NormalizedZellijPane[] => {
  const buckets = [
    panes.filter((pane) => pane.focused && pane.selectable && !pane.isPlugin && !pane.floating && !pane.exited),
    panes.filter((pane) => pane.focused && pane.selectable && !pane.floating && !pane.exited),
    panes.filter((pane) => pane.focused && pane.selectable && !pane.exited),
    panes.filter((pane) => pane.selectable && !pane.isPlugin && !pane.floating && !pane.exited),
    panes.filter((pane) => pane.selectable && !pane.exited),
  ]
  return buckets.find((bucket) => bucket.length > 0) ?? []
}

export const getPreferredPane = (panes: NormalizedZellijPane[]): NormalizedZellijPane | null =>
  getPreferredPanes(panes)[0] ?? null

export const parseSessionList = (stdout: string): ZellijSessionSummary[] =>
  stripAnsi(stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const name = line.match(/^(\S+)/)?.[1]
      if (!name) {
        return undefined
      }
      return { name, current: line.includes("(current)"), raw: line }
    })
    .filter(Boolean) as ZellijSessionSummary[]

export class ZellijCommandError extends Error {
  constructor(
    message: string,
    readonly argv: string[],
    readonly result: ZellijRunResult,
  ) {
    super(message)
    this.name = "ZellijCommandError"
  }
}

export const bunZellijRunner: ZellijRunner = async (argv, options = {}) => {
  const proc = Bun.spawn(["zellij", ...argv], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

export class ZellijAdapter {
  constructor(private readonly runner: ZellijRunner = bunZellijRunner) {}

  async ensureBackgroundSession(sessionName: string) {
    try {
      await this.run(["attach", "--create-background", sessionName])
    } catch (error) {
      if (isExistingSessionError(error, sessionName)) {
        return
      }
      throw error
    }
  }

  async listPanes(sessionName: string, options: { all?: boolean } = {}): Promise<ZellijPane[]> {
    const result = await this.run(listPanesArgv(sessionName, options))
    return parsePaneList(result.stdout)
  }

  async listNormalizedPanes(sessionName: string, options: { all?: boolean } = {}): Promise<NormalizedZellijPane[]> {
    const result = await this.run(listPanesArgv(sessionName, options))
    const trimmed = result.stdout.trim()
    if (!trimmed) {
      return []
    }
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) {
      return []
    }
    return normalizePanes(parsed as Array<Record<string, unknown>>)
  }

  async listSessions(): Promise<ZellijSessionSummary[]> {
    // list-sessions exits non-zero when there are no sessions; tolerate it.
    const result = await this.runner(["list-sessions"])
    if (result.exitCode !== 0 && !isNoSessionsResult(result)) {
      throw new ZellijCommandError("zellij list-sessions failed", ["list-sessions"], result)
    }
    return parseSessionList(result.stdout)
  }

  async captureByPane(
    sessionName: string,
    paneId: string | null,
    options: { full?: boolean; ansi?: boolean } = {},
  ): Promise<string> {
    const argv = ["--session", sessionName, "action", "dump-screen"]
    if (paneId) {
      argv.push("--pane-id", paneId)
    }
    if (options.full) {
      argv.push("--full")
    }
    if (options.ansi) {
      argv.push("--ansi")
    }
    const result = await this.run(argv)
    return result.stdout
  }

  async newPane(args: {
    sessionName: string
    command: string[]
    cwd?: string
    title?: string
    floating?: boolean
    direction?: "right" | "down"
    inPlace?: boolean
    closeOnExit?: boolean
    startSuspended?: boolean
  }): Promise<NewPaneResult> {
    const requestedDirection = args.direction
    const attempt = await this.tryNewPane(args, requestedDirection)
    if (attempt.paneId) {
      return { paneId: attempt.paneId, appliedDirection: requestedDirection ?? null }
    }

    throw new Error(
      requestedDirection
        ? `Zellij created a pane with --direction ${requestedDirection} but did not report a pane id`
        : "Zellij created a pane but did not report a pane id",
    )
  }

  private async tryNewPane(
    args: {
      sessionName: string
      command: string[]
      cwd?: string
      title?: string
      floating?: boolean
      inPlace?: boolean
      closeOnExit?: boolean
      startSuspended?: boolean
    },
    direction: "right" | "down" | undefined,
  ): Promise<{ paneId: string | undefined }> {
    const before = await this.tryListPaneIds(args.sessionName)
    const argv = ["--session", args.sessionName, "action", "new-pane"]
    if (args.cwd) {
      argv.push("--cwd", args.cwd)
    }
    if (args.title) {
      argv.push("--name", args.title)
    }
    if (args.floating) {
      argv.push("--floating")
    }
    if (args.closeOnExit) {
      argv.push("--close-on-exit")
    }
    if (args.inPlace) {
      argv.push("--in-place")
    }
    if (args.startSuspended) {
      argv.push("--start-suspended")
    }
    if (direction) {
      argv.push("--direction", direction)
    }
    argv.push("--", ...args.command)

    const result = await this.run(argv)
    const directPaneId = parsePaneId(result.stdout) ?? parsePaneId(result.stderr)
    if (directPaneId) {
      return { paneId: directPaneId }
    }

    const after = await this.tryListPaneIds(args.sessionName)
    const created = [...after].find((paneId) => !before.has(paneId))
    return { paneId: created }
  }

  async capturePane(sessionName: string, paneId: string, options: { full?: boolean; ansi?: boolean } = {}) {
    const argv = ["--session", sessionName, "action", "dump-screen", "--pane-id", paneId]
    if (options.full) {
      argv.push("--full")
    }
    if (options.ansi) {
      argv.push("--ansi")
    }
    const result = await this.run(argv)
    return result.stdout
  }

  async sendText(sessionName: string, paneId: string, text: string) {
    await this.run(["--session", sessionName, "action", "write-chars", "--pane-id", paneId, "--", text])
  }

  async sendKey(sessionName: string, paneId: string, key: string) {
    await this.run(["--session", sessionName, "action", "send-keys", "--pane-id", paneId, "--", key])
  }

  async closePane(sessionName: string, paneId: string) {
    await this.run(["--session", sessionName, "action", "close-pane", "--pane-id", paneId])
  }

  private async tryListPaneIds(sessionName: string) {
    try {
      return new Set((await this.listPanes(sessionName, { all: true })).map((pane) => pane.paneId))
    } catch {
      return new Set<string>()
    }
  }

  private async run(argv: string[], options?: { cwd?: string }) {
    const result = await this.runner(argv, options)
    if (result.exitCode !== 0) {
      throw new ZellijCommandError(`zellij ${argv[0] ?? "command"} failed`, argv, result)
    }
    return result
  }
}

const listPanesArgv = (sessionName: string, options: { all?: boolean }) => {
  const argv = ["--session", sessionName, "action", "list-panes", "--json"]
  if (options.all !== false) {
    argv.push("--all")
  }
  return argv
}

const isExistingSessionError = (error: unknown, sessionName: string) => {
  if (!(error instanceof ZellijCommandError)) {
    return false
  }

  const output = `${error.result.stderr}\n${error.result.stdout}`.toLowerCase()
  const normalizedSessionName = sessionName.toLowerCase()
  return (
    output.includes("session") &&
    output.includes("exist") &&
    (output.includes(normalizedSessionName) || output.includes("already exists"))
  )
}

const isNoSessionsResult = (result: ZellijRunResult) => {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase()
  return output.includes("no active zellij sessions") || output.includes("no sessions")
}

export const parsePaneId = (text: string) => {
  const jsonPaneId = text.match(/"pane_?id"\s*:\s*"?([0-9]+)"?/i)?.[1]
  if (jsonPaneId) {
    return jsonPaneId
  }
  const terminalPaneId = text.match(/\bterminal_([0-9]+)\b/i)?.[1]
  if (terminalPaneId) {
    return terminalPaneId
  }
  return text.match(/\b(?:pane(?:\s+id)?|PaneId)[:=\s]+([0-9]+)\b/i)?.[1]
}

export const parsePaneList = (text: string): ZellijPane[] => {
  const trimmed = text.trim()
  if (!trimmed) {
    return []
  }

  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      return parsed.map(normalizePane).filter(Boolean) as ZellijPane[]
    }
  } catch {
    // Fall back to human-readable zellij output.
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => {
      const paneId = parsePaneId(line)
      return paneId ? { paneId, title: line.match(/title[:=]\s*([^,]+)/i)?.[1]?.trim() } : undefined
    })
    .filter(Boolean) as ZellijPane[]
}

const normalizePane = (value: unknown): ZellijPane | undefined => {
  if (!value || typeof value !== "object") {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const paneId = raw.pane_id ?? raw.paneId ?? raw.id
  if (typeof paneId !== "string" && typeof paneId !== "number") {
    return undefined
  }
  return {
    paneId: String(paneId),
    title: typeof raw.title === "string" ? raw.title : typeof raw.name === "string" ? raw.name : undefined,
    command:
      typeof raw.command === "string"
        ? raw.command
        : typeof raw.pane_command === "string"
          ? raw.pane_command
          : undefined,
    exited: typeof raw.exited === "boolean" ? raw.exited : undefined,
    exitStatus: typeof raw.exit_status === "number" || raw.exit_status === null ? raw.exit_status : undefined,
  }
}
