import type { OpenCodeAdapter } from "../opencode-client.js"
import {
  canExposeStoredResult,
  toPublicJob,
  toPublicJobEvent,
  toPublicJobResult,
  toPublicPendingInput,
} from "../job-helpers.js"
import type {
  BackgroundJob,
  JobEventsResult,
  JobLifecycleEvent,
  JobListArgs,
  JobPendingInputResult,
  JobResultSnapshot,
  JobStatusResult,
  ToolCallerContext,
  ToolFailure,
  ToolResult,
} from "../types.js"
import { fail, ok } from "../types.js"

export interface JobQueryRuntime {
  jobs: Map<string, BackgroundJob>
  results: Map<string, JobResultSnapshot>
  events: Map<string, JobLifecycleEvent[]>
  captureResult(adapter: OpenCodeAdapter, job: BackgroundJob): Promise<JobResultSnapshot | undefined>
  relayResult(
    adapter: OpenCodeAdapter,
    jobID: string,
    options?: { force?: boolean },
  ): Promise<ToolResult<{ job: BackgroundJob; result: JobResultSnapshot }>>
  validateParentCaller(
    adapter: OpenCodeAdapter,
    job: BackgroundJob,
    caller: ToolCallerContext,
  ): Promise<string | ToolFailure>
}

export const listJobs = (runtime: Pick<JobQueryRuntime, "jobs" | "results">, args: JobListArgs = {}) => {
  const jobs = Array.from(runtime.jobs.values())
    .filter((job) => (args.sessionId ? job.parentSessionID === args.sessionId : true))
    .filter((job) => (args.state ? job.state === args.state : true))
    .sort((left, right) => right.updatedAt - left.updatedAt)

  return ok(
    jobs.slice(0, args.limit ?? 20).map((job) =>
      toPublicJob(job, canExposeStoredResult(job.state, runtime.results.has(job.jobID))),
    ),
  )
}

export const status = (runtime: Pick<JobQueryRuntime, "jobs" | "results">, jobID: string): ToolResult<JobStatusResult> => {
  const job = runtime.jobs.get(jobID)
  if (!job) {
    return fail("JobNotFound", `Job '${jobID}' was not found.`)
  }

  const storedResult = runtime.results.get(jobID)

  return ok({
    job: toPublicJob(job, canExposeStoredResult(job.state, Boolean(storedResult))),
  })
}

export const pendingInput = (
  runtime: Pick<JobQueryRuntime, "jobs">,
  jobID: string,
): ToolResult<JobPendingInputResult> => {
  const job = runtime.jobs.get(jobID)
  if (!job) {
    return fail("JobNotFound", `Job '${jobID}' was not found.`)
  }

  const pending = toPublicPendingInput(job)
  if (!pending) {
    return fail(
      "JobLaunchFailed",
      `Job '${jobID}' does not have actionable pending input details right now.`,
      "Use mc_job_status to inspect the current state and retry this tool if the job becomes blocked again.",
    )
  }

  return ok({
    jobId: jobID,
    state: job.state,
    pendingInput: pending,
  })
}

export const jobEvents = (
  runtime: Pick<JobQueryRuntime, "jobs" | "events">,
  jobID: string,
  limit = 20,
): ToolResult<JobEventsResult> => {
  const job = runtime.jobs.get(jobID)
  if (!job) {
    return fail("JobNotFound", `Job '${jobID}' was not found.`)
  }

  const boundedLimit = Math.max(1, Math.trunc(limit || 20))
  const events = (runtime.events.get(jobID) ?? []).slice(-boundedLimit).reverse().map(toPublicJobEvent)

  return ok({
    jobId: jobID,
    events,
  })
}

export const getResult = async (
  runtime: JobQueryRuntime,
  adapter: OpenCodeAdapter,
  jobID: string,
  sendToParent: boolean,
  caller: ToolCallerContext = {},
) => {
  const job = runtime.jobs.get(jobID)
  if (!job) {
    return fail("JobNotFound", `Job '${jobID}' was not found.`)
  }

  if (!canExposeStoredResult(job.state, runtime.results.has(jobID))) {
    return fail(
      "JobLaunchFailed",
      `Job '${jobID}' does not have a stable result snapshot yet.`,
      "Wait for the child session to become idle, failed, aborted, or completed, then retry.",
    )
  }

  let result = runtime.results.get(jobID)
  if (!result && job.childSessionID) {
    result = await runtime.captureResult(adapter, job)
  }

  if (!result) {
    return fail(
      "JobLaunchFailed",
      `Job '${jobID}' does not have a stable result snapshot yet.`,
      "Wait for the child session to become idle or failed, then retry.",
    )
  }

  if (sendToParent) {
    if (!adapter.supportsResultRelay()) {
      return fail(
        "JobLaunchFailed",
        `The current OpenCode runtime cannot relay job '${jobID}' results back to the parent session.`,
      )
    }
    const callerValidation = await runtime.validateParentCaller(adapter, job, caller)
    if (typeof callerValidation !== "string") {
      return callerValidation
    }
    const relayResult = await runtime.relayResult(adapter, jobID, { force: true })
    if (!relayResult.ok) {
      return relayResult
    }
  }

  return ok(toPublicJobResult(result))
}
