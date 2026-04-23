import type { OpenCodeAdapter } from "../opencode-client.js"
import { isClosedJobState, toPublicJob, toPublicJobEvent } from "../job-helpers.js"
import type {
  BackgroundJob,
  JobLifecycleEvent,
  JobProgressUpdateArgs,
  JobProgressUpdateResult,
  ToolCallerContext,
  ToolResult,
} from "../types.js"
import { fail, ok } from "../types.js"

interface JobEventOptions {
  previousState?: BackgroundJob["state"]
  detail?: string
  metadata?: Record<string, unknown>
}

export interface JobProgressRuntime {
  jobs: Map<string, BackgroundJob>
  jobForChildSession(sessionID: string): BackgroundJob | undefined
  resolveCallerSessionID(adapter: OpenCodeAdapter, caller: ToolCallerContext): Promise<string | undefined>
  clearStaleSnapshot(job: BackgroundJob, previousState: BackgroundJob["state"]): void
  safeDeliverProgressRelay(adapter: OpenCodeAdapter, job: BackgroundJob, message: string): Promise<void>
  recordJobEvent(job: BackgroundJob, type: string, options?: JobEventOptions): JobLifecycleEvent
  persist(): Promise<void>
}

export const updateProgress = async (
  runtime: JobProgressRuntime,
  adapter: OpenCodeAdapter,
  args: JobProgressUpdateArgs,
  caller: ToolCallerContext = {},
): Promise<ToolResult<JobProgressUpdateResult>> => {
  const trimmedMessage = args.message.trim()
  if (!trimmedMessage) {
    return fail("JobLaunchFailed", "Progress updates require a non-blank message.")
  }

  const callerSessionID = await runtime.resolveCallerSessionID(adapter, caller)
  if (!callerSessionID) {
    await adapter.debug("updateProgress could not resolve caller child session", {
      requestedJobId: args.jobId,
      callerSessionId: caller.sessionId,
      callerMessageId: caller.messageId,
      callerDirectory: caller.directory,
      callerWorktree: caller.worktree,
    })

    return fail(
      "CurrentSessionUnavailable",
      "Mission Control could not identify the caller child session for this progress update.",
      "Call mc_job_update from the background child session or pass an explicit jobId from that child session.",
    )
  }

  const job = args.jobId ? runtime.jobs.get(args.jobId) : runtime.jobForChildSession(callerSessionID)
  if (!job) {
    await adapter.debug("updateProgress could not find tracked job", {
      requestedJobId: args.jobId,
      callerSessionId: callerSessionID,
    })

    return fail("JobNotFound", `No tracked background job matches '${args.jobId ?? callerSessionID}'.`)
  }

  if (job.childSessionID !== callerSessionID) {
    await adapter.debug("updateProgress caller child session did not match tracked child session", {
      jobId: job.jobID,
      callerSessionId: callerSessionID,
      trackedChildSessionId: job.childSessionID,
    })

    return fail(
      "JobLaunchFailed",
      `Job '${job.jobID}' only accepts progress updates from its tracked child session.`,
      "Call mc_job_update from the active child session for this job.",
    )
  }

  if (isClosedJobState(job.state)) {
    return fail(
      "JobLaunchFailed",
      `Job '${job.jobID}' is already finalized and cannot accept more progress updates.`,
      "Inspect the stored result instead of sending more progress updates.",
    )
  }

  const previousState = job.state
  if (
    previousState === "idle" ||
    ((previousState === "waiting_permission" || previousState === "waiting_question") && !job.pendingInput)
  ) {
    job.state = "running"
    runtime.clearStaleSnapshot(job, previousState)
  }

  job.updatedAt = Date.now()
  job.lastObservedEvent = "job.progress"
  const event = runtime.recordJobEvent(job, "job.progress", {
    previousState: previousState !== job.state ? previousState : undefined,
    detail: trimmedMessage,
    metadata: {
      notifyParent: Boolean(args.notifyParent),
    },
  })

  if (args.notifyParent) {
    await runtime.safeDeliverProgressRelay(adapter, job, trimmedMessage)
  }

  try {
    await runtime.persist()
  } catch (error) {
    await adapter.debug("updateProgress failed to persist job state", {
      jobId: job.jobID,
      state: job.state,
      error: error instanceof Error ? error.message : String(error),
    })

    return ok({
      job: toPublicJob(job),
      event: toPublicJobEvent(event),
    })
  }

  return ok({
    job: toPublicJob(job),
    event: toPublicJobEvent(event),
  })
}
