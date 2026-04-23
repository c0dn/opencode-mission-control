import type { OpenCodeAdapter } from "../opencode-client.js"
import { toPendingPermissionRequest, toPendingQuestionRequest } from "../job-helpers.js"
import { extractSessionID } from "../session-extractors.js"
import type { BackgroundJob, JobPendingPermissionRequest, JobPendingQuestionRequest } from "../types.js"

export const resolvePendingPermissionRequest = async (
  adapter: OpenCodeAdapter,
  job: BackgroundJob,
  sessionID: string,
  payload: unknown,
): Promise<JobPendingPermissionRequest | undefined> => {
  const direct = toPendingPermissionRequest(payload)
  if (direct) {
    return direct
  }

  try {
    const pending = await adapter.listPendingPermissions(job.childDirectory ?? job.parentDirectory)
    const matched = [...pending].reverse().find((request) => extractSessionID(request) === sessionID)
    return toPendingPermissionRequest(matched)
  } catch {
    return undefined
  }
}

export const resolvePendingQuestionRequest = async (
  adapter: OpenCodeAdapter,
  job: BackgroundJob,
  sessionID: string,
  payload: unknown,
): Promise<JobPendingQuestionRequest | undefined> => {
  const direct = toPendingQuestionRequest(payload)
  if (direct) {
    return direct
  }

  try {
    const pending = await adapter.listPendingQuestions(job.childDirectory ?? job.parentDirectory)
    const matched = [...pending].reverse().find((request) => extractSessionID(request) === sessionID)
    return toPendingQuestionRequest(matched)
  } catch {
    return undefined
  }
}
