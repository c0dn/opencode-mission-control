import {
  extractPermissionRequest,
  extractQuestionRequest,
} from "./session-extractors.js"

import type {
  BackgroundJob,
  JobActionResult,
  JobLifecycleEvent,
  JobPendingInput,
  JobPendingPermissionRequest,
  JobPendingQuestionRequest,
  JobResultSnapshot,
  MissionControlJob,
  MissionControlJobEvent,
  MissionControlPendingInput,
  MissionControlJobResult,
  PendingInputKind,
} from "./types.js"

export const createJobID = () => `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

export const createJobEventID = (jobID: string) =>
  `${jobID}-evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

export const shouldDebugTrackedEvent = (
  type: string,
  previousState: BackgroundJob["state"],
  nextState: BackgroundJob["state"],
) => {
  if (type !== "message.updated" && type !== "message.part.updated") {
    return true
  }

  return previousState === "launching" || previousState === "idle" || previousState !== nextState
}

export const mapJobStateToSnapshotState = (state: BackgroundJob["state"]): JobResultSnapshot["state"] => {
  switch (state) {
    case "aborted":
      return "aborted"
    case "failed":
    case "orphaned":
      return "failed"
    case "completed":
      return "completed"
    case "idle":
    default:
      return "idle"
  }
}

