import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2"

type OpenCodeEventName = OpenCodeEvent["type"]

export const MISSION_CONTROL_EVENT_HOOKS = [
  "session.created",
  "session.updated",
  "session.compacted",
  "session.status",
  "session.idle",
  "session.error",
  "session.deleted",
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "todo.updated",
  "vcs.branch.updated",
  "workspace.ready",
  "workspace.failed",
  "workspace.status",
  "session.next.agent.switched",
  "session.next.model.switched",
  "session.next.prompted",
  "session.next.synthetic",
  "session.next.shell.started",
  "session.next.shell.ended",
  "session.next.step.started",
  "session.next.step.ended",
  "session.next.step.failed",
  "session.next.text.started",
  "session.next.text.delta",
  "session.next.text.ended",
  "session.next.reasoning.started",
  "session.next.reasoning.delta",
  "session.next.reasoning.ended",
  "session.next.tool.input.started",
  "session.next.tool.input.delta",
  "session.next.tool.input.ended",
  "session.next.tool.called",
  "session.next.tool.progress",
  "session.next.tool.success",
  "session.next.tool.failed",
  "session.next.retried",
  "session.next.compaction.started",
  "session.next.compaction.delta",
  "session.next.compaction.ended",
] as const satisfies readonly OpenCodeEventName[]

export type MissionControlEventHook = (typeof MISSION_CONTROL_EVENT_HOOKS)[number]

export const MISSION_CONTROL_DISPOSAL_EVENT_HOOKS = [
  "global.disposed",
  "server.instance.disposed",
] as const satisfies readonly OpenCodeEventName[]

export type MissionControlDisposalEventHook = (typeof MISSION_CONTROL_DISPOSAL_EVENT_HOOKS)[number]
