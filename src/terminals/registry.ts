import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { OpenCodeAdapter } from "../opencode-client.js"
import {
  getPreferredPanes,
  normalizePaneID,
  validateRunArgs,
  validateSessionName,
  ZellijAdapter,
} from "./zellij.js"

export type TerminalStatus = "running" | "completed" | "cancelled" | "error"

export interface TerminalRecord {
  id: string
  ownerSessionId: string
  zellijSessionName: string
  paneId: string
  status: TerminalStatus
  command: string[] | string
  cwd?: string
  title?: string
  floating: boolean
  startedAt: number
  updatedAt: number
  exitCode?: number
  error?: string
  sentinelPath: string
  notified: boolean
}

export interface TerminalStartArgs {
  sessionId?: string
  command?: string[]
  commandString?: string
  cwd?: string
  title?: string
  label?: string
  floating?: boolean
  direction?: "right" | "down"
  inPlace?: boolean
  closeOnExit?: boolean
  startSuspended?: boolean
  sessionName?: string
}

export class TerminalNotFoundError extends Error {
  readonly code = "TerminalNotFound"

  constructor(readonly terminalId: string) {
    super(`Unknown terminal id: ${terminalId}`)
    this.name = "TerminalNotFoundError"
  }
}

export class MissionControlTerminalRegistry {
  private readonly terminals = new Map<string, TerminalRecord>()
  private counter = 0
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(
    private readonly adapter: ZellijAdapter,
    private opencode: OpenCodeAdapter,
    private readonly options: { pollIntervalMs?: number; previewChars?: number } = {},
  ) {}

  setOpenCodeAdapter(opencode: OpenCodeAdapter) {
    this.opencode = opencode
  }

  async start(args: TerminalStartArgs) {
    const ownerSessionId = args.sessionId
    if (!ownerSessionId) {
      throw new Error("mc_terminal_start requires a session id: pass sessionId or call from a session context")
    }
    const command = normalizeCommand(args)
    validateRunArgs({ floating: args.floating, inPlace: args.inPlace, direction: args.direction })
    const terminalId = `term_${Date.now().toString(36)}_${(++this.counter).toString(36)}`
    const zellijSessionName = args.sessionName
      ? validateSessionName(args.sessionName)
      : terminalSessionName(ownerSessionId)
    const sentinelDir = await mkdtemp(join(tmpdir(), "mc-terminal-"))
    const sentinelPath = join(sentinelDir, "exit-code")
    const title = args.title ?? args.label ?? terminalId

    await this.adapter.ensureBackgroundSession(zellijSessionName)
    const pane = await this.adapter.newPane({
      sessionName: zellijSessionName,
      command: wrapCommandForSentinel(command, sentinelPath),
      cwd: args.cwd,
      title,
      floating: Boolean(args.floating),
      direction: args.direction,
      inPlace: args.inPlace,
      closeOnExit: args.closeOnExit,
      startSuspended: args.startSuspended,
    })
    const paneId = pane.paneId

    const now = Date.now()
    const record: TerminalRecord = {
      id: terminalId,
      ownerSessionId,
      zellijSessionName,
      paneId,
      status: "running",
      command: typeof args.commandString === "string" ? args.commandString : command,
      cwd: args.cwd,
      title,
      floating: Boolean(args.floating),
      startedAt: now,
      updatedAt: now,
      sentinelPath,
      notified: false,
    }

    this.terminals.set(terminalId, record)
    this.ensurePolling()

    return {
      terminal: this.toPublicRecord(record),
      followCommand: `zellij attach ${shellQuote(zellijSessionName)}`,
      appliedDirection: pane.appliedDirection,
      ...(pane.warning ? { warning: pane.warning } : {}),
    }
  }

  list(filters: { sessionId?: string; status?: TerminalStatus } = {}) {
    return [...this.terminals.values()]
      .filter((record) => !filters.sessionId || record.ownerSessionId === filters.sessionId)
      .filter((record) => !filters.status || record.status === filters.status)
      .map((record) => this.toPublicRecord(record))
  }

