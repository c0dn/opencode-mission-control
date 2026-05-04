import type { OpenCodeAdapter } from "../opencode-client.js"
import {
  buildPermissionReplyMetadata,
  forgetLocalPermissionReply,
  type LocalPermissionReplyIntent,
  rememberLocalPermissionReply,
} from "./permission-replies.js"
import { collectBlockers, isClosedJobState, isResolvedPendingRequest, toPublicActionResult } from "../job-helpers.js"
import type {
  BackgroundJob,
  JobActionResult,
  JobLifecycleEvent,
  JobPermissionReplyArgs,
  JobQuestionReplyArgs,
  JobResultSnapshot,
  ToolCallerContext,
  ToolFailure,
  ToolResult,
} from "../types.js"
import { fail, ok } from "../types.js"

interface JobEventOptions {
  previousState?: BackgroundJob["state"]
  detail?: string
  metadata?: Record<string, unknown>
}

export interface JobActionsRuntime {
  jobs: Map<string, BackgroundJob>
  results: Map<string, JobResultSnapshot>
  recentLocalPermissionReplies: Map<string, LocalPermissionReplyIntent>
  validateParentCaller(
    adapter: OpenCodeAdapter,
    job: BackgroundJob,
    caller: ToolCallerContext,
  ): Promise<string | ToolFailure>
  captureResult(adapter: OpenCodeAdapter, job: BackgroundJob): Promise<JobResultSnapshot | undefined>
  relayResult(
    adapter: OpenCodeAdapter,
    jobID: string,
    options?: { force?: boolean },
  ): Promise<ToolResult<{ job: BackgroundJob; result: JobResultSnapshot }>>
  closeJobTracking(job: BackgroundJob): void
  persist(): Promise<void>
  recordJobEvent(job: BackgroundJob, type: string, options?: JobEventOptions): JobLifecycleEvent
  debugJob(adapter: OpenCodeAdapter, message: string, job: BackgroundJob, extra?: Record<string, unknown>): Promise<void>
}

export const replyPermission = async (
  runtime: JobActionsRuntime,
  adapter: OpenCodeAdapter,
  args: JobPermissionReplyArgs,
  caller: ToolCallerContext = {},
): Promise<ToolResult<JobActionResult>> => {
  const job = runtime.jobs.get(args.jobId)
  if (!job) {
    return fail("JobNotFound", `Job '${args.jobId}' was not found.`)
  }

  const validatedParentSessionID = await runtime.validateParentCaller(adapter, job, caller)
  if (typeof validatedParentSessionID !== "string") {
    return validatedParentSessionID
  }

  const pendingInput = job.pendingInput
  if (job.state !== "waiting_permission" || pendingInput?.kind !== "permission") {
    return fail(
      "JobBlockedOnPermission",
      `Job '${job.jobID}' is not currently waiting on a permission request.`,
      "Inspect mc_job_status to confirm the current blocked input before replying.",
    )
  }

  if (!adapter.supportsPermissionReply()) {
    return fail(
      "JobBlockedOnPermission",
      `The current OpenCode runtime cannot reply to permission requests for job '${job.jobID}'.`,
    )
  }

  const localPermissionReplyProvenance = rememberLocalPermissionReply(
    runtime.recentLocalPermissionReplies,
    job,
    pendingInput.requestId,
    args.reply,
    validatedParentSessionID,
    caller.messageId?.trim() || undefined,
  )

  try {
    await runtime.debugJob(adapter, "replyPermission sending permission reply", job, {
      requestId: pendingInput.requestId,
      reply: args.reply,
      callerSessionId: validatedParentSessionID,
      callerMessageId: caller.messageId,
    })
    await adapter.replyPermissionRequest(
      pendingInput.requestId,
      args.reply,
      args.message,
      job.childDirectory ?? job.parentDirectory,
    )
  } catch (error) {
    forgetLocalPermissionReply(runtime.recentLocalPermissionReplies, pendingInput.requestId)
    return fail(
      "JobBlockedOnPermission",
      `Failed to reply to the permission request for job '${job.jobID}'.`,
      error instanceof Error ? error.message : undefined,
    )
  }

  if (isResolvedPendingRequest(job, "permission", pendingInput.requestId)) {
    await runtime.debugJob(adapter, "replyPermission observed already-resolved permission request", job, {
      requestId: pendingInput.requestId,
      reply: args.reply,
    })

    return ok(toPublicActionResult(job))
  }

  const previousState = job.state
  job.state = "running"
  job.pendingInput = undefined
  job.lastResolvedPendingKind = "permission"
  job.lastResolvedPendingRequestID = pendingInput.requestId
  job.updatedAt = Date.now()
  job.lastObservedEvent = "permission.replied"
  runtime.recordJobEvent(job, "permission.replied", {
    previousState,
    detail: `Parent replied '${args.reply}' to the permission request.`,
    metadata: buildPermissionReplyMetadata(pendingInput.requestId, localPermissionReplyProvenance, {
      message: args.message,
    }),
  })
  try {
    await runtime.persist()
  } catch (error) {
    await adapter.debug("replyPermission failed to persist job state", {
      jobId: job.jobID,
      state: job.state,
      requestId: pendingInput.requestId,
      error: error instanceof Error ? error.message : String(error),
    })

    return ok(toPublicActionResult(job))
  }
  return ok(toPublicActionResult(job))
}

