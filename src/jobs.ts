import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { OpenCodeAdapter } from "./opencode-client.js"
import { normalizeRelayMode } from "./config.js"
import { deliverParentRelay } from "./relay.js"
import { extractSessionID, extractSessionTimestamp, extractStatus } from "./session-extractors.js"
import type {
  BackgroundJob,
  JobLifecycleEvent,
  JobListArgs,
  JobResultSnapshot,
  JobStartArgs,
  JobStatusResult,
  MissionControlJob,
  MissionControlJobResult,
  MissionControlConfig,
  RelayMode,
  ToolResult,
} from "./types.js"
import { fail, ok } from "./types.js"

interface JobStoreSnapshot {
  version: number
  jobs: BackgroundJob[]
  results: JobResultSnapshot[]
  events?: JobLifecycleEvent[]
}

export class MissionControlJobController {
  private static readonly VERSION = 1

  private rootDir: string
  private config: MissionControlConfig
  private readonly jobs = new Map<string, BackgroundJob>()
  private readonly results = new Map<string, JobResultSnapshot>()
  private readonly events = new Map<string, JobLifecycleEvent[]>()
  private readonly childSessionToJobID = new Map<string, string>()
  private launchReservations = 0
  private persistChain = Promise.resolve()

  constructor(rootDir: string, config: MissionControlConfig) {
    this.rootDir = rootDir
    this.config = config
  }

  async start() {
    const snapshot = await this.loadStore()
    if (!snapshot) {
      return
    }

    for (const event of snapshot.events ?? []) {
      const existing = this.events.get(event.jobID) ?? []
      existing.push(event)
      this.events.set(event.jobID, existing)
    }

    let mutated = false

    for (const persistedJob of snapshot.jobs) {
      const job = normalizeLoadedJob(persistedJob, this.config)
      if (isRecoverableJobState(job.state) || (job.state === "idle" && job.relayState !== "delivered")) {
        const previousState = job.state
        job.state = "orphaned"
        job.failureReason = "Mission Control restarted before the background job reached a terminal state."
        job.lastObservedEvent = "runtime.recovered"
        job.updatedAt = Date.now()
        job.completedAt ??= Date.now()
        this.recordJobEvent(job, "runtime.recovered", {
          previousState,
          detail: job.failureReason,
        })
        mutated = true
      }

      this.jobs.set(job.jobID, job)
      if (job.childSessionID && isLiveTrackedJobState(job.state)) {
        this.childSessionToJobID.set(job.childSessionID, job.jobID)
      }
    }

    for (const result of snapshot.results) {
      this.results.set(result.jobID, result)
    }

    if (mutated) {
      await this.persist()
    }
  }

  rebind(rootDir: string, config: MissionControlConfig) {
    this.rootDir = rootDir
    this.config = config
  }

  async createJob(
    args: JobStartArgs,
    parent: {
      sessionID: string
      directory?: string
    },
    options: {
      consumeLaunchReservation?: boolean
    } = {},
  ): Promise<BackgroundJob> {
    const relayMode = args.relay ?? this.config.jobs.autoRelayToParent
    const job: BackgroundJob = {
      jobID: createJobID(),
      parentSessionID: parent.sessionID,
      parentDirectory: parent.directory,
      title: args.title ?? "Mission Control job",
      prompt: args.prompt,
      relayMode,
      state: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastObservedEvent: "job.created",
      relayState: relayMode === "manual" ? "not_requested" : "pending",
    }

    this.jobs.set(job.jobID, job)
    if (options.consumeLaunchReservation) {
      this.releaseLaunchSlot()
    }
    this.recordJobEvent(job, "job.created")
    try {
      await this.persist()
    } catch (error) {
      this.jobs.delete(job.jobID)
      this.events.delete(job.jobID)
      try {
        await this.persist()
      } catch {
        // Best-effort corrective write after rollback.
      }
      throw error
    }
    return job
  }

