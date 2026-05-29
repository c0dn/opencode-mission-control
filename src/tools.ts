import { tool } from "@opencode-ai/plugin"
import type { ToolResult as PluginToolResult } from "@opencode-ai/plugin"

import { clampResultLimit } from "./config.js"
import { TerminalNotFoundError } from "./terminals/registry.js"
import { ZellijCommandError } from "./terminals/zellij.js"
import type { MissionControlServer } from "./server.js"

const toPluginToolResult = (value: unknown, title: string): PluginToolResult => ({
  title,
  output: JSON.stringify(value, null, 2),
  metadata: value && typeof value === "object" ? (value as Record<string, unknown>) : { value },
})

export const createMissionControlTools = (server: MissionControlServer) => {
  const tools = {
  mc_status: tool({
    description: "Return mission-control runtime status",
    args: {},
    async execute() {
      return toPluginToolResult(await server.status(), "Mission Control Status")
    },
  }),

  mc_session_get: tool({
    description: "Return normalized metadata for one session",
    args: {
      sessionId: tool.schema.string(),
    },
    async execute(args) {
      return toPluginToolResult(await server.getSession(args.sessionId), "Session Metadata")
    },
  }),

  mc_session_find: tool({
    description: "Find sessions by exact title and return metadata candidates",
    args: {
      title: tool.schema.string(),
      scope: tool.schema.enum(["local", "global"]).optional(),
      limit: tool.schema.number().optional(),
    },
    async execute(args) {
      return toPluginToolResult(
        await server.findSessions({
          title: args.title,
          scope: args.scope,
          limit: clampResultLimit(args.limit, server.config),
        }),
        "Session Candidates",
      )
    },
  }),

  mc_session_read: tool({
    description: "Read one session transcript, optionally with children",
    args: {
      sessionId: tool.schema.string(),
      beforeMessageId: tool.schema.string().optional(),
      offset: tool.schema.number().optional(),
      limit: tool.schema.number().optional(),
      withChildren: tool.schema.boolean().optional(),
      withToolOutputs: tool.schema.boolean().optional(),
    },
    async execute(args) {
      return toPluginToolResult(
        await server.readSession(args.sessionId, {
          beforeMessageId: args.beforeMessageId,
          offset: args.offset,
          limit: clampResultLimit(args.limit, server.config),
          withChildren: args.withChildren,
          withToolOutputs: args.withToolOutputs,
        }),
        "Session Transcript",
      )
    },
  }),

  mc_session_tail: tool({
    description: "Return the latest text-only session messages",
    args: {
      sessionId: tool.schema.string(),
      offset: tool.schema.number().optional(),
      limit: tool.schema.number().optional(),
      withChildren: tool.schema.boolean().optional(),
    },
    async execute(args) {
      return toPluginToolResult(
        await server.tailSession(args.sessionId, {
          offset: args.offset,
          limit: clampResultLimit(args.limit, server.config),
          withChildren: args.withChildren,
        }),
        "Session Tail",
      )
    },
  }),

  mc_session_tree: tool({
    description: "Return a session parent-child tree",
    args: {
      sessionId: tool.schema.string(),
      depth: tool.schema.number().optional(),
    },
    async execute(args) {
      return toPluginToolResult(await server.sessionTree(args.sessionId, args.depth ?? 1), "Session Tree")
    },
  }),

  mc_session_abort: tool({
    description: "Abort/cancel an OpenCode session by session ID",
    args: {
      sessionId: tool.schema.string(),
    },
    async execute(args) {
      return toPluginToolResult(await server.abortSession(args.sessionId), "Session Abort")
    },
  }),

  mc_session_send_async: tool({
    description:
      "Queue a message into another OpenCode session without blocking; the target processes it at its next loop boundary",
    args: {
      targetSessionId: tool.schema.string(),
      message: tool.schema.string(),
    },
    async execute(args, context) {
      return toPluginToolResult(
        await server.sendSessionMessageAsync(args.targetSessionId, args.message, (context as any)?.sessionID),
        "Session Message Sent",
      )
    },
  }),

  mc_session_send_interrupt: tool({
    description: "Abort the target OpenCode session, then deliver a message so it takes effect immediately",
    args: {
      targetSessionId: tool.schema.string(),
      message: tool.schema.string(),
    },
    async execute(args, context) {
      return toPluginToolResult(
        await server.sendSessionMessageInterrupt(args.targetSessionId, args.message, (context as any)?.sessionID),
        "Session Interrupt Sent",
      )
    },
  }),

  mc_session_events: tool({
    description: "Return recent events and live status for a session",
    args: {
      sessionId: tool.schema.string(),
      withChildren: tool.schema.boolean().optional(),
      limit: tool.schema.number().optional(),
    },
    async execute(args) {
      return toPluginToolResult(
        await server.observeSession(args.sessionId, {
          withChildren: args.withChildren,
          limit: args.limit,
        }),
        "Session Events",
      )
    },
  }),

  mc_session_search: tool({
    description: "Search indexed session content by query",
    args: {
      query: tool.schema.string(),
      scope: tool.schema.enum(["local", "global"]).optional(),
      exact: tool.schema.boolean().optional(),
      limit: tool.schema.number().optional(),
    },
    async execute(args) {
      return toPluginToolResult(
        await server.searchSessions({
          query: args.query,
          scope: args.scope,
          exact: args.exact,
          limit: clampResultLimit(args.limit, server.config),
        }),
        "Session Search Results",
      )
    },
  }),

  mc_terminal_start: tool({
    description: "Create/reuse a Zellij background session for an owning OpenCode session and run a command in a pane",
    args: {
      sessionId: tool.schema.string().optional(),
      command: tool.schema.array(tool.schema.string()).optional(),
      commandString: tool.schema.string().optional(),
      cwd: tool.schema.string().optional(),
      title: tool.schema.string().optional(),
      label: tool.schema.string().optional(),
      floating: tool.schema.boolean().optional(),
      direction: tool.schema.enum(["right", "down"]).optional(),
      inPlace: tool.schema.boolean().optional(),
      closeOnExit: tool.schema.boolean().optional(),
      startSuspended: tool.schema.boolean().optional(),
      sessionName: tool.schema.string().optional(),
    },
    async execute(args, context) {
      const sessionId = args.sessionId ?? (context as any)?.sessionID
      return toPluginToolResult(
        await terminalResolutionResult(() =>
          server.startTerminal({
            sessionId,
            command: args.command,
            commandString: args.commandString,
            cwd: args.cwd,
            title: args.title,
            label: args.label,
            floating: args.floating,
            direction: args.direction,
            inPlace: args.inPlace,
            closeOnExit: args.closeOnExit,
            startSuspended: args.startSuspended,
            sessionName: args.sessionName,
          }),
        ),
        "Terminal Started",
      )
    },
  }),

  mc_terminal_list: tool({
    description: "List plugin-known Zellij terminals, optionally filtered by owner session or status",
    args: {
      sessionId: tool.schema.string().optional(),
      status: tool.schema.enum(["running", "completed", "cancelled", "error"]).optional(),
    },
    async execute(args) {
      return toPluginToolResult(await server.listTerminals(args), "Terminal List")
    },
  }),

  mc_terminal_get: tool({
    description: "Inspect one Zellij terminal and return a small output preview",
    args: {
      terminalId: tool.schema.string(),
    },
    async execute(args) {
      return toPluginToolResult(
        await terminalToolResult(args.terminalId, () => server.getTerminal(args.terminalId)),
        "Terminal",
      )
    },
  }),

  mc_terminal_read: tool({
    description: "Read a Zellij terminal scrollback with offset/limit paging",
    args: {
      terminalId: tool.schema.string(),
      offset: tool.schema.number().optional(),
      limit: tool.schema.number().optional(),
      ansi: tool.schema.boolean().optional(),
    },
    async execute(args) {
      return toPluginToolResult(
        await terminalToolResult(args.terminalId, () => server.readTerminal(args.terminalId, {
          offset: args.offset,
          limit: clampResultLimit(args.limit, server.config),
          ansi: args.ansi,
        })),
        "Terminal Scrollback",
      )
    },
  }),

  mc_terminal_send: tool({
    description: "Send text and/or key chords to a Zellij terminal pane",
    args: {
      terminalId: tool.schema.string(),
      text: tool.schema.string().optional(),
      keys: tool.schema.array(tool.schema.string()).optional(),
    },
    async execute(args) {
      return toPluginToolResult(
        await terminalToolResult(args.terminalId, () => server.sendTerminal(args.terminalId, {
          text: args.text,
          keys: args.keys,
        })),
        "Terminal Input Sent",
      )
    },
  }),

  mc_terminal_cancel: tool({
    description: "Cancel a Zellij terminal by sending Ctrl-C; optionally close the pane with closePane true",
    args: {
      terminalId: tool.schema.string(),
      ctrlC: tool.schema.boolean().optional(),
      closePane: tool.schema.boolean().optional(),
    },
    async execute(args) {
      return toPluginToolResult(
        await terminalToolResult(args.terminalId, () => server.cancelTerminal(args.terminalId, {
          ctrlC: args.ctrlC,
          closePane: args.closePane,
        })),
        "Terminal Cancelled",
      )
    },
  }),

  mc_terminal_panes: tool({
    description:
      "List normalized panes for a live Zellij session (by explicit name or owner session) with the preferred focused pane id",
    args: {
      session: tool.schema.string().optional(),
      sessionId: tool.schema.string().optional(),
      all: tool.schema.boolean().optional(),
    },
    async execute(args, context) {
      const sessionId = args.sessionId ?? (context as any)?.sessionID
      return toPluginToolResult(
        await terminalResolutionResult(() => server.listTerminalPanes({ session: args.session, sessionId, all: args.all })),
        "Terminal Panes",
      )
    },
  }),

  mc_terminal_capture: tool({
    description:
      "Capture a live Zellij pane by session + paneId (or the focused pane) without a Mission Control terminal id",
    args: {
      session: tool.schema.string().optional(),
      sessionId: tool.schema.string().optional(),
      paneId: tool.schema.string().optional(),
      full: tool.schema.boolean().optional(),
      ansi: tool.schema.boolean().optional(),
    },
    async execute(args, context) {
      const sessionId = args.sessionId ?? (context as any)?.sessionID
      return toPluginToolResult(
        await terminalResolutionResult(() =>
          server.captureTerminalPane({
            session: args.session,
            sessionId,
            paneId: args.paneId,
            full: args.full,
            ansi: args.ansi,
          }),
        ),
        "Terminal Pane Capture",
      )
    },
  }),

  mc_terminal_sessions: tool({
    description: "List local Zellij sessions, flagging the current session",
    args: {},
    async execute() {
      return toPluginToolResult(
        await terminalResolutionResult(() => server.listZellijSessions()),
        "Zellij Sessions",
      )
    },
  }),
  }

  return tools
}