export const replyQuestion = async (
  runtime: JobActionsRuntime,
  adapter: OpenCodeAdapter,
  args: JobQuestionReplyArgs,
  caller: ToolCallerContext = {},
): Promise<ToolResult<JobActionResult>> => {
  const job = runtime.jobs.get(args.jobId)
  if (!job) {
    return fail("JobNotFound", `Job '${args.jobId}' was not found.`)
  }

  const validatedParentSessionID = await runtime.validateParentCaller(adapter, job, caller)
  if (typeof validatedParentSessionID !== "string") {
    return validatedParentSessionID
  }

  const pendingInput = job.pendingInput
  if (job.state !== "waiting_question" || pendingInput?.kind !== "question") {
    return fail(
      "JobBlockedOnQuestion",
      `Job '${job.jobID}' is not currently waiting on a question response.`,
      "Inspect mc_job_status to confirm the current blocked input before replying.",
    )
  }

  if (!adapter.supportsQuestionReply()) {
    return fail(
      "JobBlockedOnQuestion",
      `The current OpenCode runtime cannot reply to question requests for job '${job.jobID}'.`,
    )
  }

  try {
    await adapter.replyQuestionRequest(pendingInput.requestId, args.answers, job.childDirectory ?? job.parentDirectory)
  } catch (error) {
    return fail(
      "JobBlockedOnQuestion",
      `Failed to reply to the question request for job '${job.jobID}'.`,
      error instanceof Error ? error.message : undefined,
    )
  }

  const previousState = job.state
  job.state = "running"
  job.pendingInput = undefined
  job.lastResolvedPendingKind = "question"
  job.lastResolvedPendingRequestID = pendingInput.requestId
  job.updatedAt = Date.now()
  job.lastObservedEvent = "question.replied"
  runtime.recordJobEvent(job, "question.replied", {
    previousState,
    detail: "Parent answered the pending question.",
    metadata: {
      requestId: pendingInput.requestId,
      answers: args.answers,
      callerSessionId: validatedParentSessionID,
    },
  })
  try {
    await runtime.persist()
  } catch (error) {
    await adapter.debug("replyQuestion failed to persist job state", {
      jobId: job.jobID,
      state: job.state,
      requestId: pendingInput.requestId,
      error: error instanceof Error ? error.message : String(error),
    })

    return ok(toPublicActionResult(job))
  }
  return ok(toPublicActionResult(job))
}

