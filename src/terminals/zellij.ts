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

  async listPanes(sessionName: string): Promise<ZellijPane[]> {
    const result = await this.run(["--session", sessionName, "action", "list-panes", "--json", "--all"])
    return parsePaneList(result.stdout)
  }

  async newPane(args: {
    sessionName: string
    command: string[]
    cwd?: string
    title?: string
    floating?: boolean
  }): Promise<string> {
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
    argv.push("--", ...args.command)

    const result = await this.run(argv)
    const directPaneId = parsePaneId(result.stdout) ?? parsePaneId(result.stderr)
    if (directPaneId) {
      return directPaneId
    }

    const after = await this.tryListPaneIds(args.sessionName)
    const created = [...after].find((paneId) => !before.has(paneId))
    if (created) {
      return created
    }

    throw new Error("Zellij created a pane but did not report a pane id")
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
      return new Set((await this.listPanes(sessionName)).map((pane) => pane.paneId))
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
