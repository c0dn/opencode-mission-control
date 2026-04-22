import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { OpenCodeAdapter } from "./opencode-client.js"
import { deliverBlockedStateRelay, deliverParentRelay, deliverPendingInputRelay, deliverProgressRelay } from "./relay.js"
import {
  extractRequestID,
  extractSessionID,
  extractSessionTimestamp,
  extractStatus,
} from "./session-extractors.js"
import {
  buildStructuredSummary,
  canExposeStoredResult,
  clearPendingInput,
  collectBlockers,
  collectMessagePartsText,
  createJobEventID,
  createJobID,
  defaultSummaryForState,
  describePendingInput,
  hasConflictingPendingInput,
  hasMismatchedPendingRequest,
  isClosedJobState,
  isLiveTrackedJobState,
  isRecoverableJobState,
  isResolvedPendingRequest,
  isSamePendingInput,
  isStableResultState,
  mapJobStateToSnapshotState,
  mergeBlockers,
  normalizeLoadedJob,
  parseStructuredFinalReport,
  shouldDebugTrackedEvent,
  toPendingPermissionRequest,
  toPendingQuestionRequest,
  toPublicJob,
  toPublicJobEvent,
  toPublicJobResult,
  truncateSummary,
} from "./job-helpers.js"
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

type PermissionReplyProvenance =
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

interface LocalPermissionReplyIntent {
  jobId: string
  parentSessionId: string
  reply: JobPermissionReplyArgs["reply"]
  initiatedAt: number
  callerSessionId?: string
  callerMessageId?: string
}