export const rejectQuestion = async (
  runtime: JobActionsRuntime,
  adapter: OpenCodeAdapter,
  jobID: string,
  caller: ToolCallerContext = {},
): Promise<ToolResult<JobActionResult>> => {
  const job = runtime.jobs.get(jobID)
  if (!job) {
    return fail("JobNotFound", `Job '${jobID}' was not found.`)
  }

  const validatedParentSessionID = await runtime.validateParentCaller(adapter, job, caller)
  if (typeof validatedParentSessionID !== "string") {
    return validatedParentSessionID
  }

  const pendingInput = job.pendingInput
  if (job.state !== "waiting_question" || pendingInput?.kind !== "question") {
    return fail(
      "JobBlockedOnQuestion",
      `Job '${job.jobID}' is not currently waiting on a question response.`,
      "Inspect mc_job_status to confirm the current blocked input before rejecting it.",
    )
  }

  if (!adapter.supportsQuestionReject()) {
    return fail(
      "JobBlockedOnQuestion",
      `The current OpenCode runtime cannot reject question requests for job '${job.jobID}'.`,
    )
  }

  try {
    await adapter.rejectQuestionRequest(pendingInput.requestId, job.childDirectory ?? job.parentDirectory)
  } catch (error) {
    return fail(
      "JobBlockedOnQuestion",
      `Failed to reject the question request for job '${job.jobID}'.`,
      error instanceof Error ? error.message : undefined,
    )
  }

  const previousState = job.state
  job.pendingInput = undefined
  job.lastResolvedPendingKind = "question"
  job.lastResolvedPendingRequestID = pendingInput.requestId
  job.state = "failed"
  job.failureReason = "Question rejected"
  job.updatedAt = Date.now()
  job.completedAt = Date.now()
  job.lastObservedEvent = "question.rejected"
  runtime.recordJobEvent(job, "question.rejected", {
    previousState,
    detail: job.failureReason,
    metadata: {
      requestId: pendingInput.requestId,
      callerSessionId: validatedParentSessionID,
    },
  })
  try {
    await runtime.captureResult(adapter, job)
    runtime.closeJobTracking(job)
    const relayResult = await runtime.relayResult(adapter, job.jobID)
    if (!relayResult.ok) {
        return ok(toPublicActionResult(job))
    }
    await runtime.persist()
  } catch (error) {
    await adapter.debug("rejectQuestion failed during finalization", {
      jobId: job.jobID,
      state: job.state,
      requestId: pendingInput.requestId,
      error: error instanceof Error ? error.message : String(error),
    })

    return ok(toPublicActionResult(job))
  }
  return ok(toPublicActionResult(job))
}

export const cancelJob = async (
  runtime: JobActionsRuntime,
  adapter: OpenCodeAdapter,
  jobID: string,
  caller: ToolCallerContext = {},
): Promise<ToolResult<JobActionResult>> => {
  const job = runtime.jobs.get(jobID)
  if (!job) {
    return fail("JobNotFound", `Job '${jobID}' was not found.`)
  }

  const validatedParentSessionID = await runtime.validateParentCaller(adapter, job, caller)
  if (typeof validatedParentSessionID !== "string") {
    return validatedParentSessionID
  }

  if (isClosedJobState(job.state)) {
    return fail(
      "JobLaunchFailed",
      `Job '${jobID}' is already finalized and cannot be cancelled.`,
      "Inspect the stored result instead of cancelling a closed job.",
    )
  }

  if (job.childSessionID) {
    try {
      await adapter.abortSession(job.childSessionID, job.childDirectory)
    } catch (error) {
      return fail(
        "JobLaunchFailed",
        `Failed to abort child session '${job.childSessionID}' for job '${jobID}'.`,
        error instanceof Error ? error.message : undefined,
      )
    }
  }

  const previousState = job.state
  job.pendingInput = undefined
  job.state = "aborted"
  job.updatedAt = Date.now()
  job.completedAt = Date.now()
  job.lastObservedEvent = "job.cancelled"
  runtime.recordJobEvent(job, "job.cancelled", { previousState })
  runtime.results.set(jobID, {
    jobID,
    childSessionID: job.childSessionID ?? "unknown",
    state: "aborted",
    headline: job.title,
    summary: "The background job was aborted.",
    blockers: [],
    recommendedNextStep: undefined,
    keyMessageIDs: [],
    observedAt: Date.now(),
  })
  try {
    runtime.closeJobTracking(job)
    const relayResult = await runtime.relayResult(adapter, jobID)
    if (!relayResult.ok) {
        return ok(toPublicActionResult(job))
    }
    await runtime.persist()
  } catch (error) {
    await adapter.debug("cancelJob failed during finalization", {
      jobId: job.jobID,
      state: job.state,
      error: error instanceof Error ? error.message : String(error),
    })

    return ok(toPublicActionResult(job))
  }
  return ok(toPublicActionResult(job))
}
