import type { BackgroundJob, JobPermissionReplyArgs } from "../types.js"

const LOCAL_PERMISSION_REPLY_TTL_MS = 60_000

export type PermissionReplyProvenance =
  | {
      source: "mission_control_local_reply"
      jobId: string
      parentSessionId: string
      reply: JobPermissionReplyArgs["reply"]
      initiatedAt: number
      callerSessionId?: string
      callerMessageId?: string
    }
  | {
      source: "external_unknown_reply"
    }

export interface LocalPermissionReplyIntent {
  jobId: string
  parentSessionId: string
  reply: JobPermissionReplyArgs["reply"]
  initiatedAt: number
  callerSessionId?: string
  callerMessageId?: string
}

export const buildPermissionReplyMetadata = (
  requestId: string | undefined,
  provenance: PermissionReplyProvenance,
  extras: {
    message?: string
  } = {},
) => ({
  ...(requestId ? { requestId } : {}),
  replySource: provenance.source,
  ...(provenance.source === "mission_control_local_reply"
    ? {
        reply: provenance.reply,
        initiatedAt: provenance.initiatedAt,
        callerSessionId: provenance.callerSessionId,
        callerMessageId: provenance.callerMessageId,
        parentSessionId: provenance.parentSessionId,
        localReplyJobId: provenance.jobId,
      }
    : {}),
  ...(extras.message ? { message: extras.message } : {}),
})

export const rememberLocalPermissionReply = (
  intents: Map<string, LocalPermissionReplyIntent>,
  job: BackgroundJob,
  requestId: string,
  reply: JobPermissionReplyArgs["reply"],
  callerSessionId: string,
  callerMessageId?: string,
): PermissionReplyProvenance => {
  const provenance: PermissionReplyProvenance = {
    source: "mission_control_local_reply",
    jobId: job.jobID,
    parentSessionId: job.parentSessionID,
    reply,
    initiatedAt: Date.now(),
    callerSessionId,
    callerMessageId,
  }

  pruneRecentLocalPermissionReplies(intents)
  intents.set(requestId, {
    jobId: provenance.jobId,
    parentSessionId: provenance.parentSessionId,
    reply: provenance.reply,
    initiatedAt: provenance.initiatedAt,
    callerSessionId: provenance.callerSessionId,
    callerMessageId: provenance.callerMessageId,
  })

  return provenance
}

export const forgetLocalPermissionReply = (
  intents: Map<string, LocalPermissionReplyIntent>,
  requestId?: string,
) => {
  if (!requestId) {
    return
  }

  intents.delete(requestId)
}

export const consumePermissionReplyProvenance = (
  intents: Map<string, LocalPermissionReplyIntent>,
  requestId?: string,
): PermissionReplyProvenance => {
  pruneRecentLocalPermissionReplies(intents)

  if (!requestId) {
    return {
      source: "external_unknown_reply",
    }
  }

  const intent = intents.get(requestId)
  if (!intent) {
    return {
      source: "external_unknown_reply",
    }
  }

  intents.delete(requestId)
  return {
    source: "mission_control_local_reply",
    jobId: intent.jobId,
    parentSessionId: intent.parentSessionId,
    reply: intent.reply,
    initiatedAt: intent.initiatedAt,
    callerSessionId: intent.callerSessionId,
    callerMessageId: intent.callerMessageId,
  }
}

export const pruneRecentLocalPermissionReplies = (
  intents: Map<string, LocalPermissionReplyIntent>,
  now = Date.now(),
) => {
  for (const [requestId, intent] of intents.entries()) {
    if (now - intent.initiatedAt > LOCAL_PERMISSION_REPLY_TTL_MS) {
      intents.delete(requestId)
    }
  }
}