const buildPermissionReplyMetadata = (
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

export class MissionControlJobController {
  private static readonly VERSION = 2
  private static readonly LOCAL_PERMISSION_REPLY_TTL_MS = 60_000

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
      this.events.set(event.jobID, existing.slice(-this.maxPersistedJobEvents()))
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
    const previousObservedEvent = job.lastObservedEvent
    const previousSourceUpdatedAt = job.lastSourceUpdatedAt
    const eventUpdatedAt = extractSessionTimestamp(payload, "updated")
    const requestID = extractRequestID(payload)
    const extractedSessionStatus = type === "session.status" ? extractStatus(payload) : undefined
    const hasFreshSourceTimestamp =
      eventUpdatedAt === undefined || eventUpdatedAt >= (previousSourceUpdatedAt ?? Number.NEGATIVE_INFINITY)
    const canLeaveIdle =
      previousState !== "idle" ||
      eventUpdatedAt === undefined ||
      eventUpdatedAt > (previousSourceUpdatedAt ?? Number.NEGATIVE_INFINITY)
    const tracksHeartbeatEvent = shouldDebugTrackedEvent(type, previousState, previousState)
    if (type !== "message.updated" && type !== "message.part.updated") {
      job.lastObservedEvent = type
    } else if (tracksHeartbeatEvent) {
      job.lastObservedEvent = type
    }

    const logIgnoredEvent = async (
      reason: string,
      extra: Record<string, unknown> = {},
      options: {
        persistInJobFeed?: boolean
        touchUpdatedAt?: boolean
        advanceSourceTimestamp?: boolean
      } = {},
    ) => {
      const persistInJobFeed = options.persistInJobFeed ?? true
      const touchUpdatedAt = options.touchUpdatedAt ?? true
      const advanceSourceTimestamp = options.advanceSourceTimestamp ?? true

      job.lastObservedEvent = previousObservedEvent
      if (advanceSourceTimestamp && eventUpdatedAt !== undefined) {
        job.lastSourceUpdatedAt = Math.max(job.lastSourceUpdatedAt ?? Number.NEGATIVE_INFINITY, eventUpdatedAt)
      }
      if (persistInJobFeed) {
        this.recordJobEvent(job, "job.event_ignored", {
          detail: reason,
          metadata: {
            eventType: type,
            eventSessionId: sessionID,
            requestId: requestID,
            sessionStatus: extractedSessionStatus,
            ...extra,
          },
        })
      }
      if (touchUpdatedAt) {
        job.updatedAt = Date.now()
      }
      if (persistInJobFeed || touchUpdatedAt || advanceSourceTimestamp) {
        await this.persist()
      }
      await this.debugJob(adapter, "handleEvent ignored tracked child event", job, {
        eventType: type,
        eventSessionId: sessionID,
        eventUpdatedAt,
        requestId: requestID,
        sessionStatus: extractedSessionStatus,
        previousState,
        reason,
        ...extra,
      })
    }

    if (shouldDebugTrackedEvent(type, previousState, previousState)) {
      await this.debugJob(adapter, "handleEvent received tracked child event", job, {
        eventType: type,
        eventSessionId: sessionID,
        eventUpdatedAt,
        requestId: requestID,
        sessionStatus: extractedSessionStatus,
        previousState,
        previousPendingInputKind: job.pendingInput?.kind,
        previousPendingRequestId: job.pendingInput?.requestId,
        canLeaveIdle,
        hasFreshSourceTimestamp,
      })
    }

    switch (type) {
      case "permission.asked":
        const permissionRequest = await this.resolvePendingPermissionRequest(adapter, job, sessionID, payload)
        if (permissionRequest && isResolvedPendingRequest(job, "permission", permissionRequest.requestId)) {
          await logIgnoredEvent("resolved permission replay", {
            ignoredRequestId: permissionRequest.requestId,
          })
          return
        }
        if (permissionRequest && hasConflictingPendingInput(job, permissionRequest)) {
          await logIgnoredEvent("conflicting permission request", {
            ignoredRequestId: permissionRequest.requestId,
          })
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
        const permissionReplyProvenance = this.consumePermissionReplyProvenance(permissionRequestID)
        if (hasMismatchedPendingRequest(job, "permission", permissionRequestID)) {
          await logIgnoredEvent("mismatched permission reply", {
            ignoredRequestId: permissionRequestID,
            ...buildPermissionReplyMetadata(permissionRequestID, permissionReplyProvenance),
          })
          return
        }
        if (permissionRequestID && isResolvedPendingRequest(job, "permission", permissionRequestID)) {
          await logIgnoredEvent("duplicate permission reply", {
            ignoredRequestId: permissionRequestID,
            ...buildPermissionReplyMetadata(permissionRequestID, permissionReplyProvenance),
          })
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
          detail:
            permissionReplyProvenance.source === "external_unknown_reply"
              ? "Permission request resolved by an external reply source."
              : "Permission request resolved.",
          metadata: buildPermissionReplyMetadata(permissionRequestID, permissionReplyProvenance),
        })
        await this.debugJob(adapter, "handleEvent observed permission reply provenance", job, {
          requestId: permissionRequestID,
          replySource: permissionReplyProvenance.source,
          ...(permissionReplyProvenance.source === "mission_control_local_reply"
            ? {
                reply: permissionReplyProvenance.reply,
                initiatedAt: permissionReplyProvenance.initiatedAt,
                callerSessionId: permissionReplyProvenance.callerSessionId,
                parentSessionId: permissionReplyProvenance.parentSessionId,
                localReplyJobId: permissionReplyProvenance.jobId,
              }
            : {
                externalResolution: true,
              }),
          previousState,
          nextState: job.state,
        })
        break
      case "question.asked":
        const questionRequest = await this.resolvePendingQuestionRequest(adapter, job, sessionID, payload)
        if (questionRequest && isResolvedPendingRequest(job, "question", questionRequest.requestId)) {
          await logIgnoredEvent("resolved question replay", {
            ignoredRequestId: questionRequest.requestId,
          })
          return
        }
        if (questionRequest && hasConflictingPendingInput(job, questionRequest)) {
          await logIgnoredEvent("conflicting question request", {
            ignoredRequestId: questionRequest.requestId,
          })
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
          await logIgnoredEvent("mismatched question reply", {
            ignoredRequestId: questionRequestID,
          })
          return
        }
        if (questionRequestID && isResolvedPendingRequest(job, "question", questionRequestID)) {
          await logIgnoredEvent("duplicate question reply", {
            ignoredRequestId: questionRequestID,
          })
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
          await logIgnoredEvent("mismatched question reject", {
            ignoredRequestId: rejectedQuestionRequestID,
          })
          return
        }
        if (rejectedQuestionRequestID && isResolvedPendingRequest(job, "question", rejectedQuestionRequestID)) {
          await logIgnoredEvent("duplicate question reject", {
            ignoredRequestId: rejectedQuestionRequestID,
          })
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
        } else {
          await logIgnoredEvent("stale session idle event", {
            previousSourceUpdatedAt,
          })
          return
        }
        break
      case "session.status":
        const sessionStatus = extractStatus(payload)

        if (sessionStatus === "idle") {
          if (hasFreshSourceTimestamp) {
            await this.handleIdleTransition(adapter, job, previousState, type)
          } else {
            await logIgnoredEvent("stale idle session status", {
              previousSourceUpdatedAt,
            })
            return
          }
          break
        } else if (!hasFreshSourceTimestamp || !canLeaveIdle) {
            await logIgnoredEvent("stale session status event", {
              previousSourceUpdatedAt,
              sessionStatus,
            })
            return
        } else if (sessionStatus === "waiting_permission" && canLeaveIdle) {
          const currentPendingPermission = job.pendingInput?.kind === "permission" ? job.pendingInput : undefined
          const pendingPermission = await this.resolvePendingPermissionRequest(adapter, job, sessionID, payload)
          if (pendingPermission && isResolvedPendingRequest(job, "permission", pendingPermission.requestId)) {
            await logIgnoredEvent("resolved permission replay", {
              ignoredRequestId: pendingPermission.requestId,
              sessionStatus,
            })
            return
          }
          if (pendingPermission && hasConflictingPendingInput(job, pendingPermission)) {
            await logIgnoredEvent("conflicting permission request", {
              ignoredRequestId: pendingPermission.requestId,
              sessionStatus,
            })
            return
          }
          let effectivePendingPermission = currentPendingPermission
          if (pendingPermission) {
            job.pendingInput = pendingPermission
            effectivePendingPermission = pendingPermission
            if (!isSamePendingInput(currentPendingPermission, pendingPermission)) {
              await this.safeDeliverPendingInputRelay(adapter, job, pendingPermission)
            }
          }
          if (effectivePendingPermission) {
            job.state = "waiting_permission"
          } else if (!currentPendingPermission && previousState !== "waiting_permission") {
            job.state = "waiting_permission"
            await this.safeDeliverBlockedStateRelay(adapter, job, "permission")
          }
        } else if (sessionStatus === "waiting_question" && canLeaveIdle) {
          const currentPendingQuestion = job.pendingInput?.kind === "question" ? job.pendingInput : undefined
          const pendingQuestion = await this.resolvePendingQuestionRequest(adapter, job, sessionID, payload)
          if (pendingQuestion && isResolvedPendingRequest(job, "question", pendingQuestion.requestId)) {
            await logIgnoredEvent("resolved question replay", {
              ignoredRequestId: pendingQuestion.requestId,
              sessionStatus,
            })
            return
          }
          if (pendingQuestion && hasConflictingPendingInput(job, pendingQuestion)) {
            await logIgnoredEvent("conflicting question request", {
              ignoredRequestId: pendingQuestion.requestId,
              sessionStatus,
            })
            return
          }
          let effectivePendingQuestion = currentPendingQuestion
          if (pendingQuestion) {
            job.pendingInput = pendingQuestion
            effectivePendingQuestion = pendingQuestion
            if (!isSamePendingInput(currentPendingQuestion, pendingQuestion)) {
              await this.safeDeliverPendingInputRelay(adapter, job, pendingQuestion)
            }
          }
          if (effectivePendingQuestion) {
            job.state = "waiting_question"
          } else if (!currentPendingQuestion && previousState !== "waiting_question") {
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
        if (shouldDebugTrackedEvent(type, previousState, job.state)) {
          this.recordJobEvent(job, type, {
            previousState: previousState !== job.state ? previousState : undefined,
          })
        }
        break
      default:
        await logIgnoredEvent("unhandled tracked child event", {}, {
          persistInJobFeed: false,
          touchUpdatedAt: false,
          advanceSourceTimestamp: false,
        })
        return
    }

    job.updatedAt = Date.now()
    if (eventUpdatedAt !== undefined) {
      job.lastSourceUpdatedAt = Math.max(job.lastSourceUpdatedAt ?? Number.NEGATIVE_INFINITY, eventUpdatedAt)
    }

    if (shouldDebugTrackedEvent(type, previousState, job.state)) {
      await this.debugJob(adapter, "handleEvent updated tracked child event", job, {
        eventType: type,
        eventSessionId: sessionID,
        eventUpdatedAt,
        requestId: requestID,
        sessionStatus: extractedSessionStatus,
        previousState,
        nextState: job.state,
        pendingInputKind: job.pendingInput?.kind,
        pendingRequestId: job.pendingInput?.requestId,
        lastResolvedPendingKind: job.lastResolvedPendingKind,
        lastResolvedPendingRequestId: job.lastResolvedPendingRequestID,
      })
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

    const callerSessionID = await this.resolveCallerSessionID(adapter, caller)
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

    const job = args.jobId ? this.jobs.get(args.jobId) : this.jobForChildSession(callerSessionID)
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

  async replyPermission(adapter: OpenCodeAdapter, args: JobPermissionReplyArgs, caller: ToolCallerContext = {}) {
    const job = this.jobs.get(args.jobId)
    if (!job) {
      return fail("JobNotFound", `Job '${args.jobId}' was not found.`)
    }

    const validatedParentSessionID = await this.validateParentCaller(adapter, job, caller)
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

    const localPermissionReplyProvenance = this.rememberLocalPermissionReply(
      job,
      pendingInput.requestId,
      args.reply,
      validatedParentSessionID,
      caller.messageId?.trim() || undefined,
    )

    try {
      await this.debugJob(adapter, "replyPermission sending permission reply", job, {
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
      this.forgetLocalPermissionReply(pendingInput.requestId)
      return fail(
        "JobBlockedOnPermission",
        `Failed to reply to the permission request for job '${job.jobID}'.`,
        error instanceof Error ? error.message : undefined,
      )
    }

    if (isResolvedPendingRequest(job, "permission", pendingInput.requestId)) {
      await this.debugJob(adapter, "replyPermission observed already-resolved permission request", job, {
        requestId: pendingInput.requestId,
        reply: args.reply,
      })

      return ok(toPublicJob(job))
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
      metadata: buildPermissionReplyMetadata(pendingInput.requestId, localPermissionReplyProvenance, {
        message: args.message,
      }),
    })
    try {
      await this.persist()
    } catch (error) {
      await adapter.debug("replyPermission failed to persist job state", {
        jobId: job.jobID,
        state: job.state,
        requestId: pendingInput.requestId,
        error: error instanceof Error ? error.message : String(error),
      })

      return ok(toPublicJob(job))
    }
    return ok(toPublicJob(job))
  }

  async replyQuestion(adapter: OpenCodeAdapter, args: JobQuestionReplyArgs, caller: ToolCallerContext = {}) {
    const job = this.jobs.get(args.jobId)
    if (!job) {
      return fail("JobNotFound", `Job '${args.jobId}' was not found.`)
    }

    const validatedParentSessionID = await this.validateParentCaller(adapter, job, caller)
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
    this.recordJobEvent(job, "question.replied", {
      previousState,
      detail: "Parent answered the pending question.",
      metadata: {
        requestId: pendingInput.requestId,
        answers: args.answers,
        callerSessionId: validatedParentSessionID,
      },
    })
    try {
      await this.persist()
    } catch (error) {
      await adapter.debug("replyQuestion failed to persist job state", {
        jobId: job.jobID,
        state: job.state,
        requestId: pendingInput.requestId,
        error: error instanceof Error ? error.message : String(error),
      })

      return ok(toPublicJob(job))
    }
    return ok(toPublicJob(job))
  }

  async rejectQuestion(adapter: OpenCodeAdapter, jobID: string, caller: ToolCallerContext = {}) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return fail("JobNotFound", `Job '${jobID}' was not found.`)
    }

    const validatedParentSessionID = await this.validateParentCaller(adapter, job, caller)
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
    this.recordJobEvent(job, "question.rejected", {
      previousState,
      detail: job.failureReason,
      metadata: {
        requestId: pendingInput.requestId,
        callerSessionId: validatedParentSessionID,
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
    } catch (error) {
      await adapter.debug("rejectQuestion failed during finalization", {
        jobId: job.jobID,
        state: job.state,
        requestId: pendingInput.requestId,
        error: error instanceof Error ? error.message : String(error),
      })

      return ok(toPublicJob(job))
    }
    return ok(toPublicJob(job))
  }

  async cancelJob(adapter: OpenCodeAdapter, jobID: string, caller: ToolCallerContext = {}) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return fail("JobNotFound", `Job '${jobID}' was not found.`)
    }

    const validatedParentSessionID = await this.validateParentCaller(adapter, job, caller)
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
    } catch (error) {
      await adapter.debug("cancelJob failed during finalization", {
        jobId: job.jobID,
        state: job.state,
        error: error instanceof Error ? error.message : String(error),
      })

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
      const callerValidation = await this.validateParentCaller(adapter, job, caller)
      if (typeof callerValidation !== "string") {
        return callerValidation
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

    await this.debugJob(adapter, "relayResult delivering stored snapshot", job, {
      force: Boolean(options.force),
      snapshotState: result.state,
      keyMessageCount: result.keyMessageIDs.length,
    })

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

      await this.debugJob(adapter, "relayResult delivered stored snapshot", job, {
        force: Boolean(options.force),
        previousState,
        nextState: job.state,
        snapshotState: result.state,
      })

      await this.persist()
      return ok({
        job,
        result,
      })
    } catch (error) {
      await this.debugJob(adapter, "relayResult failed to deliver stored snapshot", job, {
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
      this.recordJobEvent(job, "job.relay_failed", {
        detail: error instanceof Error ? error.message : "Failed to relay the result to the parent session.",
      })
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

  private async resolveCallerSessionID(adapter: OpenCodeAdapter, caller: ToolCallerContext) {
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

  private async validateParentCaller(adapter: OpenCodeAdapter, job: BackgroundJob, caller: ToolCallerContext) {
    const callerSessionID = await this.resolveCallerSessionID(adapter, caller)
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

    await this.debugJob(adapter, "captureResult reading child transcript", job, {
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
        summary:
          truncateSummary(buildStructuredSummary(structuredReport) || rawReport) || defaultSummaryForState(job),
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

      await this.debugJob(adapter, "captureResult transcript capture failed", job, {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    this.results.set(job.jobID, snapshot)

    await this.debugJob(adapter, "captureResult stored snapshot", job, {
      snapshotState: snapshot.state,
      keyMessageCount: snapshot.keyMessageIDs.length,
      blockersCount: snapshot.blockers.length,
      summaryLength: snapshot.summary.length,
    })

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

    await this.debugJob(adapter, "handleIdleTransition finalizing idle job", job, {
      previousState,
      eventType,
    })

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

  private rememberLocalPermissionReply(
    job: BackgroundJob,
    requestId: string,
    reply: JobPermissionReplyArgs["reply"],
    callerSessionId: string,
    callerMessageId?: string,
  ): PermissionReplyProvenance {
    const provenance: PermissionReplyProvenance = {
      source: "mission_control_local_reply",
      jobId: job.jobID,
      parentSessionId: job.parentSessionID,
      reply,
      initiatedAt: Date.now(),
      callerSessionId,
      callerMessageId,
    }

    this.pruneRecentLocalPermissionReplies()
    this.recentLocalPermissionReplies.set(requestId, {
      jobId: provenance.jobId,
      parentSessionId: provenance.parentSessionId,
      reply: provenance.reply,
      initiatedAt: provenance.initiatedAt,
      callerSessionId: provenance.callerSessionId,
      callerMessageId: provenance.callerMessageId,
    })

    return provenance
  }

  private forgetLocalPermissionReply(requestId?: string) {
    if (!requestId) {
      return
    }

    this.recentLocalPermissionReplies.delete(requestId)
  }

  private consumePermissionReplyProvenance(requestId?: string): PermissionReplyProvenance {
    this.pruneRecentLocalPermissionReplies()

    if (!requestId) {
      return {
        source: "external_unknown_reply",
      }
    }

    const intent = this.recentLocalPermissionReplies.get(requestId)
    if (!intent) {
      return {
        source: "external_unknown_reply",
      }
    }

    this.recentLocalPermissionReplies.delete(requestId)
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

  private pruneRecentLocalPermissionReplies(now = Date.now()) {
    for (const [requestId, intent] of this.recentLocalPermissionReplies.entries()) {
      if (now - intent.initiatedAt > MissionControlJobController.LOCAL_PERMISSION_REPLY_TTL_MS) {
        this.recentLocalPermissionReplies.delete(requestId)
      }
    }
  }

  private async debugJob(
    adapter: OpenCodeAdapter,
    message: string,
    job: BackgroundJob,
    extra: Record<string, unknown> = {},
  ) {
    await adapter.debug(message, {
      jobId: job.jobID,
      title: job.title,
      parentSessionId: job.parentSessionID,
      childSessionId: job.childSessionID,
      state: job.state,
      lastObservedEvent: job.lastObservedEvent,
      relayState: job.relayState,
      pendingInputKind: job.pendingInput?.kind,
      ...extra,
    })
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

const getMissionControlCacheRoot = (rootDir: string) => {
  const xdgCache = process.env.XDG_CACHE_HOME?.trim()
  const home = process.env.HOME?.trim() || homedir()
  const baseDir = xdgCache || (home ? join(home, ".cache") : tmpdir())
  return join(baseDir, "opencode-mission-control", scopeKey(rootDir))
}

const scopeKey = (rootDir: string) => createHash("sha1").update(rootDir || "default").digest("hex").slice(0, 16)
