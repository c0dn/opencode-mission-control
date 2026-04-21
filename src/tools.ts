import { tool } from "@opencode-ai/plugin"
import type { ToolResult as PluginToolResult } from "@opencode-ai/plugin"

import { clampResultLimit } from "./config.js"
import type { MissionControlServer } from "./server.js"

const toPluginToolResult = (value: unknown): PluginToolResult => ({
  output: JSON.stringify(value, null, 2),
  metadata: value && typeof value === "object" ? (value as Record<string, unknown>) : { value },
})

export const createMissionControlTools = (server: MissionControlServer) => ({
  mc_status: tool({
    description: "Return mission-control runtime status",
    args: {},
    async execute() {
      return toPluginToolResult(await server.status())
    },
  }),

  mc_session_read: tool({
    description: "Read one session transcript, optionally with children",
    args: {
      sessionId: tool.schema.string(),
      beforeMessageId: tool.schema.string().optional(),
      limit: tool.schema.number().optional(),
      withChildren: tool.schema.boolean().optional(),
      withToolOutputs: tool.schema.boolean().optional(),
    },
    async execute(args) {
      return toPluginToolResult(
        await server.readSession(args.sessionId, {
          beforeMessageId: args.beforeMessageId,
          limit: clampResultLimit(args.limit, server.config),
          withChildren: args.withChildren,
          withToolOutputs: args.withToolOutputs,
        }),
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
      return toPluginToolResult(await server.sessionTree(args.sessionId, args.depth ?? 1))
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
      )
    },
  }),

  mc_session_search: tool({
    description: "Search indexed session content by query",
    args: {
      query: tool.schema.string(),
      sessionId: tool.schema.string().optional(),
      scope: tool.schema.enum(["local", "global"]).optional(),
      exact: tool.schema.boolean().optional(),
      limit: tool.schema.number().optional(),
    },
    async execute(args) {
      return toPluginToolResult(
        await server.searchSessions({
          query: args.query,
          sessionId: args.sessionId,
          scope: args.scope,
          exact: args.exact,
          limit: clampResultLimit(args.limit, server.config),
        }),
      )
    },
  }),

  mc_job_start: tool({
    description: "Launch a background child-session job",
    args: {
      prompt: tool.schema.string(),
      sessionId: tool.schema.string().optional(),
      title: tool.schema.string().optional(),
      relay: tool.schema.enum(["manual", "on_idle", "on_completion"]).optional(),
    },
    async execute(args, context) {
      return toPluginToolResult(
        await server.startJob(
          {
            prompt: args.prompt,
            sessionId: args.sessionId,
            title: args.title,
            relay: args.relay,
          },
          {
            sessionId: context.sessionID,
            directory: context.directory,
            worktree: context.worktree,
          },
        ),
      )
    },
  }),

  mc_job_status: tool({
    description: "Return the current state for a background job",
    args: {
      jobId: tool.schema.string(),
    },
    async execute(args) {
      return toPluginToolResult(server.jobStatus(args.jobId))
    },
  }),

  mc_job_list: tool({
    description: "List tracked background jobs",
    args: {
      sessionId: tool.schema.string().optional(),
      state: tool.schema
        .enum([
          "queued",
          "launching",
          "running",
          "waiting_permission",
          "waiting_question",
          "idle",
          "completed",
          "failed",
          "aborted",
          "orphaned",
        ])
        .optional(),
      limit: tool.schema.number().optional(),
    },
    async execute(args) {
      return toPluginToolResult(
        server.listJobs({
          sessionId: args.sessionId,
          state: args.state,
          limit: args.limit,
        }),
      )
    },
  }),

  mc_job_abort: tool({
    description: "Abort a running background job",
    args: {
      jobId: tool.schema.string(),
    },
    async execute(args) {
      return toPluginToolResult(await server.cancelJob(args.jobId))
    },
  }),

  mc_job_result: tool({
    description: "Get the latest stable result snapshot for a background job",
    args: {
      jobId: tool.schema.string(),
      sendToParent: tool.schema.boolean().optional(),
    },
    async execute(args) {
      return toPluginToolResult(await server.jobResult(args.jobId, args.sendToParent ?? false))
    },
  }),
})
