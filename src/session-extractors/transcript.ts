import type { SessionTranscriptEntry, SessionTranscriptPart } from "../types.js"
import { asTimestamp } from "./value-readers.js"

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
