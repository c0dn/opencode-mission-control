import type {
  JobPendingPermissionRequest,
  JobPendingQuestionInfo,
  JobPendingQuestionOption,
  JobPendingQuestionRequest,
} from "../types.js"
import { extractRequestID, extractSessionID } from "./core.js"
import {
  extractRecordCandidate,
  extractStringArrayCandidate,
  extractStringCandidate,
  extractToolReference,
  extractUnknownCandidate,
} from "./value-readers.js"

export const extractPermissionRequest = (
  value: unknown,
): Omit<JobPendingPermissionRequest, "kind" | "askedAt"> | undefined => {
  const requestId = extractRequestID(value)
  const sessionId = extractSessionID(value)
  const permission = extractStringCandidate(value, ["permission"])

  if (!requestId || !sessionId || !permission) {
    return undefined
  }

  return {
    requestId,
    sessionId,
    permission,
    patterns: extractStringArrayCandidate(value, ["patterns"]),
    always: extractStringArrayCandidate(value, ["always"]),
    metadata: extractRecordCandidate(value, ["metadata"]),
    tool: extractToolReference(value),
  }
}

export const extractQuestionRequest = (
  value: unknown,
): Omit<JobPendingQuestionRequest, "kind" | "askedAt"> | undefined => {
  const requestId = extractRequestID(value)
  const sessionId = extractSessionID(value)
  const record = extractRecordCandidate(value, ["properties"])
  const questionsValue =
    extractUnknownCandidate(value, ["questions"]) ??
    (Object.keys(record).length > 0 ? record.questions : undefined)
  const questions = normalizeQuestionInfoList(questionsValue)

  if (!requestId || !sessionId || questions.length === 0) {
    return undefined
  }

  return {
    requestId,
    sessionId,
    questions,
    tool: extractToolReference(value),
  }
}

const normalizeQuestionInfoList = (value: unknown): JobPendingQuestionInfo[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => normalizeQuestionInfo(entry))
    .filter((entry): entry is JobPendingQuestionInfo => Boolean(entry))
}

const normalizeQuestionInfo = (value: unknown): JobPendingQuestionInfo | undefined => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  const question = typeof record.question === "string" ? record.question : undefined
  const header = typeof record.header === "string" ? record.header : undefined
  const options = normalizeQuestionOptions(record.options)

  if (!question || !header) {
    return undefined
  }

  return {
    question,
    header,
    options,
    multiple: typeof record.multiple === "boolean" ? record.multiple : undefined,
    custom: typeof record.custom === "boolean" ? record.custom : undefined,
  }
}

const normalizeQuestionOptions = (value: unknown): JobPendingQuestionOption[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return undefined
      }

      const record = entry as Record<string, unknown>
      if (typeof record.label !== "string" || typeof record.description !== "string") {
        return undefined
      }

      return {
        label: record.label,
        description: record.description,
      }
    })
    .filter((entry): entry is JobPendingQuestionOption => Boolean(entry))
}
