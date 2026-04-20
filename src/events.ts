export const MISSION_CONTROL_EVENT_HOOKS = [
  "session.created",
  "session.updated",
  "session.status",
  "session.idle",
  "session.error",
  "message.updated",
  "message.part.updated",
  "message.part.removed",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
] as const

export type MissionControlEventHook = (typeof MISSION_CONTROL_EVENT_HOOKS)[number]
