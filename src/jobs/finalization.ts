import type { OpenCodeAdapter } from "../opencode-client.js"
import {
  buildStructuredSummary,
  collectBlockers,
  collectMessagePartsText,
  defaultSummaryForState,
  isStableResultState,
  mapJobStateToSnapshotState,
  mergeBlockers,
  parseStructuredFinalReport,
  truncateSummary,
} from "../job-helpers.js"
import { deliverParentRelay } from "../relay.js"
import type { BackgroundJob, JobLifecycleEvent, JobResultSnapshot, ToolResult } from "../types.js"
import { fail, ok } from "../types.js"

interface JobEventOptions {
  previousState?: BackgroundJob["state"]
  detail?: string
  metadata?: Record<string, unknown>
}

export interface JobFinalizationRuntime {
  jobs: Map<string, BackgroundJob>
  results: Map<string, JobResultSnapshot>
  childSessionToJobID: Map<string, string>
  persist(): Promise<void>
  recordJobEvent(job: BackgroundJob, type: string, options?: JobEventOptions): JobLifecycleEvent
  debugJob(adapter: OpenCodeAdapter, message: string, job: BackgroundJob, extra?: Record<string, unknown>): Promise<void>
}

export const closeJobTracking = (runtime: JobFinalizationRuntime, job: BackgroundJob) => {
  if (job.childSessionID) {
    runtime.childSessionToJobID.delete(job.childSessionID)
  }
}

export const markCompleted = (job: BackgroundJob) => {
  job.state = "completed"
  job.completedAt = Date.now()
  job.pendingInput = undefined
}

export const updateSnapshotState = (
  runtime: Pick<JobFinalizationRuntime, "results">,
  jobID: string,
  state: JobResultSnapshot["state"],
) => {
  const snapshot = runtime.results.get(jobID)
  if (!snapshot) {
    return
  }

  snapshot.state = state
  snapshot.observedAt = Date.now()
}

export const clearStaleSnapshot = (
  runtime: Pick<JobFinalizationRuntime, "results">,
  job: BackgroundJob,
  previousState: BackgroundJob["state"],
) => {
  if (isStableResultState(previousState) && !isStableResultState(job.state)) {
    runtime.results.delete(job.jobID)
  }
}

