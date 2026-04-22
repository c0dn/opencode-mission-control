import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { OpenCodeAdapter } from "./opencode-client.js"
import { deliverBlockedStateRelay, deliverParentRelay, deliverPendingInputRelay, deliverProgressRelay } from "./relay.js"
import {
  extractPermissionRequest,
  extractQuestionRequest,
  extractRequestID,
  extractSessionID,
  extractSessionTimestamp,
  extractStatus,
} from "./session-extractors.js"
import type {
  BackgroundJob,
  JobEventsResult,
  JobLifecycleEvent,
  JobListArgs,
  JobPendingInput,
  JobPendingPermissionRequest,
  JobPendingQuestionRequest,
  JobPermissionReplyArgs,
  JobProgressUpdateArgs,
  JobProgressUpdateResult,
  JobQuestionReplyArgs,
  JobResultSnapshot,
  JobStartArgs,
  JobStatusResult,
  MissionControlJob,
  MissionControlJobEvent,
  MissionControlJobResult,
  MissionControlConfig,
  PendingInputKind,
  ToolCallerContext,
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
  private static readonly VERSION = 2

  private rootDir: string
  private config: MissionControlConfig
  private readonly jobs = new Map<string, BackgroundJob>()
  private readonly results = new Map<string, JobResultSnapshot>()
  private readonly events = new Map<string, JobLifecycleEvent[]>()
  private readonly childSessionToJobID = new Map<string, string>()
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
      this.events.set(event.jobID, existing.slice(-this.maxPersistedJobEvents()))
    }

    let mutated = false

    for (const persistedJob of snapshot.jobs) {
      const job = normalizeLoadedJob(persistedJob, this.config)
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
        const permissionRequest = await this.resolvePendingPermissionRequest(adapter, job, sessionID, payload)
        if (permissionRequest && isResolvedPendingRequest(job, "permission", permissionRequest.requestId)) {
          return
        }
        if (permissionRequest && hasConflictingPendingInput(job, permissionRequest)) {
          return
        }
        const effectivePermissionRequest =
          permissionRequest ?? (job.pendingInput?.kind === "permission" ? job.pendingInput : undefined)
        const shouldNotifyPermission = permissionRequest ? !isSamePendingInput(job.pendingInput, permissionRequest) : false
        if (canLeaveIdle && (effectivePermissionRequest || !job.pendingInput)) {
          job.state = "waiting_permission"
        }
        if (permissionRequest) {
          job.pendingInput = permissionRequest
        }
        this.clearStaleSnapshot(job, previousState)
        this.recordJobEvent(job, type, {
          previousState,
          detail: describePendingInput(effectivePermissionRequest) ?? "Waiting on permission approval.",
          metadata: effectivePermissionRequest ? { pendingInput: effectivePermissionRequest } : undefined,
        })
        if (permissionRequest && shouldNotifyPermission) {
          await this.safeDeliverPendingInputRelay(adapter, job, permissionRequest)
        } else if (!effectivePermissionRequest && !job.pendingInput) {
          await this.safeDeliverBlockedStateRelay(adapter, job, "permission")
        }
        break
      case "permission.replied":
        const permissionRequestID = extractRequestID(payload)
        if (hasMismatchedPendingRequest(job, "permission", permissionRequestID)) {
          return
        }
        if (permissionRequestID && isResolvedPendingRequest(job, "permission", permissionRequestID)) {
          return
        }
        if (canLeaveIdle) {
          job.state = "running"
        }
        clearPendingInput(job, "permission", permissionRequestID)
        if (permissionRequestID) {
          job.lastResolvedPendingKind = "permission"
          job.lastResolvedPendingRequestID = permissionRequestID
        }
        this.clearStaleSnapshot(job, previousState)
        this.recordJobEvent(job, type, {
          previousState,
          detail: "Permission request resolved.",
          metadata: permissionRequestID ? { requestId: permissionRequestID } : undefined,
        })
        break
      case "question.asked":
        const questionRequest = await this.resolvePendingQuestionRequest(adapter, job, sessionID, payload)
        if (questionRequest && isResolvedPendingRequest(job, "question", questionRequest.requestId)) {
          return
        }
        if (questionRequest && hasConflictingPendingInput(job, questionRequest)) {
          return
        }
        const effectiveQuestionRequest =
          questionRequest ?? (job.pendingInput?.kind === "question" ? job.pendingInput : undefined)
        const shouldNotifyQuestion = questionRequest ? !isSamePendingInput(job.pendingInput, questionRequest) : false
        if (canLeaveIdle && (effectiveQuestionRequest || !job.pendingInput)) {
          job.state = "waiting_question"
        }
        if (questionRequest) {
          job.pendingInput = questionRequest
        }
        this.clearStaleSnapshot(job, previousState)
        this.recordJobEvent(job, type, {
          previousState,
          detail: describePendingInput(effectiveQuestionRequest) ?? "Waiting on a question response.",
          metadata: effectiveQuestionRequest ? { pendingInput: effectiveQuestionRequest } : undefined,
        })
        if (questionRequest && shouldNotifyQuestion) {
          await this.safeDeliverPendingInputRelay(adapter, job, questionRequest)
        } else if (!effectiveQuestionRequest && !job.pendingInput) {
          await this.safeDeliverBlockedStateRelay(adapter, job, "question")
        }
        break
      case "question.replied":
        const questionRequestID = extractRequestID(payload)
        if (hasMismatchedPendingRequest(job, "question", questionRequestID)) {
          return
        }
        if (questionRequestID && isResolvedPendingRequest(job, "question", questionRequestID)) {
          return
        }
        if (canLeaveIdle) {
          job.state = "running"
        }
        clearPendingInput(job, "question", questionRequestID)
        if (questionRequestID) {
          job.lastResolvedPendingKind = "question"
          job.lastResolvedPendingRequestID = questionRequestID
        }
        this.clearStaleSnapshot(job, previousState)
        this.recordJobEvent(job, type, {
          previousState,
          detail: "Question request resolved.",
          metadata: questionRequestID ? { requestId: questionRequestID } : undefined,
        })
        break
      case "question.rejected":
        const rejectedQuestionRequestID = extractRequestID(payload)
        if (hasMismatchedPendingRequest(job, "question", rejectedQuestionRequestID)) {
          return
        }
        if (rejectedQuestionRequestID && isResolvedPendingRequest(job, "question", rejectedQuestionRequestID)) {
          return
        }
        clearPendingInput(job, "question", rejectedQuestionRequestID)
        if (rejectedQuestionRequestID) {
          job.lastResolvedPendingKind = "question"
          job.lastResolvedPendingRequestID = rejectedQuestionRequestID
        }
        job.state = "failed"
        job.failureReason = "Question rejected"
        job.completedAt = Date.now()
        this.recordJobEvent(job, type, {
          previousState,
          detail: job.failureReason,
          metadata: rejectedQuestionRequestID ? { requestId: rejectedQuestionRequestID } : undefined,
        })
        await this.captureResult(adapter, job)
        this.closeJobTracking(job)
        await this.relayResult(adapter, job.jobID)
        break
      case "session.error":
        job.pendingInput = undefined
        job.state = "failed"
        job.failureReason = "Child session reported an error"
        job.completedAt = Date.now()
        this.recordJobEvent(job, type, { previousState, detail: job.failureReason })
        await this.captureResult(adapter, job)
        this.closeJobTracking(job)
        await this.relayResult(adapter, job.jobID)
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
          const currentPendingPermission = job.pendingInput?.kind === "permission" ? job.pendingInput : undefined
          const pendingPermission = await this.resolvePendingPermissionRequest(adapter, job, sessionID, payload)
          const resolvedPermissionReplay = Boolean(
            pendingPermission && isResolvedPendingRequest(job, "permission", pendingPermission.requestId),
          )
          let effectivePendingPermission = currentPendingPermission
          if (
            pendingPermission &&
            !resolvedPermissionReplay &&
            !hasConflictingPendingInput(job, pendingPermission)
          ) {
            job.pendingInput = pendingPermission
            effectivePendingPermission = pendingPermission
            if (!isSamePendingInput(currentPendingPermission, pendingPermission)) {
              await this.safeDeliverPendingInputRelay(adapter, job, pendingPermission)
            }
          }
          if (effectivePendingPermission) {
            job.state = "waiting_permission"
          } else if (
            !currentPendingPermission &&
            !resolvedPermissionReplay &&
            previousState !== "waiting_permission"
          ) {
            job.state = "waiting_permission"
            await this.safeDeliverBlockedStateRelay(adapter, job, "permission")
          }
        } else if (sessionStatus === "waiting_question" && canLeaveIdle) {
          const currentPendingQuestion = job.pendingInput?.kind === "question" ? job.pendingInput : undefined
          const pendingQuestion = await this.resolvePendingQuestionRequest(adapter, job, sessionID, payload)
          const resolvedQuestionReplay = Boolean(
            pendingQuestion && isResolvedPendingRequest(job, "question", pendingQuestion.requestId),
          )
          let effectivePendingQuestion = currentPendingQuestion
          if (
            pendingQuestion &&
            !resolvedQuestionReplay &&
            !hasConflictingPendingInput(job, pendingQuestion)
          ) {
            job.pendingInput = pendingQuestion
            effectivePendingQuestion = pendingQuestion
            if (!isSamePendingInput(currentPendingQuestion, pendingQuestion)) {
              await this.safeDeliverPendingInputRelay(adapter, job, pendingQuestion)
            }
          }
          if (effectivePendingQuestion) {
            job.state = "waiting_question"
          } else if (
            !currentPendingQuestion &&
            !resolvedQuestionReplay &&
            previousState !== "waiting_question"
          ) {
            job.state = "waiting_question"
            await this.safeDeliverBlockedStateRelay(adapter, job, "question")
          }
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

  jobEvents(jobID: string, limit = 20): ToolResult<JobEventsResult> {
    const job = this.jobs.get(jobID)
    if (!job) {
      return fail("JobNotFound", `Job '${jobID}' was not found.`)
    }

    const boundedLimit = Math.max(1, Math.trunc(limit || 20))
    const events = (this.events.get(jobID) ?? []).slice(-boundedLimit).reverse().map(toPublicJobEvent)

    return ok({
      jobId: jobID,
      events,
    })
  }

  async updateProgress(
    adapter: OpenCodeAdapter,
    args: JobProgressUpdateArgs,
    caller: ToolCallerContext = {},
  ): Promise<ToolResult<JobProgressUpdateResult>> {
    const trimmedMessage = args.message.trim()
    if (!trimmedMessage) {
      return fail("JobLaunchFailed", "Progress updates require a non-blank message.")
    }

    const callerSessionID = caller.sessionId?.trim()
    if (!callerSessionID) {
      return fail(
        "CurrentSessionUnavailable",
        "Mission Control could not identify the caller child session for this progress update.",
        "Call mc_job_update from the background child session or pass an explicit jobId from that child session.",
      )
    }

    const job = args.jobId ? this.jobs.get(args.jobId) : this.jobForChildSession(callerSessionID)
    if (!job) {
      return fail("JobNotFound", `No tracked background job matches '${args.jobId ?? callerSessionID}'.`)
    }

    if (job.childSessionID !== callerSessionID) {
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
      this.clearStaleSnapshot(job, previousState)
    }

    job.updatedAt = Date.now()
    job.lastObservedEvent = "job.progress"
    const event = this.recordJobEvent(job, "job.progress", {
      previousState: previousState !== job.state ? previousState : undefined,
      detail: trimmedMessage,
      metadata: {
        notifyParent: Boolean(args.notifyParent),
      },
    })

    if (args.notifyParent) {
      await this.safeDeliverProgressRelay(adapter, job, trimmedMessage)
    }

    try {
      await this.persist()
    } catch {
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

  async replyPermission(adapter: OpenCodeAdapter, args: JobPermissionReplyArgs, caller: ToolCallerContext = {}) {
    const job = this.jobs.get(args.jobId)
    if (!job) {
      return fail("JobNotFound", `Job '${args.jobId}' was not found.`)
    }

    const callerFailure = this.validateParentCaller(job, caller)
    if (callerFailure) {
      return callerFailure
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

    try {
      await adapter.replyPermissionRequest(
        pendingInput.requestId,
        args.reply,
        args.message,
        job.childDirectory ?? job.parentDirectory,
      )
    } catch (error) {
      return fail(
        "JobBlockedOnPermission",
        `Failed to reply to the permission request for job '${job.jobID}'.`,
        error instanceof Error ? error.message : undefined,
      )
    }

    const previousState = job.state
    job.state = "running"
    job.pendingInput = undefined
    job.lastResolvedPendingKind = "permission"
    job.lastResolvedPendingRequestID = pendingInput.requestId
    job.updatedAt = Date.now()
    job.lastObservedEvent = "permission.replied"
    this.recordJobEvent(job, "permission.replied", {
      previousState,
      detail: `Parent replied '${args.reply}' to the permission request.`,
      metadata: {
        requestId: pendingInput.requestId,
        reply: args.reply,
        ...(args.message ? { message: args.message } : {}),
      },
    })
    try {
      await this.persist()
    } catch {
      return ok(toPublicJob(job))
    }
    return ok(toPublicJob(job))
  }

  async replyQuestion(adapter: OpenCodeAdapter, args: JobQuestionReplyArgs, caller: ToolCallerContext = {}) {
    const job = this.jobs.get(args.jobId)
    if (!job) {
      return fail("JobNotFound", `Job '${args.jobId}' was not found.`)
    }

    const callerFailure = this.validateParentCaller(job, caller)
    if (callerFailure) {
      return callerFailure
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
    this.recordJobEvent(job, "question.replied", {
      previousState,
      detail: "Parent answered the pending question.",
      metadata: {
        requestId: pendingInput.requestId,
        answers: args.answers,
      },
    })
    try {
      await this.persist()
    } catch {
      return ok(toPublicJob(job))
    }
    return ok(toPublicJob(job))
  }

  async rejectQuestion(adapter: OpenCodeAdapter, jobID: string, caller: ToolCallerContext = {}) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return fail("JobNotFound", `Job '${jobID}' was not found.`)
    }

    const callerFailure = this.validateParentCaller(job, caller)
    if (callerFailure) {
      return callerFailure
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
    this.recordJobEvent(job, "question.rejected", {
      previousState,
      detail: job.failureReason,
      metadata: {
        requestId: pendingInput.requestId,
      },
    })
    try {
      await this.captureResult(adapter, job)
      this.closeJobTracking(job)
      const relayResult = await this.relayResult(adapter, job.jobID)
      if (!relayResult.ok) {
        return ok(toPublicJob(job))
      }
      await this.persist()
    } catch {
      return ok(toPublicJob(job))
    }
    return ok(toPublicJob(job))
  }

  async cancelJob(adapter: OpenCodeAdapter, jobID: string, caller: ToolCallerContext = {}) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return fail("JobNotFound", `Job '${jobID}' was not found.`)
    }

    const callerFailure = this.validateParentCaller(job, caller)
    if (callerFailure) {
      return callerFailure
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
    try {
      this.closeJobTracking(job)
      const relayResult = await this.relayResult(adapter, jobID)
      if (!relayResult.ok) {
        return ok(toPublicJob(job))
      }
      await this.persist()
    } catch {
      return ok(toPublicJob(job))
    }
    return ok(toPublicJob(job))
  }

  async getResult(adapter: OpenCodeAdapter, jobID: string, sendToParent: boolean, caller: ToolCallerContext = {}) {
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
      if (!adapter.supportsResultRelay()) {
        return fail(
          "JobLaunchFailed",
          `The current OpenCode runtime cannot relay job '${jobID}' results back to the parent session.`,
        )
      }
      const callerFailure = this.validateParentCaller(job, caller)
      if (callerFailure) {
        return callerFailure
      }
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

    if (!isStableResultState(job.state) && job.state !== "orphaned") {
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
        "Inspect the parent session and re-send the stored result with mc_job_result({ jobId, sendToParent: true }).",
      )
    }
  }

  private jobForChildSession(sessionID: string) {
    const jobID = this.childSessionToJobID.get(sessionID)
    return jobID ? this.jobs.get(jobID) : undefined
  }

  private validateParentCaller(job: BackgroundJob, caller: ToolCallerContext) {
    const callerSessionID = caller.sessionId?.trim()
    if (!callerSessionID) {
      return fail(
        "CurrentSessionUnavailable",
        `Mission Control could not verify the parent session for job '${job.jobID}'.`,
        "Run this reply tool from the parent session that launched the background job.",
      )
    }

    if (callerSessionID !== job.parentSessionID) {
      return fail(
        "JobLaunchFailed",
        `Only parent session '${job.parentSessionID}' can perform parent-scoped actions for job '${job.jobID}'.`,
        "Switch back to the parent session that launched the job and retry.",
      )
    }

    return undefined
  }

  private async resolvePendingPermissionRequest(
    adapter: OpenCodeAdapter,
    job: BackgroundJob,
    sessionID: string,
    payload: unknown,
  ) {
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

  private async resolvePendingQuestionRequest(
    adapter: OpenCodeAdapter,
    job: BackgroundJob,
    sessionID: string,
    payload: unknown,
  ) {
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
        this.lastLoadWarning = `Ignoring persisted jobs store version ${snapshot.version}; Mission Control now expects version ${MissionControlJobController.VERSION}.`
        return undefined
      }

      return snapshot
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return undefined
      }

      throw error
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
      const tempStorePath = `${storePath}.tmp`
      await mkdir(dirname(storePath), { recursive: true })
      await writeFile(tempStorePath, JSON.stringify(snapshot, null, 2), "utf8")
      await rename(tempStorePath, storePath)
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
    job.pendingInput = undefined
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

    await this.captureResult(adapter, job)
    await this.relayResult(adapter, job.jobID)
  }

  private clearStaleSnapshot(job: BackgroundJob, previousState: BackgroundJob["state"]) {
    if (isStableResultState(previousState) && !isStableResultState(job.state)) {
      this.results.delete(job.jobID)
    }
  }

  private async safeDeliverPendingInputRelay(
    adapter: OpenCodeAdapter,
    job: BackgroundJob,
    pendingInput: JobPendingInput,
  ) {
    try {
      await deliverPendingInputRelay(adapter, job, pendingInput)
    } catch (error) {
      this.recordJobEvent(job, "job.pending_input_notification_failed", {
        detail: error instanceof Error ? error.message : "Failed to notify the parent session about a blocked request.",
        metadata: {
          kind: pendingInput.kind,
          requestId: pendingInput.requestId,
        },
      })
    }
  }

  private async safeDeliverBlockedStateRelay(
    adapter: OpenCodeAdapter,
    job: BackgroundJob,
    kind: "permission" | "question",
  ) {
    try {
      await deliverBlockedStateRelay(adapter, job, kind)
    } catch (error) {
      this.recordJobEvent(job, "job.blocked_state_notification_failed", {
        detail: error instanceof Error ? error.message : "Failed to notify the parent session about a blocked job.",
        metadata: {
          kind,
        },
      })
    }
  }

  private async safeDeliverProgressRelay(adapter: OpenCodeAdapter, job: BackgroundJob, message: string) {
    try {
      await deliverProgressRelay(adapter, job, message)
    } catch (error) {
      this.recordJobEvent(job, "job.progress_notification_failed", {
        detail: error instanceof Error ? error.message : "Failed to notify the parent session about job progress.",
        metadata: {
          message,
        },
      })
    }
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
      metadata: options.metadata,
    }

    const events = this.events.get(job.jobID) ?? []
    events.push(event)
    const retainedEvents = events.slice(-this.maxPersistedJobEvents())
    this.events.set(job.jobID, retainedEvents)
    return event
  }

  private maxPersistedJobEvents() {
    return Math.max(50, Math.trunc(this.config.observe.eventBufferSize || 0))
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
      return job.pendingInput?.kind === "permission"
        ? `The child session is waiting on a permission decision for '${job.pendingInput.permission}'.`
        : "The child session is waiting on a permission decision."
    case "waiting_question":
      return job.pendingInput?.kind === "question" && job.pendingInput.questions[0]
        ? `The child session is waiting on an answer for '${job.pendingInput.questions[0].header}'.`
        : "The child session is waiting on an answered question."
    case "aborted":
      return "The job was aborted before completion."
    default:
      return "The child session reached a stable state without a richer final summary yet."
  }
}

