import type { OpenCodeAdapter } from "../opencode-client.js"
import { fail } from "../types.js"
import type { BackgroundJob, ToolCallerContext } from "../types.js"

export const resolveCallerSessionID = async (adapter: OpenCodeAdapter, caller: ToolCallerContext) => {
  if (!caller.messageId?.trim()) {
    await adapter.debug("resolveCallerSessionID using raw caller session without message verification", {
      callerSessionId: caller.sessionId,
    })

    return caller.sessionId?.trim()
  }

  const resolvedCaller = await adapter.resolveCallerSession(caller)
  if (resolvedCaller?.sessionID) {
    await adapter.debug("resolveCallerSessionID resolved caller from message", {
      callerSessionId: caller.sessionId,
      callerMessageId: caller.messageId,
      resolvedSessionId: resolvedCaller.sessionID,
    })
  } else {
    await adapter.debug("resolveCallerSessionID could not resolve caller from message", {
      callerSessionId: caller.sessionId,
      callerMessageId: caller.messageId,
    })
  }

  return resolvedCaller?.sessionID
}

export const validateParentCaller = async (
  adapter: OpenCodeAdapter,
  job: BackgroundJob,
  caller: ToolCallerContext,
): Promise<string | ReturnType<typeof fail>> => {
  const callerSessionID = await resolveCallerSessionID(adapter, caller)
  if (!callerSessionID) {
    await adapter.debug("validateParentCaller could not resolve caller parent session", {
      jobId: job.jobID,
      expectedParentSessionId: job.parentSessionID,
      callerSessionId: caller.sessionId,
      callerMessageId: caller.messageId,
    })

    return fail(
      "CurrentSessionUnavailable",
      `Mission Control could not verify the parent session for job '${job.jobID}'.`,
      "Run this reply tool from the parent session that launched the background job.",
    )
  }

  if (callerSessionID !== job.parentSessionID) {
    await adapter.debug("validateParentCaller rejected mismatched parent session", {
      jobId: job.jobID,
      expectedParentSessionId: job.parentSessionID,
      callerSessionId: callerSessionID,
      callerMessageId: caller.messageId,
    })

    return fail(
      "JobLaunchFailed",
      `Only parent session '${job.parentSessionID}' can perform parent-scoped actions for job '${job.jobID}'.`,
      "Switch back to the parent session that launched the job and retry.",
    )
  }

  return callerSessionID
}
