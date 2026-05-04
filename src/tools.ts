import { tool } from "@opencode-ai/plugin"
import type { ToolResult as PluginToolResult } from "@opencode-ai/plugin"

import { clampResultLimit } from "./config.js"
import type { MissionControlServer } from "./server.js"
import type { MissionControlToolSurface } from "./types.js"

const toPluginToolResult = (value: unknown): PluginToolResult => ({
  output: JSON.stringify(value, null, 2),
  metadata: value && typeof value === "object" ? (value as Record<string, unknown>) : { value },
})

export const createMissionControlTools = (server: MissionControlServer) => {
  const tools = {
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
      title: tool.schema.string().optional(),
    },
    async execute(args, context) {
      return toPluginToolResult(
        await server.startJob(
          {
            prompt: args.prompt,
            title: args.title,
          },
          {
            sessionId: context.sessionID,
            messageId: context.messageID,
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

  mc_job_pending_input: tool({
    description: "Return detailed blocked permission/question input for one job",
    args: {
      jobId: tool.schema.string(),
    },
    async execute(args) {
      return toPluginToolResult(server.jobPendingInput(args.jobId))
    },
  }),

  mc_job_events: tool({
    description: "Return persisted events for a background job",
    args: {
      jobId: tool.schema.string(),
      limit: tool.schema.number().optional(),
    },
    async execute(args) {
      return toPluginToolResult(server.jobEvents({ jobId: args.jobId, limit: args.limit }))
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

  mc_job_update: tool({
    description: "Record a child progress update for a background job",
    args: {
      jobId: tool.schema.string().optional(),
      message: tool.schema.string(),
      notifyParent: tool.schema.boolean().optional(),
    },
    async execute(args, context) {
      return toPluginToolResult(
        await server.updateJobProgress(
          {
            jobId: args.jobId,
            message: args.message,
            notifyParent: args.notifyParent,
          },
          {
            sessionId: context.sessionID,
            messageId: context.messageID,
            directory: context.directory,
            worktree: context.worktree,
          },
        ),
      )
    },
  }),

  mc_job_permission_reply: tool({
    description: "Reply to a pending permission request for a background job",
    args: {
      jobId: tool.schema.string(),
      reply: tool.schema.enum(["once", "always", "reject"]),
      message: tool.schema.string().optional(),
    },
    async execute(args, context) {
      return toPluginToolResult(
        await server.replyJobPermission({
            jobId: args.jobId,
            reply: args.reply,
            message: args.message,
          },
          {
            sessionId: context.sessionID,
            messageId: context.messageID,
            directory: context.directory,
            worktree: context.worktree,
          },
        ),
      )
    },
  }),

  mc_job_question_reply: tool({
    description: "Reply to a pending question request for a background job",
    args: {
      jobId: tool.schema.string(),
      answers: tool.schema.array(tool.schema.array(tool.schema.string())),
    },
    async execute(args, context) {
      return toPluginToolResult(
        await server.replyJobQuestion({
            jobId: args.jobId,
            answers: args.answers,
          },
          {
            sessionId: context.sessionID,
            messageId: context.messageID,
            directory: context.directory,
            worktree: context.worktree,
          },
        ),
      )
    },
  }),

  mc_job_question_reject: tool({
    description: "Reject a pending question request for a background job",
    args: {
      jobId: tool.schema.string(),
    },
    async execute(args, context) {
      return toPluginToolResult(
        await server.rejectJobQuestion(args.jobId, {
          sessionId: context.sessionID,
          messageId: context.messageID,
          directory: context.directory,
          worktree: context.worktree,
        }),
      )
    },
  }),

  mc_job_abort: tool({
    description: "Abort a running background job",
    args: {
      jobId: tool.schema.string(),
    },
    async execute(args, context) {
      return toPluginToolResult(
        await server.cancelJob(args.jobId, {
          sessionId: context.sessionID,
          messageId: context.messageID,
          directory: context.directory,
          worktree: context.worktree,
        }),
      )
    },
  }),

  mc_job_result: tool({
    description: "Get the latest stable result snapshot for a background job",
    args: {
      jobId: tool.schema.string(),
      sendToParent: tool.schema.boolean().optional(),
    },
    async execute(args, context) {
      return toPluginToolResult(
        await server.jobResult(args.jobId, args.sendToParent ?? false, {
          sessionId: context.sessionID,
          messageId: context.messageID,
          directory: context.directory,
          worktree: context.worktree,
        }),
      )
    },
  }),
  }

  return selectToolsForSurface(tools, server.config.tools.surface)
}

const selectToolsForSurface = <T extends Record<string, unknown>>(tools: T, surface: MissionControlToolSurface): T => {
  if (surface === "full") {
    return tools
  }

  const allowed =
    surface === "jobs-only"
      ? new Set([
          "mc_status",
          "mc_job_start",
          "mc_job_status",
          "mc_job_pending_input",
          "mc_job_events",
          "mc_job_list",
          "mc_job_update",
          "mc_job_permission_reply",
          "mc_job_question_reply",
          "mc_job_question_reject",
          "mc_job_abort",
          "mc_job_result",
        ])
      : new Set([
          "mc_status",
          "mc_session_read",
          "mc_session_tail",
          "mc_session_tree",
          "mc_session_events",
          "mc_session_search",
        ])

  return Object.fromEntries(Object.entries(tools).filter(([toolName]) => allowed.has(toolName))) as T
}