const collectBlockers = (job: BackgroundJob) => {
  const blockers: string[] = []

  if (job.state === "waiting_permission") {
    blockers.push(
      job.pendingInput?.kind === "permission"
        ? `Waiting on permission approval for '${job.pendingInput.permission}'`
        : "Waiting on permission approval",
    )
  }

  if (job.state === "waiting_question") {
    blockers.push(
      job.pendingInput?.kind === "question" && job.pendingInput.questions[0]
        ? `Waiting on question response for '${job.pendingInput.questions[0].header}'`
        : "Waiting on a question response",
    )
  }

  if (job.failureReason) {
    blockers.push(job.failureReason)
  }

  return blockers
}

const mergeBlockers = (job: BackgroundJob, reportedBlockers: string[]) => {
  return Array.from(new Set([...collectBlockers(job), ...reportedBlockers]))
}

const normalizeLoadedJob = (job: BackgroundJob, _config: MissionControlConfig): BackgroundJob => {
  return {
    ...job,
    relayState: (job.relayState as string) === "not_requested" ? "pending" : (job.relayState ?? "pending"),
    lastSourceUpdatedAt: job.lastSourceUpdatedAt,
    pendingInput: job.pendingInput,
    lastResolvedPendingKind: job.lastResolvedPendingKind,
    lastResolvedPendingRequestID: job.lastResolvedPendingRequestID,
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
  state: job.state,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  launchedAt: job.launchedAt,
  completedAt: job.completedAt,
  failureReason: job.failureReason,
  lastObservedEvent: job.lastObservedEvent,
  lastSourceUpdatedAt: job.lastSourceUpdatedAt,
  relayState: job.relayState,
  pendingInput: job.pendingInput,
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

const toPublicJobEvent = (event: JobLifecycleEvent): MissionControlJobEvent => ({
  eventId: event.eventID,
  jobId: event.jobID,
  sessionId: event.parentSessionID,
  childSessionId: event.childSessionID,
  type: event.type,
  state: event.state,
  previousState: event.previousState,
  at: event.at,
  detail: event.detail,
  metadata: event.metadata,
})

const toPendingPermissionRequest = (value: unknown): JobPendingPermissionRequest | undefined => {
  const request = extractPermissionRequest(value)
  if (!request) {
    return undefined
  }

  return {
    kind: "permission",
    ...request,
    askedAt: Date.now(),
  }
}

const toPendingQuestionRequest = (value: unknown): JobPendingQuestionRequest | undefined => {
  const request = extractQuestionRequest(value)
  if (!request) {
    return undefined
  }

  return {
    kind: "question",
    ...request,
    askedAt: Date.now(),
  }
}

const isSamePendingInput = (left: JobPendingInput | undefined, right: JobPendingInput | undefined) =>
  Boolean(left && right && left.kind === right.kind && left.requestId === right.requestId)

const clearPendingInput = (job: BackgroundJob, kind: PendingInputKind, requestID?: string) => {
  if (!job.pendingInput || job.pendingInput.kind !== kind) {
    return
  }

  if (requestID && job.pendingInput.requestId !== requestID) {
    return
  }

  job.pendingInput = undefined
}

const isResolvedPendingRequest = (job: BackgroundJob, kind: PendingInputKind, requestID: string) =>
  !job.pendingInput && job.lastResolvedPendingKind === kind && job.lastResolvedPendingRequestID === requestID

const hasMismatchedPendingRequest = (job: BackgroundJob, kind: PendingInputKind, requestID?: string) => {
  if (!job.pendingInput) {
    return false
  }

  if (job.pendingInput.kind !== kind) {
    return true
  }

  return Boolean(requestID && job.pendingInput.requestId !== requestID)
}

const hasConflictingPendingInput = (job: BackgroundJob, pendingInput: JobPendingInput) =>
  Boolean(job.pendingInput && job.pendingInput.requestId !== pendingInput.requestId)

const describePendingInput = (pendingInput: JobPendingInput | undefined) => {
  if (!pendingInput) {
    return undefined
  }

  if (pendingInput.kind === "permission") {
    return `Waiting on permission '${pendingInput.permission}'.`
  }

  const firstQuestion = pendingInput.questions[0]?.header || pendingInput.questions[0]?.question
  return firstQuestion ? `Waiting on question '${firstQuestion}'.` : "Waiting on a question response."
}

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