  async markLaunching(jobID: string) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return
    }

    const previousState = job.state
    job.state = "launching"
    job.updatedAt = Date.now()
    job.lastObservedEvent = "job.launching"
    this.recordJobEvent(job, "job.launching", { previousState })
    await this.persist()
  }

  async bindChildSession(jobID: string, childSessionID: string, childDirectory?: string) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return
    }

    const previousState = job.state
    job.childSessionID = childSessionID
    job.childDirectory = childDirectory
    job.state = "launching"
    job.updatedAt = Date.now()
    job.lastObservedEvent = "job.child_bound"
    this.childSessionToJobID.set(childSessionID, jobID)
    this.recordJobEvent(job, "job.child_bound", { previousState })
    await this.persist()
  }

  async markLaunched(jobID: string, childSessionID: string, childDirectory?: string) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return
    }

    const previousState = job.state
    job.childSessionID = childSessionID
    job.childDirectory = childDirectory
    job.state = "running"
    job.launchedAt = Date.now()
    job.updatedAt = Date.now()
    job.lastObservedEvent = "job.launched"
    this.childSessionToJobID.set(childSessionID, jobID)
    this.recordJobEvent(job, "job.launched", { previousState })
    await this.persist()
  }

  async markLaunchFailed(jobID: string, reason: string) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return
    }

    const previousState = job.state
    job.state = "failed"
    job.failureReason = reason
    job.updatedAt = Date.now()
    job.completedAt = Date.now()
    job.lastObservedEvent = "job.launch_failed"
    this.closeJobTracking(job)
    this.results.set(jobID, {
      jobID,
      childSessionID: job.childSessionID ?? "unknown",
      state: "failed",
      headline: job.title,
      summary: reason,
      blockers: collectBlockers(job),
      recommendedNextStep: undefined,
      keyMessageIDs: [],
      observedAt: Date.now(),
    })
    this.recordJobEvent(job, "job.launch_failed", { previousState, detail: reason })
    await this.persist()
  }

  async markOrphaned(jobID: string, reason: string) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return
    }

    const previousState = job.state
    job.state = "orphaned"
    job.failureReason = reason
    job.updatedAt = Date.now()
    job.completedAt = Date.now()
    job.lastObservedEvent = "job.orphaned"
    this.closeJobTracking(job)
    this.recordJobEvent(job, "job.orphaned", { previousState, detail: reason })
    await this.persist()
  }

  async handleEvent(
    adapter: OpenCodeAdapter,
    type: string,
    payload: unknown,
  ) {
    const sessionID = extractSessionID(payload)
    if (!sessionID) {
      return
    }

    const jobID = this.childSessionToJobID.get(sessionID)
    if (!jobID) {
      return
    }

    const job = this.jobs.get(jobID)
    if (!job) {
      return
    }

    if (isClosedJobState(job.state)) {
      this.closeJobTracking(job)
      await this.persist()
      return
    }

    const previousState = job.state
    const previousSourceUpdatedAt = job.lastSourceUpdatedAt
    const eventUpdatedAt = extractSessionTimestamp(payload, "updated")
    const hasFreshSourceTimestamp =
      eventUpdatedAt === undefined || eventUpdatedAt >= (previousSourceUpdatedAt ?? Number.NEGATIVE_INFINITY)
    const canLeaveIdle =
      previousState !== "idle" ||
      eventUpdatedAt === undefined ||
      eventUpdatedAt > (previousSourceUpdatedAt ?? Number.NEGATIVE_INFINITY)
    job.lastObservedEvent = type

    switch (type) {
      case "permission.asked":
        if (canLeaveIdle) {
          job.state = "waiting_permission"
        }
        this.clearStaleSnapshot(job, previousState)
        this.recordJobEvent(job, type, { previousState })
        break
      case "permission.replied":
        if (canLeaveIdle) {
          job.state = "running"
        }
        this.clearStaleSnapshot(job, previousState)
        this.recordJobEvent(job, type, { previousState })
        break
      case "question.asked":
        if (canLeaveIdle) {
          job.state = "waiting_question"
        }
        this.clearStaleSnapshot(job, previousState)
        this.recordJobEvent(job, type, { previousState })
        break
      case "question.replied":
        if (canLeaveIdle) {
          job.state = "running"
        }
        this.clearStaleSnapshot(job, previousState)
        this.recordJobEvent(job, type, { previousState })
        break
      case "question.rejected":
        job.state = "failed"
        job.failureReason = "Question rejected"
        job.completedAt = Date.now()
        this.recordJobEvent(job, type, { previousState, detail: job.failureReason })
        await this.captureResult(adapter, job)
        this.closeJobTracking(job)
        if (job.relayMode === "on_completion") {
          await this.relayResult(adapter, job.jobID)
        }
        break
      case "session.error":
        job.state = "failed"
        job.failureReason = "Child session reported an error"
        job.completedAt = Date.now()
        this.recordJobEvent(job, type, { previousState, detail: job.failureReason })
        await this.captureResult(adapter, job)
        this.closeJobTracking(job)
        if (job.relayMode === "on_completion") {
          await this.relayResult(adapter, job.jobID)
        }
        break
      case "session.idle":
        if (hasFreshSourceTimestamp) {
          await this.handleIdleTransition(adapter, job, previousState, type)
        }
        break
      case "session.status":
        const sessionStatus = extractStatus(payload)

        if (sessionStatus === "idle") {
          if (hasFreshSourceTimestamp) {
            await this.handleIdleTransition(adapter, job, previousState, type)
          }
          break
        } else if (sessionStatus === "waiting_permission" && canLeaveIdle) {
          job.state = "waiting_permission"
        } else if (sessionStatus === "waiting_question" && canLeaveIdle) {
          job.state = "waiting_question"
        } else if (
          job.state !== "waiting_permission" &&
          job.state !== "waiting_question" &&
          canLeaveIdle
        ) {
          job.state = "running"
        }
        this.clearStaleSnapshot(job, previousState)
        this.recordJobEvent(job, type, {
          previousState: previousState !== job.state ? previousState : undefined,
        })
        break
      case "message.updated":
      case "message.part.updated":
        if (
          previousState === "idle" &&
          eventUpdatedAt !== undefined &&
          eventUpdatedAt > (previousSourceUpdatedAt ?? Number.NEGATIVE_INFINITY)
        ) {
          job.state = "running"
        }
        this.clearStaleSnapshot(job, previousState)
        this.recordJobEvent(job, type, {
          previousState: previousState !== job.state ? previousState : undefined,
        })
        break
      default:
        return
    }

    job.updatedAt = Date.now()
    if (eventUpdatedAt !== undefined) {
      job.lastSourceUpdatedAt = Math.max(job.lastSourceUpdatedAt ?? Number.NEGATIVE_INFINITY, eventUpdatedAt)
    }
    await this.persist()
  }

  listJobs(args: JobListArgs = {}) {
    const jobs = Array.from(this.jobs.values())
      .filter((job) => (args.sessionId ? job.parentSessionID === args.sessionId : true))
      .filter((job) => (args.state ? job.state === args.state : true))
      .sort((left, right) => right.updatedAt - left.updatedAt)

    return ok(jobs.slice(0, args.limit ?? 20).map(toPublicJob))
  }

  status(jobID: string): ToolResult<JobStatusResult> {
    const job = this.jobs.get(jobID)
    if (!job) {
      return fail("JobNotFound", `Job '${jobID}' was not found.`)
    }

    const storedResult = this.results.get(jobID)

    return ok({
      job: toPublicJob(job),
      result: canExposeStoredResult(job.state, Boolean(storedResult)) ? toPublicJobResult(storedResult) : undefined,
    })
  }

  async cancelJob(adapter: OpenCodeAdapter, jobID: string) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return fail("JobNotFound", `Job '${jobID}' was not found.`)
    }

    if (isClosedJobState(job.state)) {
      return fail(
        "JobLaunchFailed",
        `Job '${jobID}' is already finalized and cannot be cancelled.`,
        "Inspect the stored result instead of cancelling a closed job.",
      )
    }

    if (job.childSessionID) {
      await adapter.abortSession(job.childSessionID, job.childDirectory)
    }

    const previousState = job.state
    job.state = "aborted"
    job.updatedAt = Date.now()
    job.completedAt = Date.now()
    job.lastObservedEvent = "job.cancelled"
    this.recordJobEvent(job, "job.cancelled", { previousState })
    this.results.set(jobID, {
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
    this.closeJobTracking(job)
    if (job.relayMode === "on_completion") {
      await this.relayResult(adapter, jobID)
    }
    await this.persist()
    return ok(toPublicJob(job))
  }

  async getResult(adapter: OpenCodeAdapter, jobID: string, sendToParent: boolean) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return fail("JobNotFound", `Job '${jobID}' was not found.`)
    }

    if (!canExposeStoredResult(job.state, this.results.has(jobID))) {
      return fail(
        "JobLaunchFailed",
        `Job '${jobID}' does not have a stable result snapshot yet.`,
        "Wait for the child session to become idle, failed, aborted, or completed, then retry.",
      )
    }

    let result = this.results.get(jobID)
    if (!result && job.childSessionID) {
      result = await this.captureResult(adapter, job)
    }

    if (!result) {
      return fail(
        "JobLaunchFailed",
        `Job '${jobID}' does not have a stable result snapshot yet.`,
        "Wait for the child session to become idle or failed, then retry.",
      )
    }

    if (sendToParent) {
      const relayResult = await this.relayResult(adapter, jobID, { force: true })
      if (!relayResult.ok) {
        return relayResult
      }
    }

    return ok(toPublicJobResult(result))
  }

  async relayResult(
    adapter: OpenCodeAdapter,
    jobID: string,
    options: {
      force?: boolean
    } = {},
  ) {
    const job = this.jobs.get(jobID)
    const result = this.results.get(jobID)

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

    if (!isStableResultState(job.state)) {
      return fail(
        "JobLaunchFailed",
        `Job '${jobID}' is not in a stable state for relay yet.`,
        "Wait for the child session to become idle, failed, aborted, or completed before relaying.",
      )
    }

    if (job.relayState === "delivered" && !options.force) {
      return ok({
        job,
        result,
      })
    }

    try {
      await deliverParentRelay(adapter, job, result)
      const previousState = job.state
      job.relayState = "delivered"
      if (job.state === "idle") {
        this.markCompleted(job)
        this.updateSnapshotState(job.jobID, "completed")
      }
      this.closeJobTracking(job)
      job.updatedAt = Date.now()
      job.lastObservedEvent = options.force ? "job.relay_forced" : "job.relay_delivered"
      this.recordJobEvent(job, job.lastObservedEvent, {
        previousState: previousState !== job.state ? previousState : undefined,
      })
      await this.persist()
      return ok({
        job,
        result,
      })
    } catch {
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
      this.recordJobEvent(job, "job.relay_failed")
      await this.persist()
      return fail(
        "JobLaunchFailed",
        `Failed to relay the result for job '${jobID}' to its parent session.`,
        "Inspect the parent session and retry relay manually.",
      )
    }
  }

  getActiveJobCount() {
    return this.launchReservations +
      Array.from(this.jobs.values()).filter((job) =>
      ["queued", "launching", "running", "waiting_permission", "waiting_question"].includes(job.state) ||
        (job.state === "idle" &&
          Boolean(job.childSessionID) &&
          this.childSessionToJobID.get(job.childSessionID ?? "") === job.jobID),
      ).length
  }

  tryReserveLaunchSlot(maxConcurrent: number) {
    if (this.getActiveJobCount() >= maxConcurrent) {
      return false
    }

    this.launchReservations += 1
    return true
  }

  releaseLaunchSlot() {
    this.launchReservations = Math.max(0, this.launchReservations - 1)
  }

  private async captureResult(adapter: OpenCodeAdapter, job: BackgroundJob) {
    if (!job.childSessionID) {
      return undefined
    }

    let snapshot: JobResultSnapshot

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
        summary:
          truncateSummary(buildStructuredSummary(structuredReport) || rawReport) || defaultSummaryForState(job),
        blockers: mergeBlockers(job, structuredReport.blockers),
        recommendedNextStep: structuredReport.recommendedNextStep,
        keyMessageIDs: keyMessageID ? [keyMessageID] : [],
        observedAt: Date.now(),
      }
    } catch {
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
    }

    this.results.set(job.jobID, snapshot)
    await this.persist()
    return snapshot
  }

  private getStorePath() {
    return join(getMissionControlCacheRoot(this.rootDir), "jobs.json")
  }

  private async loadStore(): Promise<JobStoreSnapshot | undefined> {
    try {
      const content = await readFile(this.getStorePath(), "utf8")
      const snapshot = JSON.parse(content) as JobStoreSnapshot
      if (snapshot.version !== MissionControlJobController.VERSION) {
        return undefined
      }

      return snapshot
    } catch {
      return undefined
    }
  }

  private async persist() {
    const writeSnapshot = async () => {
      const snapshot: JobStoreSnapshot = {
        version: MissionControlJobController.VERSION,
        jobs: Array.from(this.jobs.values()),
        results: Array.from(this.results.values()),
        events: Array.from(this.events.values()).flat(),
      }

      const storePath = this.getStorePath()
      await mkdir(dirname(storePath), { recursive: true })
      await writeFile(storePath, JSON.stringify(snapshot, null, 2), "utf8")
    }

    this.persistChain = this.persistChain.then(writeSnapshot, writeSnapshot)
    await this.persistChain
  }

  private closeJobTracking(job: BackgroundJob) {
    if (job.childSessionID) {
      this.childSessionToJobID.delete(job.childSessionID)
    }
  }

  private markCompleted(job: BackgroundJob) {
    job.state = "completed"
    job.completedAt = Date.now()
  }

  private updateSnapshotState(jobID: string, state: JobResultSnapshot["state"]) {
    const snapshot = this.results.get(jobID)
    if (!snapshot) {
      return
    }

    snapshot.state = state
    snapshot.observedAt = Date.now()
  }

  private async handleIdleTransition(
    adapter: OpenCodeAdapter,
    job: BackgroundJob,
    previousState: BackgroundJob["state"],
    eventType: string,
  ) {
    job.state = "idle"
    this.recordJobEvent(job, eventType, { previousState })

    if (job.relayMode === "manual") {
      const previousIdleState = job.state
      this.markCompleted(job)
      await this.captureResult(adapter, job)
      this.recordJobEvent(job, "job.completed", { previousState: previousIdleState })
      this.closeJobTracking(job)
      return
    }

    await this.captureResult(adapter, job)

    if (job.relayMode === "on_idle" || job.relayMode === "on_completion") {
      await this.relayResult(adapter, job.jobID)
    }
  }

  private clearStaleSnapshot(job: BackgroundJob, previousState: BackgroundJob["state"]) {
    if (isStableResultState(previousState) && !isStableResultState(job.state)) {
      this.results.delete(job.jobID)
    }
  }

  private recordJobEvent(
    job: BackgroundJob,
    type: string,
    options: {
      previousState?: BackgroundJob["state"]
      detail?: string
    } = {},
  ) {
    const event: JobLifecycleEvent = {
      eventID: createJobEventID(job.jobID),
      jobID: job.jobID,
      parentSessionID: job.parentSessionID,
      childSessionID: job.childSessionID,
      type,
      state: job.state,
      previousState: options.previousState,
      at: Date.now(),
      detail: options.detail,
    }

    const events = this.events.get(job.jobID) ?? []
    events.push(event)
    this.events.set(job.jobID, events)
  }
}