  async get(id: string) {
    const record = this.requireRecord(id)
    await this.refreshRecord(record)
    return {
      terminal: this.toPublicRecord(record),
      preview: await this.preview(record),
    }
  }

  async read(id: string, options: { offset?: number; limit?: number; ansi?: boolean } = {}) {
    const record = this.requireRecord(id)
    await this.refreshRecord(record)
    const output = await this.adapter.capturePane(record.zellijSessionName, record.paneId, { full: true, ansi: options.ansi })
    const lines = output.split(/\r?\n/)
    const offset = Math.max(0, Math.floor(options.offset ?? 0))
    const limit = Math.max(1, Math.floor(options.limit ?? 200))
    const page = lines.slice(offset, offset + limit)
    return {
      terminal: this.toPublicRecord(record),
      offset,
      limit,
      lines: page,
      hasMore: offset + limit < lines.length,
      nextOffset: offset + limit < lines.length ? offset + limit : undefined,
      totalLines: lines.length,
    }
  }

  async send(id: string, args: { text?: string; keys?: string[] }) {
    const record = this.requireRecord(id)
    if (args.text) {
      await this.adapter.sendText(record.zellijSessionName, record.paneId, args.text)
    }
    for (const key of args.keys ?? []) {
      await this.adapter.sendKey(record.zellijSessionName, record.paneId, key)
    }
    record.updatedAt = Date.now()
    return { terminal: this.toPublicRecord(record), sent: { text: args.text?.length ?? 0, keys: args.keys ?? [] } }
  }

  async cancel(id: string, options: { closePane?: boolean; ctrlC?: boolean } = {}) {
    const record = this.requireRecord(id)
    await this.refreshRecord(record)
    if (record.status !== "running") {
      return { terminal: this.toPublicRecord(record) }
    }
    if (options.ctrlC ?? true) {
      await this.adapter.sendKey(record.zellijSessionName, record.paneId, "Ctrl c")
    }
    const previewBeforeClose = options.closePane === true ? await this.preview(record).catch(() => "") : undefined
    if (options.closePane === true) {
      await this.adapter.closePane(record.zellijSessionName, record.paneId)
    }
    record.status = "cancelled"
    record.updatedAt = Date.now()
    await this.notify(record, previewBeforeClose)
    return { terminal: this.toPublicRecord(record) }
  }

  resolveZellijSessionName(args: { session?: string; sessionId?: string }): string {
    if (args.session) {
      return validateSessionName(args.session)
    }
    if (args.sessionId) {
      return terminalSessionName(args.sessionId)
    }
    throw new Error(
      "Live Zellij inspection requires a session: pass an explicit session name, a sessionId, or call from a session context",
    )
  }

  async listPanesLive(args: { session?: string; sessionId?: string; all?: boolean }) {
    const name = this.resolveZellijSessionName(args)
    const panes = await this.adapter.listNormalizedPanes(name, { all: args.all })
    const focusedPaneIDs = getPreferredPanes(panes).map((pane) => pane.paneID)
    return {
      session: name,
      paneCount: panes.length,
      focusedPaneID: focusedPaneIDs.length === 1 ? focusedPaneIDs[0]! : null,
      focusedPaneIDs,
      panes,
    }
  }

  async capturePaneLive(args: {
    session?: string
    sessionId?: string
    paneId?: string
    full?: boolean
    ansi?: boolean
  }) {
    const name = this.resolveZellijSessionName(args)
    const resolvedPane = args.paneId ? normalizePaneID(args.paneId) : null
    const content = await this.adapter.captureByPane(name, resolvedPane, { full: args.full, ansi: args.ansi })
    return {
      session: name,
      paneId: resolvedPane,
      full: Boolean(args.full),
      ansi: Boolean(args.ansi),
      content,
    }
  }

  async listZellijSessions() {
    const sessions = await this.adapter.listSessions()
    return {
      count: sessions.length,
      currentSession: sessions.find((session) => session.current)?.name ?? null,
      sessions,
    }
  }

