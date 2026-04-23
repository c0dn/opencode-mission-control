import type { OpenCodeAdapter } from "../opencode-client.js"
import {
  buildPermissionReplyMetadata,
  consumePermissionReplyProvenance,
} from "./permission-replies.js"
import type { JobEventHandlerRuntime } from "./event-handler-runtime.js"
import {
  clearPendingInput,
  describePendingInput,
  hasConflictingPendingInput,
  hasMismatchedPendingRequest,
  isClosedJobState,
  isResolvedPendingRequest,
  isSamePendingInput,
  shouldDebugTrackedEvent,
} from "../job-helpers.js"
import { extractRequestID, extractSessionID, extractSessionTimestamp, extractStatus } from "../session-extractors.js"
import type { BackgroundJob } from "../types.js"

export const handleTrackedJobEvent = async (
  runtime: JobEventHandlerRuntime,
  adapter: OpenCodeAdapter,
  type: string,
  payload: unknown,
) => {
  const sessionID = extractSessionID(payload)
  if (!sessionID) {
    return
  }

  const jobID = runtime.childSessionToJobID.get(sessionID)
  if (!jobID) {
    return
  }

  const job = runtime.jobs.get(jobID)
  if (!job) {
    return
  }

  if (isClosedJobState(job.state)) {
    runtime.closeJobTracking(job)
    await runtime.persist()
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
      runtime.recordJobEvent(job, "job.event_ignored", {
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
      await runtime.persist()
    }
    await runtime.debugJob(adapter, "handleEvent ignored tracked child event", job, {
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
    await runtime.debugJob(adapter, "handleEvent received tracked child event", job, {
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
    case "permission.asked": {
      const permissionRequest = await runtime.resolvePendingPermissionRequest(adapter, job, sessionID, payload)
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
      runtime.clearStaleSnapshot(job, previousState)
      runtime.recordJobEvent(job, type, {
        previousState,
        detail: describePendingInput(effectivePermissionRequest) ?? "Waiting on permission approval.",
        metadata: effectivePermissionRequest ? { pendingInput: effectivePermissionRequest } : undefined,
      })
      if (permissionRequest && shouldNotifyPermission) {
        await runtime.safeDeliverPendingInputRelay(adapter, job, permissionRequest)
      } else if (!effectivePermissionRequest && !job.pendingInput) {
        await runtime.safeDeliverBlockedStateRelay(adapter, job, "permission")
      }
      break
    }
    case "permission.replied": {
      const permissionRequestID = extractRequestID(payload)
      const permissionReplyProvenance = consumePermissionReplyProvenance(runtime.recentLocalPermissionReplies, permissionRequestID)
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
      runtime.clearStaleSnapshot(job, previousState)
      runtime.recordJobEvent(job, type, {
        previousState,
        detail:
          permissionReplyProvenance.source === "external_unknown_reply"
            ? "Permission request resolved by an external reply source."
            : "Permission request resolved.",
        metadata: buildPermissionReplyMetadata(permissionRequestID, permissionReplyProvenance),
      })
      await runtime.debugJob(adapter, "handleEvent observed permission reply provenance", job, {
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
    }
    case "question.asked": {
      const questionRequest = await runtime.resolvePendingQuestionRequest(adapter, job, sessionID, payload)
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
      runtime.clearStaleSnapshot(job, previousState)
      runtime.recordJobEvent(job, type, {
        previousState,
        detail: describePendingInput(effectiveQuestionRequest) ?? "Waiting on a question response.",
        metadata: effectiveQuestionRequest ? { pendingInput: effectiveQuestionRequest } : undefined,
      })
      if (questionRequest && shouldNotifyQuestion) {
        await runtime.safeDeliverPendingInputRelay(adapter, job, questionRequest)
      } else if (!effectiveQuestionRequest && !job.pendingInput) {
        await runtime.safeDeliverBlockedStateRelay(adapter, job, "question")
      }
      break
    }
    case "question.replied": {
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
      runtime.clearStaleSnapshot(job, previousState)
      runtime.recordJobEvent(job, type, {
        previousState,
        detail: "Question request resolved.",
        metadata: questionRequestID ? { requestId: questionRequestID } : undefined,
      })
      break
    }
    case "question.rejected": {
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
      runtime.recordJobEvent(job, type, {
        previousState,
        detail: job.failureReason,
        metadata: rejectedQuestionRequestID ? { requestId: rejectedQuestionRequestID } : undefined,
      })
      await runtime.captureResult(adapter, job)
      runtime.closeJobTracking(job)
      await runtime.relayResult(adapter, job.jobID)
      break
    }
    case "session.error": {
      job.pendingInput = undefined
      job.state = "failed"
      job.failureReason = "Child session reported an error"
      job.completedAt = Date.now()
      runtime.recordJobEvent(job, type, { previousState, detail: job.failureReason })
      await runtime.captureResult(adapter, job)
      runtime.closeJobTracking(job)
      await runtime.relayResult(adapter, job.jobID)
      break
    }
    case "session.idle": {
      if (hasFreshSourceTimestamp) {
        await runtime.handleIdleTransition(adapter, job, previousState, type)
      } else {
        await logIgnoredEvent("stale session idle event", {
          previousSourceUpdatedAt,
        })
        return
      }
      break
    }
    case "session.status": {
      const sessionStatus = extractStatus(payload)

      if (sessionStatus === "idle") {
        if (hasFreshSourceTimestamp) {
          await runtime.handleIdleTransition(adapter, job, previousState, type)
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
        const pendingPermission = await runtime.resolvePendingPermissionRequest(adapter, job, sessionID, payload)
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
            await runtime.safeDeliverPendingInputRelay(adapter, job, pendingPermission)
          }
        }
        if (effectivePendingPermission) {
          job.state = "waiting_permission"
        } else if (!currentPendingPermission && previousState !== "waiting_permission") {
          job.state = "waiting_permission"
          await runtime.safeDeliverBlockedStateRelay(adapter, job, "permission")
        }
      } else if (sessionStatus === "waiting_question" && canLeaveIdle) {
        const currentPendingQuestion = job.pendingInput?.kind === "question" ? job.pendingInput : undefined
        const pendingQuestion = await runtime.resolvePendingQuestionRequest(adapter, job, sessionID, payload)
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
            await runtime.safeDeliverPendingInputRelay(adapter, job, pendingQuestion)
          }
        }
        if (effectivePendingQuestion) {
          job.state = "waiting_question"
        } else if (!currentPendingQuestion && previousState !== "waiting_question") {
          job.state = "waiting_question"
          await runtime.safeDeliverBlockedStateRelay(adapter, job, "question")
        }
      } else if (job.state !== "waiting_permission" && job.state !== "waiting_question" && canLeaveIdle) {
        job.state = "running"
      }
      runtime.clearStaleSnapshot(job, previousState)
      runtime.recordJobEvent(job, type, {
        previousState: previousState !== job.state ? previousState : undefined,
      })
      break
    }
    case "message.updated":
    case "message.part.updated": {
      if (
        previousState === "idle" &&
        eventUpdatedAt !== undefined &&
        eventUpdatedAt > (previousSourceUpdatedAt ?? Number.NEGATIVE_INFINITY)
      ) {
        job.state = "running"
      }
      runtime.clearStaleSnapshot(job, previousState)
      if (shouldDebugTrackedEvent(type, previousState, job.state)) {
        runtime.recordJobEvent(job, type, {
          previousState: previousState !== job.state ? previousState : undefined,
        })
      }
      break
    }
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
    await runtime.debugJob(adapter, "handleEvent updated tracked child event", job, {
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

  await runtime.persist()
}
