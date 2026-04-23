import type { MissionControlErrorCode, ToolFailure, ToolSuccess } from "../types.js"

export const ok = <T>(data: T): ToolSuccess<T> => ({
  ok: true,
  data,
})

export const fail = (
  code: MissionControlErrorCode,
  message: string,
  suggestion?: string,
): ToolFailure => ({
  ok: false,
  error: {
    code,
    message,
    suggestion,
  },
})