export const captureResult = async (
  runtime: JobFinalizationRuntime,
  adapter: OpenCodeAdapter,
  job: BackgroundJob,
) => {
  if (!job.childSessionID) {
    return undefined
  }

  let snapshot: JobResultSnapshot

  await runtime.debugJob(adapter, "captureResult reading child transcript", job, {
    childDirectory: job.childDirectory,
  })

  try {
    const messages = await adapter.getSessionMessages(job.childSessionID, job.childDirectory)
    const lastMessage = [...messages]
      .reverse()
      .find((message: any) => Array.isArray(message?.parts) && message.parts.length > 0)

    const keyMessageID = typeof lastMessage?.info?.id === "string" ? lastMessage.info.id : undefined
    const rawReport = collectMessagePartsText(lastMessage?.parts ?? [])
    const structuredReport = parseStructuredFinalReport(rawReport)
    snapshot = {
      jobID: job.jobID,
      childSessionID: job.childSessionID,
      state: mapJobStateToSnapshotState(job.state),
      headline: job.title,
      summary: truncateSummary(buildStructuredSummary(structuredReport) || rawReport) || defaultSummaryForState(job),
      blockers: mergeBlockers(job, structuredReport.blockers),
      recommendedNextStep: structuredReport.recommendedNextStep,
      keyMessageIDs: keyMessageID ? [keyMessageID] : [],
      observedAt: Date.now(),
    }
  } catch (error) {
    snapshot = {
      jobID: job.jobID,
      childSessionID: job.childSessionID,
      state: mapJobStateToSnapshotState(job.state),
      headline: job.title,
      summary: `${defaultSummaryForState(job)} Transcript capture failed while finalizing the job.`,
      blockers: collectBlockers(job),
      recommendedNextStep: undefined,
      keyMessageIDs: [],
      observedAt: Date.now(),
    }

    await runtime.debugJob(adapter, "captureResult transcript capture failed", job, {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  runtime.results.set(job.jobID, snapshot)

  await runtime.debugJob(adapter, "captureResult stored snapshot", job, {
    snapshotState: snapshot.state,
    keyMessageCount: snapshot.keyMessageIDs.length,
    blockersCount: snapshot.blockers.length,
    summaryLength: snapshot.summary.length,
  })

  await runtime.persist()
  return snapshot
}

export const relayResult = async (
  runtime: JobFinalizationRuntime,
  adapter: OpenCodeAdapter,
  jobID: string,
  options: {
    force?: boolean
  } = {},
): Promise<ToolResult<{ job: BackgroundJob; result: JobResultSnapshot }>> => {
  const job = runtime.jobs.get(jobID)
  const result = runtime.results.get(jobID)

  if (!job) {
    return fail("JobNotFound", `Job '${jobID}' was not found.`)
  }

  if (!result) {
    return fail(
      "JobLaunchFailed",
      `Job '${jobID}' does not have a result to relay yet.`,
      "Wait for the child session to reach a stable end state, then retry.",
    )
  }

  if (!isStableResultState(job.state) && job.state !== "orphaned") {
    return fail(
      "JobLaunchFailed",
      `Job '${jobID}' is not in a stable state for relay yet.`,
      "Wait for the child session to become idle, failed, aborted, or completed before relaying.",
    )
  }

  if (job.relayState === "delivered" && !options.force) {
    return ok({ job, result })
  }

  await runtime.debugJob(adapter, "relayResult delivering stored snapshot", job, {
    force: Boolean(options.force),
    snapshotState: result.state,
    keyMessageCount: result.keyMessageIDs.length,
  })

  try {
    await deliverParentRelay(adapter, job, result)
    const previousState = job.state
    job.relayState = "delivered"
    if (job.state === "idle") {
      markCompleted(job)
      updateSnapshotState(runtime, job.jobID, "completed")
    }
    closeJobTracking(runtime, job)
    job.updatedAt = Date.now()
    job.lastObservedEvent = options.force ? "job.relay_forced" : "job.relay_delivered"
    runtime.recordJobEvent(job, job.lastObservedEvent, {
      previousState: previousState !== job.state ? previousState : undefined,
    })

    await runtime.debugJob(adapter, "relayResult delivered stored snapshot", job, {
      force: Boolean(options.force),
      previousState,
      nextState: job.state,
      snapshotState: result.state,
    })

    await runtime.persist()
    return ok({ job, result })
  } catch (error) {
    await runtime.debugJob(adapter, "relayResult failed to deliver stored snapshot", job, {
      force: Boolean(options.force),
      snapshotState: result.state,
      error: error instanceof Error ? error.message : String(error),
    })

    if (job.relayState === "delivered") {
      return fail(
        "JobLaunchFailed",
        `Mission Control delivered the result for job '${jobID}' to the parent session, but could not persist that delivery state.`,
        "Treat this relay as already delivered unless you have verified that the parent session never received it.",
      )
    }

    job.relayState = "failed"
    job.updatedAt = Date.now()
    job.lastObservedEvent = "job.relay_failed"
    runtime.recordJobEvent(job, "job.relay_failed", {
      detail: error instanceof Error ? error.message : "Failed to relay the result to the parent session.",
    })
    await runtime.persist()
    return fail(
      "JobLaunchFailed",
      `Failed to relay the result for job '${jobID}' to its parent session.`,
      "Inspect the parent session and re-send the stored result with mc_job_result({ jobId, sendToParent: true }).",
    )
  }
}

export const handleIdleTransition = async (
  runtime: JobFinalizationRuntime,
  adapter: OpenCodeAdapter,
  job: BackgroundJob,
  previousState: BackgroundJob["state"],
  eventType: string,
) => {
  job.state = "idle"
  runtime.recordJobEvent(job, eventType, { previousState })

  await runtime.debugJob(adapter, "handleIdleTransition finalizing idle job", job, {
    previousState,
    eventType,
  })

  await captureResult(runtime, adapter, job)
  await relayResult(runtime, adapter, job.jobID)
}
