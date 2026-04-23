import type { OpenCodeAdapter } from "./opencode-client.js"
import {
  cancelJob as performCancelJob,
  rejectQuestion as performRejectQuestion,
  replyPermission as performReplyPermission,
  replyQuestion as performReplyQuestion,
} from "./jobs/actions.js"
import { debugJob as emitJobDebug } from "./jobs/debug.js"
import { handleTrackedJobEvent } from "./jobs/event-handler.js"
import { maxPersistedJobEvents as getMaxPersistedJobEvents, recordJobEvent as appendJobEvent } from "./jobs/events.js"
import {
  captureResult as captureJobResult,
  clearStaleSnapshot as clearStoredJobSnapshot,
  closeJobTracking as stopJobTracking,
  handleIdleTransition as finalizeIdleTransition,
  relayResult as relayJobResult,
} from "./jobs/finalization.js"
import {
  safeDeliverBlockedStateRelay as notifyBlockedState,
  safeDeliverPendingInputRelay as notifyPendingInput,
  safeDeliverProgressRelay as notifyProgress,
} from "./jobs/notifications.js"
import type { LocalPermissionReplyIntent } from "./jobs/permission-replies.js"
import {
  resolvePendingPermissionRequest as findPendingPermissionRequest,
  resolvePendingQuestionRequest as findPendingQuestionRequest,
} from "./jobs/pending-input.js"
import { updateProgress as performJobProgressUpdate } from "./jobs/progress.js"
import { getResult as readJobResult, jobEvents as readJobEvents, listJobs as listTrackedJobs, status as readJobStatus } from "./jobs/query.js"
import { resolveCallerSessionID as resolveCallerSession, validateParentCaller as validateJobParentCaller } from "./jobs/session-auth.js"
import { enqueueJobStorePersist, loadJobStore, type JobStoreSnapshot } from "./jobs/store.js"
import { collectBlockers, createJobID, isLiveTrackedJobState, isRecoverableJobState, normalizeLoadedJob } from "./job-helpers.js"
import type {
  BackgroundJob,
  JobLifecycleEvent,
  JobListArgs,
  JobPendingInput,
  JobPendingPermissionRequest,
  JobPendingQuestionRequest,
  JobPermissionReplyArgs,
  JobProgressUpdateArgs,
  JobQuestionReplyArgs,
  JobResultSnapshot,
  JobStartArgs,
  MissionControlConfig,
  ToolCallerContext,
} from "./types.js"

export class MissionControlJobController {
  private static readonly VERSION = 2

  private rootDir: string
  private config: MissionControlConfig
  private readonly jobs = new Map<string, BackgroundJob>()
  private readonly results = new Map<string, JobResultSnapshot>()
  private readonly events = new Map<string, JobLifecycleEvent[]>()
  private readonly childSessionToJobID = new Map<string, string>()
  private readonly recentLocalPermissionReplies = new Map<string, LocalPermissionReplyIntent>()
  private launchReservations = 0
  private persistChain = Promise.resolve()
  private lastLoadWarning: string | undefined

  constructor(rootDir: string, config: MissionControlConfig) {
    this.rootDir = rootDir
    this.config = config
  }

