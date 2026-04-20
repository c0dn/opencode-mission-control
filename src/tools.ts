import { tool } from "@opencode-ai/plugin"
import type { ToolResult as PluginToolResult } from "@opencode-ai/plugin"

import { clampResultLimit } from "./config.js"
import type { MissionControlServer } from "./server.js"

const toPluginToolResult = (value: unknown): PluginToolResult => ({
  output: JSON.stringify(value, null, 2),
  metadata: value && typeof value === "object" ? (value as Record<string, unknown>) : { value },
})

export const createMissionControlTools = (server: MissionControlServer) => ({
  mission_control_status: tool({
    description: "Return mission-control runtime status",
    args: {},
    async execute() {
      return toPluginToolResult(await server.status())
    },
  }),

  mission_control_session_read: tool({
    description: "Read a session transcript with optional children",
    args: {
      sessionID: tool.schema.string(),
      beforeMessageID: tool.schema.string().optional(),
      limit: tool.schema.number().optional(),
      includeChildren: tool.schema.boolean().optional(),
      includeToolOutputs: tool.schema.boolean().optional(),
    },
    async execute(args) {
      return toPluginToolResult(
        await server.readSession(args.sessionID, {
          beforeMessageID: args.beforeMessageID,
          limit: clampResultLimit(args.limit, server.config),
          includeChildren: args.includeChildren,
          includeToolOutputs: args.includeToolOutputs,
        }),
      )
    },
  }),

  mission_control_session_tree: tool({
    description: "Return a session parent-child tree",
    args: {
      sessionID: tool.schema.string(),
      depth: tool.schema.number().optional(),
    },
    async execute(args) {
      return toPluginToolResult(await server.sessionTree(args.sessionID, args.depth ?? 1))
    },
  }),

  mission_control_session_observe: tool({
    description: "Return recent operational events for a session",
    args: {
      sessionID: tool.schema.string(),
      includeChildren: tool.schema.boolean().optional(),
      eventLimit: tool.schema.number().optional(),
    },
    async execute(args) {
      return toPluginToolResult(
        await server.observeSession(args.sessionID, {
          includeChildren: args.includeChildren,
          eventLimit: args.eventLimit,
        }),
      )
    },
  }),

  mission_control_session_search: tool({
    description: "Search indexed session content",
    args: {
      query: tool.schema.string(),
      sessionID: tool.schema.string().optional(),
      global: tool.schema.boolean().optional(),
      exact: tool.schema.boolean().optional(),
      limit: tool.schema.number().optional(),
    },
    async execute(args) {
      return toPluginToolResult(
        await server.searchSessions({
          query: args.query,
          sessionID: args.sessionID,
          global: args.global,
          exact: args.exact,
          limit: clampResultLimit(args.limit, server.config),
        }),
      )
    },
  }),

  mission_control_job_start: tool({
    description: "Launch a background child-session job",
    args: {
      title: tool.schema.string(),
      prompt: tool.schema.string(),
      parentSessionID: tool.schema.string().optional(),
      attach: tool.schema.enum(["auto", "explicit_only"]).optional(),
      relayToParent: tool.schema.enum(["never", "on_idle", "on_completion", "manual_only"]).optional(),
    },
    async execute(args, context) {
      return toPluginToolResult(
        await server.startJob(
          {
            title: args.title,
            prompt: args.prompt,
            parentSessionID: args.parentSessionID,
            attach: args.attach,
            relayToParent: args.relayToParent,
          },
          {
            sessionID: context.sessionID,
            directory: context.directory,
            worktree: context.worktree,
          },
        ),
      )
    },
  }),

  mission_control_job_status: tool({
    description: "Return the current state for a background job",
    args: {
      jobID: tool.schema.string(),
    },
    async execute(args) {
      return toPluginToolResult(server.jobStatus(args.jobID))
    },
  }),

  mission_control_job_list: tool({
    description: "List tracked background jobs",
    args: {
      parentSessionID: tool.schema.string().optional(),
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
          parentSessionID: args.parentSessionID,
          state: args.state,
          limit: args.limit,
        }),
      )
    },
  }),

  mission_control_job_cancel: tool({
    description: "Abort a running background job",
    args: {
      jobID: tool.schema.string(),
    },
    async execute(args) {
      return toPluginToolResult(await server.cancelJob(args.jobID))
    },
  }),

  mission_control_job_result: tool({
    description: "Get the latest stable result snapshot for a background job",
    args: {
      jobID: tool.schema.string(),
      relayToParent: tool.schema.boolean().optional(),
    },
    async execute(args) {
      return toPluginToolResult(await server.jobResult(args.jobID, args.relayToParent ?? false))
    },
  }),
})
