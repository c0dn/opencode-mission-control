import { tool } from "@opencode-ai/plugin"
import type { ToolResult as PluginToolResult } from "@opencode-ai/plugin"

import { clampResultLimit } from "./config.js"
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
  }

  return tools
}