const terminalToolResult = async (terminalId: string, action: () => Promise<unknown>) => {
  try {
    return await action()
  } catch (error) {
    if (isTerminalNotFound(error)) {
      return {
        ok: false,
        error: {
          code: "TerminalNotFound",
          message: `Unknown terminal id: ${terminalId}`,
          suggestion: "Use mc_terminal_list to find active Mission Control terminal ids before retrying.",
        },
      }
    }
    throw error
  }
}

const isTerminalNotFound = (error: unknown) =>
  error instanceof TerminalNotFoundError ||
  (error instanceof Error && (error.name === "TerminalNotFoundError" || error.message.startsWith("Unknown terminal id:")))

const terminalResolutionResult = async (action: () => Promise<unknown>) => {
  try {
    return await action()
  } catch (error) {
    if (isZellijCommandError(error)) {
      return {
        ok: false,
        error: {
          code: "TerminalResolutionError",
          message: zellijCommandErrorMessage(error),
          suggestion:
            "Pass a valid live Zellij session and pane id. Use mc_terminal_sessions to list live Zellij sessions and mc_terminal_panes to list pane ids.",
        },
      }
    }

    const message = error instanceof Error ? error.message : String(error)
    if (isResolutionError(message)) {
      return {
        ok: false,
        error: {
          code: "TerminalResolutionError",
          message,
          suggestion:
            "Pass a valid session name, a sessionId, or a pane id of the form terminal_<n>/plugin_<n>/<n>. Use mc_terminal_sessions to list live Zellij sessions.",
        },
      }
    }
    throw error
  }
}

const isResolutionError = (message: string) =>
  message.includes("Invalid session name") ||
  message.includes("Invalid pane ID") ||
  message.includes("requires a session") ||
  message.includes("cannot be combined")

type ZellijCommandErrorLike = Error & Partial<Pick<ZellijCommandError, "result" | "argv">>

const isZellijCommandError = (error: unknown): error is ZellijCommandErrorLike =>
  error instanceof ZellijCommandError || (error instanceof Error && error.name === "ZellijCommandError")

const zellijCommandErrorMessage = (error: ZellijCommandErrorLike) => {
  const result = error.result
  if (!result) {
    return error.message
  }
  const details = [
    result.stderr.trim() ? `stderr: ${result.stderr.trim()}` : undefined,
    result.stdout.trim() ? `stdout: ${result.stdout.trim()}` : undefined,
  ].filter(Boolean)
  return details.length > 0 ? `${error.message} (${details.join("; ")})` : error.message
}
