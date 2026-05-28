import { tool } from "@opencode-ai/plugin"
import type { ToolResult as PluginToolResult } from "@opencode-ai/plugin"

import { clampResultLimit } from "./config.js"
import { TerminalNotFoundError } from "./terminals/registry.js"
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
      sessionId: tool.schema.string(),
      command: tool.schema.array(tool.schema.string()).optional(),
      commandString: tool.schema.string().optional(),
      cwd: tool.schema.string().optional(),
      title: tool.schema.string().optional(),
      label: tool.schema.string().optional(),
      floating: tool.schema.boolean().optional(),
    },
    async execute(args) {
      return toPluginToolResult(
        await server.startTerminal({
          sessionId: args.sessionId,
          command: args.command,
          commandString: args.commandString,
          cwd: args.cwd,
          title: args.title,
          label: args.label,
          floating: args.floating,
        }),
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
