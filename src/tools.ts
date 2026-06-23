import { tool } from "@opencode-ai/plugin"
import type { ToolResult as PluginToolResult } from "@opencode-ai/plugin"

import { clampResultLimit } from "./config.js"
import type { MissionControlServer } from "./server.js"

type MissionControlTool = ReturnType<typeof tool>

const toPluginToolResult = (value: unknown, title: string): PluginToolResult => ({
  title,
  output: JSON.stringify(value, null, 2),
  metadata: value && typeof value === "object" ? (value as Record<string, unknown>) : { value },
})

export const createMissionControlTools = (server: MissionControlServer): Record<string, MissionControlTool> => {
  const tools = {
    // ── Search (always hybrid semantic, Jina key required) ──────────────────

    session_search: tool({
      description: "Search session transcripts in the current project/directory",
      args: {
        query: tool.schema.string(),
        limit: tool.schema.number().optional(),
      },
      async execute(args) {
        return toPluginToolResult(
          await server.searchSessions({
            query: args.query,
            scope: "local",
            limit: clampResultLimit(args.limit, server.config),
          }),
          "Session Search Results",
        )
      },
    }),

    session_search_global: tool({
      description: "Search session transcripts across all projects globally",
      args: {
        query: tool.schema.string(),
        limit: tool.schema.number().optional(),
      },
      async execute(args) {
        return toPluginToolResult(
          await server.searchSessions({
            query: args.query,
            scope: "global",
            limit: clampResultLimit(args.limit, server.config),
          }),
          "Session Search Results",
        )
      },
    }),

    // ── Read / inspect ───────────────────────────────────────────────────────

    session_read: tool({
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

    session_tail: tool({
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

    session_find: tool({
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

    session_get: tool({
      description: "Return normalized metadata for one session",
      args: {
        sessionId: tool.schema.string(),
      },
      async execute(args) {
        return toPluginToolResult(await server.getSession(args.sessionId), "Session Metadata")
      },
    }),

    session_list: tool({
      description: "List sessions with optional filters for scope, timestamp floor, and title search",
      args: {
        scope: tool.schema.enum(["local", "global"]).optional(),
        start: tool.schema.number().optional(),
        search: tool.schema.string().optional(),
        limit: tool.schema.number().optional(),
      },
      async execute(args) {
        return toPluginToolResult(
          await server.listSessions({
            scope: args.scope,
            start: args.start,
            search: args.search,
            limit: args.limit,
          }),
          "Session List",
        )
      },
    }),

    // ── Subagent orchestration ───────────────────────────────────────────────

    subagent_abort: tool({
      description: "Abort/cancel an OpenCode session by session ID",
      args: {
        sessionId: tool.schema.string(),
      },
      async execute(args) {
        return toPluginToolResult(await server.abortSession(args.sessionId), "Session Abort")
      },
    }),

    subagent_send_async: tool({
      description:
        "Queue a message into a peer subagent session; the target processes it at its next loop boundary",
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

    subagent_send_interrupt: tool({
      description: "Abort a peer subagent's in-flight response, then deliver a message immediately",
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
  }

  return tools
}