  dispose() {
    this.disposed = true
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  private ensurePolling() {
    if (this.pollTimer || this.disposed) {
      return
    }
    this.pollTimer = setInterval(() => {
      void this.poll().catch((error) => this.opencode.debug("terminal poll failed", { error: stringifyError(error) }))
    }, this.options.pollIntervalMs ?? 2000)
  }

  private async poll() {
    const running = [...this.terminals.values()].filter((record) => record.status === "running")
    if (running.length === 0) {
      if (this.pollTimer) {
        clearInterval(this.pollTimer)
        this.pollTimer = undefined
      }
      return
    }

    await Promise.all(running.map((record) => this.refreshRecord(record)))
  }

  private async refreshRecord(record: TerminalRecord) {
    if (record.status !== "running") {
      return
    }
    try {
      const raw = await readFile(record.sentinelPath, "utf8")
      const exitCode = Number.parseInt(raw.trim(), 10)
      if (Number.isFinite(exitCode)) {
        record.exitCode = exitCode
        record.status = exitCode === 0 ? "completed" : "error"
        record.error = exitCode === 0 ? undefined : `Command exited with code ${exitCode}`
        record.updatedAt = Date.now()
        await this.notify(record)
      }
    } catch {
      // No sentinel yet: still running.
    }
  }

  private async notify(record: TerminalRecord, previewOverride?: string) {
    if (record.notified) {
      return
    }
    record.notified = true
    const preview = previewOverride ?? await this.preview(record).catch(() => "")
    const summary = record.status === "completed"
      ? `Terminal ${record.id} completed${typeof record.exitCode === "number" ? ` with exit code ${record.exitCode}` : ""}.`
      : record.status === "cancelled"
        ? `Terminal ${record.id} was cancelled.`
        : `Terminal ${record.id} ended with an error${record.error ? `: ${record.error}` : ""}.`
    const text = `<terminal id="${escapeAttribute(record.id)}" state="${record.status}">\n${summary}\n\n${preview}\n</terminal>`
    await this.opencode.injectSyntheticText(record.ownerSessionId, text)
    await rm(dirname(record.sentinelPath), { recursive: true, force: true }).catch(() => undefined)
  }

  private async preview(record: TerminalRecord) {
    const output = await this.adapter.capturePane(record.zellijSessionName, record.paneId, { full: false })
    const max = this.options.previewChars ?? 4000
    return output.length > max ? output.slice(-max) : output
  }

  private requireRecord(id: string) {
    const record = this.terminals.get(id)
    if (!record) {
      throw new TerminalNotFoundError(id)
    }
    return record
  }

  private toPublicRecord(record: TerminalRecord) {
    return {
      id: record.id,
      sessionId: record.ownerSessionId,
      zellijSessionName: record.zellijSessionName,
      paneId: record.paneId,
      status: record.status,
      command: record.command,
      cwd: record.cwd,
      title: record.title,
      floating: record.floating,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      exitCode: record.exitCode,
      error: record.error,
      followCommand: `zellij attach ${shellQuote(record.zellijSessionName)}`,
    }
  }
}

const normalizeCommand = (args: TerminalStartArgs) => {
  if (Array.isArray(args.command) && args.command.length > 0) {
    return args.command
  }
  if (typeof args.commandString === "string" && args.commandString.trim()) {
    return ["sh", "-lc", args.commandString]
  }
  throw new Error("mc_terminal_start requires command argv or commandString")
}

const wrapCommandForSentinel = (command: string[], sentinelPath: string) => [
  "sh",
  "-lc",
  'sentinel=$1; shift; "$@"; code=$?; printf "%s" "$code" > "$sentinel"; exit "$code"',
  "mc-terminal",
  sentinelPath,
  ...command,
]

export const terminalSessionName = (sessionId: string) =>
  `mc-${sessionId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80)}`

const shellQuote = (value: string) => /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
const stringifyError = (error: unknown) => error instanceof Error ? error.message : String(error)