export const collectMessagePartsText = (parts: any[]) => {
  const text = parts
    .map((part) => {
      if (typeof part?.text === "string") {
        return part.text
      }

      if (part && typeof part === "object") {
        if (typeof part.summary === "string") {
          return part.summary
        }

        if (part.state && typeof part.state === "object") {
          if (typeof part.state.output === "string") {
            return part.state.output
          }

          if (typeof part.state.text === "string") {
            return part.state.text
          }

          if (typeof part.state.error === "string") {
            return part.state.error
          }
        }
      }

      return ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()

  return text.length > 0 ? text : ""
}

export const truncateSummary = (text: string | undefined) => {
  if (!text) {
    return ""
  }

  return text.length > 0 ? text.slice(0, 1200) : ""
}

export const defaultSummaryForState = (job: BackgroundJob) => {
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

export const collectBlockers = (job: BackgroundJob) => {
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

export const mergeBlockers = (job: BackgroundJob, reportedBlockers: string[]) => {
  return Array.from(new Set([...collectBlockers(job), ...reportedBlockers]))
}

export const normalizeLoadedJob = (job: BackgroundJob): BackgroundJob => {
  return {
    ...job,
    relayState: (job.relayState as string) === "not_requested" ? "pending" : (job.relayState ?? "pending"),
    lastSourceUpdatedAt: job.lastSourceUpdatedAt,
    pendingInput: job.pendingInput,
    lastResolvedPendingKind: job.lastResolvedPendingKind,
    lastResolvedPendingRequestID: job.lastResolvedPendingRequestID,
  }
}

export const toPublicJob = (job: BackgroundJob, hasResult = false): MissionControlJob => ({
  jobId: job.jobID,
  title: job.title,
  state: job.state,
  childSessionId: job.childSessionID,
  pendingKind: job.pendingInput?.kind,
  failureReason: job.failureReason,
  hasResult,
})

export const toPublicJobResult = (result: JobResultSnapshot | undefined): MissionControlJobResult | undefined =>
  result
    ? {
        jobId: result.jobID,
        childSessionId: result.childSessionID,
        state: result.state,
        headline: result.headline,
        summary: result.summary,
        blockers: result.blockers,
        recommendedNextStep: result.recommendedNextStep,
      }
    : undefined

export const toPublicJobEvent = (event: JobLifecycleEvent): MissionControlJobEvent => ({
  at: event.at,
  type: event.type,
  state: event.state,
  detail: event.detail,
  requestId: extractEventRequestId(event.metadata),
})

export const toPublicPendingInput = (job: BackgroundJob): MissionControlPendingInput | undefined => {
  if (job.pendingInput?.kind === "permission") {
    return {
      kind: "permission",
      requestId: job.pendingInput.requestId,
      permission: job.pendingInput.permission,
      patterns: job.pendingInput.patterns,
      always: job.pendingInput.always,
      reason: typeof job.pendingInput.metadata?.reason === "string" ? job.pendingInput.metadata.reason : undefined,
    }
  }

  if (job.pendingInput?.kind === "question") {
    return {
      kind: "question",
      requestId: job.pendingInput.requestId,
      questions: job.pendingInput.questions,
    }
  }

  return undefined
}

export const toPublicActionResult = (job: BackgroundJob): JobActionResult => ({
  jobId: job.jobID,
  state: job.state,
  failureReason: job.failureReason,
})

export const toPendingPermissionRequest = (value: unknown): JobPendingPermissionRequest | undefined => {
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

export const toPendingQuestionRequest = (value: unknown): JobPendingQuestionRequest | undefined => {
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

export const isSamePendingInput = (left: JobPendingInput | undefined, right: JobPendingInput | undefined) =>
  Boolean(left && right && left.kind === right.kind && left.requestId === right.requestId)

export const clearPendingInput = (job: BackgroundJob, kind: PendingInputKind, requestID?: string) => {
  if (!job.pendingInput || job.pendingInput.kind !== kind) {
    return
  }

  if (requestID && job.pendingInput.requestId !== requestID) {
    return
  }

  job.pendingInput = undefined
}

export const isResolvedPendingRequest = (job: BackgroundJob, kind: PendingInputKind, requestID: string) =>
  !job.pendingInput && job.lastResolvedPendingKind === kind && job.lastResolvedPendingRequestID === requestID

export const hasMismatchedPendingRequest = (job: BackgroundJob, kind: PendingInputKind, requestID?: string) => {
  if (!job.pendingInput) {
    return false
  }

  if (job.pendingInput.kind !== kind) {
    return true
  }

  return Boolean(requestID && job.pendingInput.requestId !== requestID)
}

export const hasConflictingPendingInput = (job: BackgroundJob, pendingInput: JobPendingInput) =>
  Boolean(job.pendingInput && job.pendingInput.requestId !== pendingInput.requestId)

export const describePendingInput = (pendingInput: JobPendingInput | undefined) => {
  if (!pendingInput) {
    return undefined
  }

  if (pendingInput.kind === "permission") {
    return `Waiting on permission '${pendingInput.permission}'.`
  }

  const firstQuestion = pendingInput.questions[0]?.header || pendingInput.questions[0]?.question
  return firstQuestion ? `Waiting on question '${firstQuestion}'.` : "Waiting on a question response."
}

export const parseStructuredFinalReport = (text: string) => {
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

export const buildStructuredSummary = (report: {
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

export const isStableResultState = (state: BackgroundJob["state"]) =>
  ["idle", "completed", "failed", "aborted"].includes(state)

export const canExposeStoredResult = (state: BackgroundJob["state"], hasStoredResult: boolean) =>
  isStableResultState(state) || (state === "orphaned" && hasStoredResult)

export const isClosedJobState = (state: BackgroundJob["state"]) =>
  ["completed", "failed", "aborted", "orphaned"].includes(state)

export const isRecoverableJobState = (state: BackgroundJob["state"]) =>
  ["queued", "launching", "running", "waiting_permission", "waiting_question"].includes(state)

export const isLiveTrackedJobState = (state: BackgroundJob["state"]) =>
  ["queued", "launching", "running", "waiting_permission", "waiting_question"].includes(state)

const extractEventRequestId = (metadata: Record<string, unknown> | undefined) => {
  if (!metadata) {
    return undefined
  }

  if (typeof metadata.requestId === "string") {
    return metadata.requestId
  }

  const pendingInput = metadata.pendingInput
  if (
    pendingInput &&
    typeof pendingInput === "object" &&
    "requestId" in pendingInput &&
    typeof pendingInput.requestId === "string"
  ) {
    return pendingInput.requestId
  }

  return undefined
}