const createJobID = () => `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
const createJobEventID = (jobID: string) => `${jobID}-evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

const getMissionControlCacheRoot = (rootDir: string) => {
  const xdgCache = process.env.XDG_CACHE_HOME?.trim()
  const home = process.env.HOME?.trim() || homedir()
  const baseDir = xdgCache || (home ? join(home, ".cache") : tmpdir())
  return join(baseDir, "opencode-mission-control", scopeKey(rootDir))
}

const scopeKey = (rootDir: string) => createHash("sha1").update(rootDir || "default").digest("hex").slice(0, 16)

const mapJobStateToSnapshotState = (state: BackgroundJob["state"]): JobResultSnapshot["state"] => {
  switch (state) {
    case "failed":
      return "failed"
    case "aborted":
      return "aborted"
    case "completed":
      return "completed"
    default:
      return "idle"
  }
}

const collectMessagePartsText = (parts: any[]) => {
  const text = parts
    .map((part) => {
      if (typeof part?.text === "string") {
        return part.text
      }

      if (part?.state && typeof part.state === "object") {
        if (typeof part.state.output === "string") {
          return part.state.output
        }

        if (typeof part.state.error === "string") {
          return part.state.error
        }
      }

      return ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()

  return text.length > 0 ? text : ""
}

const truncateSummary = (text: string | undefined) => {
  if (!text) {
    return ""
  }

  return text.length > 0 ? text.slice(0, 1200) : ""
}

const defaultSummaryForState = (job: BackgroundJob) => {
  if (job.failureReason) {
    return job.failureReason
  }

  switch (job.state) {
    case "waiting_permission":
      return "The child session is waiting on a permission decision."
    case "waiting_question":
      return "The child session is waiting on an answered question."
    case "aborted":
      return "The job was aborted before completion."
    default:
      return "The child session reached a stable state without a richer final summary yet."
  }
}

const collectBlockers = (job: BackgroundJob) => {
  const blockers: string[] = []

  if (job.state === "waiting_permission") {
    blockers.push("Waiting on permission approval")
  }

  if (job.state === "waiting_question") {
    blockers.push("Waiting on a question response")
  }

  if (job.failureReason) {
    blockers.push(job.failureReason)
  }

  return blockers
}

const mergeBlockers = (job: BackgroundJob, reportedBlockers: string[]) => {
  return Array.from(new Set([...collectBlockers(job), ...reportedBlockers]))
}

const normalizeLoadedJob = (job: BackgroundJob, config: MissionControlConfig): BackgroundJob => {
  const relayMode = normalizeRelayMode(job.relayMode, config.jobs.autoRelayToParent)
  return {
    ...job,
    relayMode,
    relayState: job.relayState ?? (relayMode === "manual" ? "not_requested" : "pending"),
    lastSourceUpdatedAt: job.lastSourceUpdatedAt,
  }
}

const toPublicJob = (job: BackgroundJob): MissionControlJob => ({
  jobId: job.jobID,
  sessionId: job.parentSessionID,
  parentDirectory: job.parentDirectory,
  childSessionId: job.childSessionID,
  childDirectory: job.childDirectory,
  title: job.title,
  prompt: job.prompt,
  relay: job.relayMode,
  state: job.state,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  launchedAt: job.launchedAt,
  completedAt: job.completedAt,
  failureReason: job.failureReason,
  lastObservedEvent: job.lastObservedEvent,
  lastSourceUpdatedAt: job.lastSourceUpdatedAt,
  relayState: job.relayState,
})

const toPublicJobResult = (result: JobResultSnapshot | undefined): MissionControlJobResult | undefined =>
  result
    ? {
        jobId: result.jobID,
        childSessionId: result.childSessionID,
        state: result.state,
        headline: result.headline,
        summary: result.summary,
        blockers: result.blockers,
        recommendedNextStep: result.recommendedNextStep,
        keyMessageIds: result.keyMessageIDs,
        observedAt: result.observedAt,
      }
    : undefined

const parseStructuredFinalReport = (text: string) => {
  const sections: Record<string, string[]> = {}
  let currentSection: string | undefined

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    const matchedHeading = matchStructuredHeading(line)
    if (matchedHeading) {
      currentSection = matchedHeading.section
      sections[currentSection] ??= []
      if (matchedHeading.remainder) {
        sections[currentSection].push(matchedHeading.remainder)
      }
      continue
    }

    if (!currentSection || !line) {
      continue
    }

    sections[currentSection] ??= []
    sections[currentSection].push(line)
  }

  return {
    summary: joinStructuredSection(sections.summary),
    keyFindings: joinStructuredSection(sections.keyFindings),
    blockers: normalizeStructuredBlockers(joinStructuredSection(sections.blockers)),
    recommendedNextStep: joinStructuredSection(sections.recommendedNextStep),
  }
}

const buildStructuredSummary = (report: {
  summary?: string
  keyFindings?: string
}) => {
  const segments = [report.summary]

  if (report.keyFindings) {
    segments.push(`Key Findings:\n${report.keyFindings}`)
  }

  const summary = segments.filter(Boolean).join("\n\n").trim()
  return summary ? summary : undefined
}

const matchStructuredHeading = (line: string) => {
  const match = /^(?:[-*#]+\s*)?(Status|Summary|Key Findings|Blockers|Recommended Next Step)\s*:?[ \t]*(.*)$/i.exec(
    line,
  )
  if (!match) {
    return undefined
  }

  const heading = match[1]?.toLowerCase()
  const remainder = match[2]?.trim()
  const section =
    heading === "recommended next step"
      ? "recommendedNextStep"
      : heading === "key findings"
        ? "keyFindings"
        : heading

  return {
    section,
    remainder,
  }
}

const joinStructuredSection = (lines: string[] | undefined) => {
  const value = lines?.join("\n").trim()
  return value ? value : undefined
}

const normalizeStructuredBlockers = (blockers: string | undefined) => {
  if (!blockers) {
    return []
  }

  if (/^none\.?$/i.test(blockers)) {
    return []
  }

  const entries = blockers
    .split(/\n|;|•|^- /gm)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^[-*]\s*/, ""))
    .filter(Boolean)

  if (entries.every((entry) => /^none\.?$/i.test(entry))) {
    return []
  }

  return entries
}

const isStableResultState = (state: BackgroundJob["state"]) =>
  ["idle", "completed", "failed", "aborted"].includes(state)

const canExposeStoredResult = (state: BackgroundJob["state"], hasStoredResult: boolean) =>
  isStableResultState(state) || (state === "orphaned" && hasStoredResult)

const isClosedJobState = (state: BackgroundJob["state"]) =>
  ["completed", "failed", "aborted", "orphaned"].includes(state)

const isRecoverableJobState = (state: BackgroundJob["state"]) =>
  ["queued", "launching", "running", "waiting_permission", "waiting_question"].includes(state)

const isLiveTrackedJobState = (state: BackgroundJob["state"]) =>
  ["queued", "launching", "running", "waiting_permission", "waiting_question"].includes(state)