  async start() {
    this.lastLoadWarning = undefined
    const snapshot = await this.loadStore()
    if (!snapshot) {
      return
    }

    for (const event of snapshot.events ?? []) {
      const existing = this.events.get(event.jobID) ?? []
      existing.push(event)
      this.events.set(event.jobID, existing.slice(-getMaxPersistedJobEvents(this.config)))
    }

    let mutated = false

    for (const persistedJob of snapshot.jobs) {
      const job = normalizeLoadedJob(persistedJob)
      if (isRecoverableJobState(job.state) || (job.state === "idle" && job.relayState !== "delivered")) {
        const previousState = job.state
        job.state = "orphaned"
        job.pendingInput = undefined
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

  clearRecoveredState() {
    this.jobs.clear()
    this.results.clear()
    this.events.clear()
    this.childSessionToJobID.clear()
    this.recentLocalPermissionReplies.clear()
    this.launchReservations = 0
    this.persistChain = Promise.resolve()
  }

  consumeLoadWarning() {
    const warning = this.lastLoadWarning
    this.lastLoadWarning = undefined
    return warning
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
    const job: BackgroundJob = {
      jobID: createJobID(),
      parentSessionID: parent.sessionID,
      parentDirectory: parent.directory,
      title: args.title ?? "Mission Control job",
      prompt: args.prompt,
      state: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastObservedEvent: "job.created",
      relayState: "pending",
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

  async handleEvent(adapter: OpenCodeAdapter, type: string, payload: unknown) {
    return handleTrackedJobEvent(this.getRuntime(), adapter, type, payload)
  }

  listJobs(args: JobListArgs = {}) {
    return listTrackedJobs(this.getRuntime(), args)
  }

  status(jobID: string) {
    return readJobStatus(this.getRuntime(), jobID)
  }

  jobEvents(jobID: string, limit = 20) {
    return readJobEvents(this.getRuntime(), jobID, limit)
  }

  async updateProgress(adapter: OpenCodeAdapter, args: JobProgressUpdateArgs, caller: ToolCallerContext = {}) {
    return performJobProgressUpdate(this.getRuntime(), adapter, args, caller)
  }

  async replyPermission(adapter: OpenCodeAdapter, args: JobPermissionReplyArgs, caller: ToolCallerContext = {}) {
    return performReplyPermission(this.getRuntime(), adapter, args, caller)
  }

  async replyQuestion(adapter: OpenCodeAdapter, args: JobQuestionReplyArgs, caller: ToolCallerContext = {}) {
    return performReplyQuestion(this.getRuntime(), adapter, args, caller)
  }

  async rejectQuestion(adapter: OpenCodeAdapter, jobID: string, caller: ToolCallerContext = {}) {
    return performRejectQuestion(this.getRuntime(), adapter, jobID, caller)
  }

  async cancelJob(adapter: OpenCodeAdapter, jobID: string, caller: ToolCallerContext = {}) {
    return performCancelJob(this.getRuntime(), adapter, jobID, caller)
  }

  async getResult(adapter: OpenCodeAdapter, jobID: string, sendToParent: boolean, caller: ToolCallerContext = {}) {
    return readJobResult(this.getRuntime(), adapter, jobID, sendToParent, caller)
  }

  async relayResult(
    adapter: OpenCodeAdapter,
    jobID: string,
    options: {
      force?: boolean
    } = {},
  ) {
    return relayJobResult(this.getRuntime(), adapter, jobID, options)
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

  private getRuntime() {
    return {
      jobs: this.jobs,
      results: this.results,
      events: this.events,
      childSessionToJobID: this.childSessionToJobID,
      recentLocalPermissionReplies: this.recentLocalPermissionReplies,
      persist: () => this.persist(),
      recordJobEvent: (job: BackgroundJob, type: string, options?: Parameters<typeof this.recordJobEvent>[2]) =>
        this.recordJobEvent(job, type, options),
      debugJob: (adapter: OpenCodeAdapter, message: string, job: BackgroundJob, extra?: Record<string, unknown>) =>
        this.debugJob(adapter, message, job, extra),
      jobForChildSession: (sessionID: string) => this.jobForChildSession(sessionID),
      resolveCallerSessionID: (adapter: OpenCodeAdapter, caller: ToolCallerContext) => this.resolveCallerSessionID(adapter, caller),
      validateParentCaller: (adapter: OpenCodeAdapter, job: BackgroundJob, caller: ToolCallerContext) =>
        this.validateParentCaller(adapter, job, caller),
      resolvePendingPermissionRequest: (adapter: OpenCodeAdapter, job: BackgroundJob, sessionID: string, payload: unknown) =>
        this.resolvePendingPermissionRequest(adapter, job, sessionID, payload),
      resolvePendingQuestionRequest: (adapter: OpenCodeAdapter, job: BackgroundJob, sessionID: string, payload: unknown) =>
        this.resolvePendingQuestionRequest(adapter, job, sessionID, payload),
      captureResult: (adapter: OpenCodeAdapter, job: BackgroundJob) => this.captureResult(adapter, job),
      relayResult: (adapter: OpenCodeAdapter, jobID: string, options?: { force?: boolean }) =>
        this.relayResult(adapter, jobID, options),
      handleIdleTransition: (adapter: OpenCodeAdapter, job: BackgroundJob, previousState: BackgroundJob["state"], eventType: string) =>
        this.handleIdleTransition(adapter, job, previousState, eventType),
      clearStaleSnapshot: (job: BackgroundJob, previousState: BackgroundJob["state"]) => this.clearStaleSnapshot(job, previousState),
      closeJobTracking: (job: BackgroundJob) => this.closeJobTracking(job),
      safeDeliverPendingInputRelay: (adapter: OpenCodeAdapter, job: BackgroundJob, pendingInput: JobPendingInput) =>
        this.safeDeliverPendingInputRelay(adapter, job, pendingInput),
      safeDeliverBlockedStateRelay: (adapter: OpenCodeAdapter, job: BackgroundJob, kind: "permission" | "question") =>
        this.safeDeliverBlockedStateRelay(adapter, job, kind),
      safeDeliverProgressRelay: (adapter: OpenCodeAdapter, job: BackgroundJob, message: string) =>
        this.safeDeliverProgressRelay(adapter, job, message),
    }
  }

  private jobForChildSession(sessionID: string) {
    const jobID = this.childSessionToJobID.get(sessionID)
    return jobID ? this.jobs.get(jobID) : undefined
  }

  private async resolveCallerSessionID(adapter: OpenCodeAdapter, caller: ToolCallerContext) {
    return resolveCallerSession(adapter, caller)
  }

  private async validateParentCaller(adapter: OpenCodeAdapter, job: BackgroundJob, caller: ToolCallerContext) {
    return validateJobParentCaller(adapter, job, caller)
  }

  private async resolvePendingPermissionRequest(
    adapter: OpenCodeAdapter,
    job: BackgroundJob,
    sessionID: string,
    payload: unknown,
  ): Promise<JobPendingPermissionRequest | undefined> {
    return findPendingPermissionRequest(adapter, job, sessionID, payload)
  }

  private async resolvePendingQuestionRequest(
    adapter: OpenCodeAdapter,
    job: BackgroundJob,
    sessionID: string,
    payload: unknown,
  ): Promise<JobPendingQuestionRequest | undefined> {
    return findPendingQuestionRequest(adapter, job, sessionID, payload)
  }

  private async captureResult(adapter: OpenCodeAdapter, job: BackgroundJob) {
    return captureJobResult(this.getRuntime(), adapter, job)
  }

  private async loadStore(): Promise<JobStoreSnapshot | undefined> {
    const loaded = await loadJobStore(this.rootDir, MissionControlJobController.VERSION)
    this.lastLoadWarning = loaded.warning
    return loaded.snapshot
  }

  private async persist() {
    this.persistChain = enqueueJobStorePersist(this.persistChain, this.rootDir, {
      version: MissionControlJobController.VERSION,
      jobs: Array.from(this.jobs.values()),
      results: Array.from(this.results.values()),
      events: Array.from(this.events.values()).flat(),
    })
    await this.persistChain
  }

  private closeJobTracking(job: BackgroundJob) {
    stopJobTracking(this.getRuntime(), job)
  }

  private async handleIdleTransition(
    adapter: OpenCodeAdapter,
    job: BackgroundJob,
    previousState: BackgroundJob["state"],
    eventType: string,
  ) {
    return finalizeIdleTransition(this.getRuntime(), adapter, job, previousState, eventType)
  }

  private clearStaleSnapshot(job: BackgroundJob, previousState: BackgroundJob["state"]) {
    clearStoredJobSnapshot(this.getRuntime(), job, previousState)
  }

  private async safeDeliverPendingInputRelay(
    adapter: OpenCodeAdapter,
    job: BackgroundJob,
    pendingInput: JobPendingInput,
  ) {
    return notifyPendingInput(this.getRuntime(), adapter, job, pendingInput)
  }

  private async safeDeliverBlockedStateRelay(
    adapter: OpenCodeAdapter,
    job: BackgroundJob,
    kind: "permission" | "question",
  ) {
    return notifyBlockedState(this.getRuntime(), adapter, job, kind)
  }

  private async safeDeliverProgressRelay(adapter: OpenCodeAdapter, job: BackgroundJob, message: string) {
    return notifyProgress(this.getRuntime(), adapter, job, message)
  }

  private async debugJob(
    adapter: OpenCodeAdapter,
    message: string,
    job: BackgroundJob,
    extra: Record<string, unknown> = {},
  ) {
    await emitJobDebug(adapter, message, job, extra)
  }

  private recordJobEvent(
    job: BackgroundJob,
    type: string,
    options: {
      previousState?: BackgroundJob["state"]
      detail?: string
      metadata?: Record<string, unknown>
    } = {},
  ): JobLifecycleEvent {
    return appendJobEvent(this.events, this.config, job, type, options)
  }
}
