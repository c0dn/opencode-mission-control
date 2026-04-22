import type {
  JobPendingPermissionRequest,
  JobPendingQuestionInfo,
  JobPendingQuestionOption,
  JobPendingQuestionRequest,
  PendingInputToolReference,
  SessionTranscriptEntry,
  SessionTranscriptPart,
} from "./types.js"

export const extractStatus = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  const direct = normalizeStatusValue(record.status)
  if (direct) {
    return direct
  }

  const nested = record.properties
  if (nested && typeof nested === "object") {
    return normalizeStatusValue((nested as Record<string, unknown>).status)
  }

  return undefined
}

const normalizeStatusValue = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value
  }

  if (value && typeof value === "object" && typeof (value as Record<string, unknown>).type === "string") {
    return (value as Record<string, string>).type
  }

  return undefined
}

export const extractSessionID = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  const candidates = [record.sessionID, record.sessionId, record.id]

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate
    }
  }

  if (record.properties && typeof record.properties === "object") {
    return extractSessionID(record.properties)
  }

  const nestedCandidates = [record.info, record.part, record.message, record.session]
  for (const nested of nestedCandidates) {
    if (nested && typeof nested === "object") {
      const nestedSessionID = extractSessionID(nested)
      if (nestedSessionID) {
        return nestedSessionID
      }
    }
  }

  return undefined
}

export const extractParentSessionID = (value: unknown): string | undefined => {
  return extractStringCandidate(value, ["parentSessionID", "parentID", "parentId"])
}

export const hasParentSessionReference = (value: unknown): boolean => {
  if (!value || typeof value !== "object") {
    return false
  }

  const record = value as Record<string, unknown>
  if ("parentSessionID" in record || "parentID" in record || "parentId" in record) {
    return true
  }

  return [record.properties, record.info, record.session].some((nested) => hasParentSessionReference(nested))
}

export const extractTitle = (value: unknown): string | undefined => {
  return extractStringCandidate(value, ["title", "name"])
}

export const extractDirectory = (value: unknown): string | undefined => {
  return extractStringCandidate(value, ["directory"])
}

export const extractRequestID = (value: unknown): string | undefined => {
  return extractStringCandidate(value, ["requestID", "requestId", "id"])
}

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

export const extractSessionTimestamp = (
  value: unknown,
  kind: "created" | "updated",
): number | undefined => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  const directCandidates =
    kind === "created"
      ? [record.createdAt, record.created, extractTimeValue(record.time, "created")]
      : [record.updatedAt, record.updated, extractTimeValue(record.time, "updated")]

  for (const candidate of directCandidates) {
    const timestamp = asOptionalTimestamp(candidate)
    if (timestamp !== undefined) {
      return timestamp
    }
  }

  const nestedCandidates = [record.properties, record.info, record.session]
  for (const nested of nestedCandidates) {
    const timestamp = extractSessionTimestamp(nested, kind)
    if (timestamp !== undefined) {
      return timestamp
    }
  }

  return undefined
}

export const normalizeMessage = (
  sessionId: string,
  message: any,
  includeToolOutputs: boolean,
): SessionTranscriptEntry | undefined => {
  const info = message?.info ?? {}
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const createdAt = info?.time?.created ?? info.createdAt

  const normalizedParts: SessionTranscriptPart[] = parts
    .map((part: any) => normalizePart(part))
    .filter((part: SessionTranscriptPart | undefined): part is SessionTranscriptPart => Boolean(part))
    .filter((part: SessionTranscriptPart) => includeToolOutputs || part.type !== "tool")

  if (normalizedParts.length === 0) {
    return undefined
  }

  return {
    sessionId,
    messageId: typeof info.id === "string" ? info.id : `${sessionId}:${Date.now()}`,
    role: typeof info.role === "string" ? info.role : "unknown",
    agent: typeof info.agent === "string" ? info.agent : undefined,
    createdAt: asTimestamp(createdAt),
    parts: normalizedParts,
  }
}

const normalizePart = (part: any): SessionTranscriptPart | undefined => {
  if (!part || typeof part !== "object") {
    return undefined
  }

  const type = typeof part.type === "string" ? part.type : "unknown"
  const text = extractPartText(part)

  if (!text) {
    return undefined
  }

  return {
    partId: typeof part.id === "string" ? part.id : undefined,
    type,
    text,
    toolName:
      typeof part.tool === "string"
        ? part.tool
        : typeof part.toolName === "string"
          ? part.toolName
          : undefined,
  }
}

const extractPartText = (part: any): string => {
  if (typeof part.text === "string") {
    return part.text
  }

  if (part.state && typeof part.state === "object") {
    if (typeof part.state.output === "string") {
      return part.state.output
    }

    if (typeof part.state.error === "string") {
      return part.state.error
    }
  }

  if (typeof part.output === "string") {
    return part.output
  }

  if (typeof part.snapshot === "string") {
    return part.snapshot
  }

  if (typeof part.reason === "string") {
    return part.reason
  }

  if (typeof part.prompt === "string") {
    return part.prompt
  }

  if (typeof part.description === "string") {
    return part.description
  }

  if (Array.isArray(part.content)) {
    return part.content
      .map((entry: any) => {
        if (typeof entry === "string") {
          return entry
        }

        if (entry && typeof entry === "object" && typeof entry.text === "string") {
          return entry.text
        }

        return ""
      })
      .filter(Boolean)
      .join("\n")
  }

  return ""
}

const asTimestamp = (value: unknown) => {
  if (typeof value === "number") {
    return value
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  return Date.now()
}

const extractStringCandidate = (value: unknown, keys: string[]): string | undefined => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === "string") {
      return candidate
    }
  }

  const nestedCandidates = [record.properties, record.info, record.session]
  for (const nested of nestedCandidates) {
    const candidate = extractStringCandidate(nested, keys)
    if (candidate) {
      return candidate
    }
  }

  return undefined
}

const extractUnknownCandidate = (value: unknown, keys: string[]): unknown => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  for (const key of keys) {
    if (key in record) {
      return record[key]
    }
  }

  const nestedCandidates = [record.properties, record.info, record.session]
  for (const nested of nestedCandidates) {
    const candidate = extractUnknownCandidate(nested, keys)
    if (candidate !== undefined) {
      return candidate
    }
  }

  return undefined
}

const extractStringArrayCandidate = (value: unknown, keys: string[]): string[] => {
  const candidate = extractUnknownCandidate(value, keys)
  if (!Array.isArray(candidate)) {
    return []
  }

  return candidate.filter((entry): entry is string => typeof entry === "string")
}

const extractRecordCandidate = (value: unknown, keys: string[]): Record<string, unknown> => {
  const candidate = extractUnknownCandidate(value, keys)
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? { ...(candidate as Record<string, unknown>) }
    : {}
}

const extractToolReference = (value: unknown): PendingInputToolReference | undefined => {
  const candidate = extractUnknownCandidate(value, ["tool"])
  if (!candidate || typeof candidate !== "object") {
    return undefined
  }

  const record = candidate as Record<string, unknown>
  const messageId =
    typeof record.messageID === "string"
      ? record.messageID
      : typeof record.messageId === "string"
        ? record.messageId
        : undefined
  const callId =
    typeof record.callID === "string"
      ? record.callID
      : typeof record.callId === "string"
        ? record.callId
        : undefined

  if (!messageId || !callId) {
    return undefined
  }

  return {
    messageId,
    callId,
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

const extractTimeValue = (value: unknown, key: "created" | "updated") => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  return (value as Record<string, unknown>)[key]
}

const asOptionalTimestamp = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return value
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  return undefined
}
