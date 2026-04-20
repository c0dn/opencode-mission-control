import type { SessionTranscriptEntry, SessionTranscriptPart } from "./types.js"

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
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  const candidates = [record.parentSessionID, record.parentID, record.parentId]

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate
    }
  }

  return undefined
}

export const extractTitle = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  const candidates = [record.title, record.name]

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate
    }
  }

  return undefined
}

export const normalizeMessage = (
  sessionID: string,
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
    sessionID,
    messageID: typeof info.id === "string" ? info.id : `${sessionID}:${Date.now()}`,
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
    partID: typeof part.id === "string" ? part.id : undefined,
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
