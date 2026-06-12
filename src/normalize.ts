import type { SessionChunk, SessionTranscriptEntry } from "./types.js"
import type { SourceSessionRecord } from "./source-db.js"

export interface IndexedSessionRecord extends SourceSessionRecord {}

export const buildSessionChunks = (
  sessions: SourceSessionRecord[],
  entries: SessionTranscriptEntry[],
): SessionChunk[] => {
  const sessionMap = new Map(sessions.map((session) => [session.sessionID, session]))

  return entries.flatMap((entry) => {
    const session = sessionMap.get(entry.sessionId)

    return entry.parts.map((part, index) => ({
      chunkID: part.partId ?? `${entry.sessionId}:${entry.messageId}:${index}`,
      sessionID: entry.sessionId,
      messageID: entry.messageId,
      partID: part.partId,
      parentSessionID: session?.parentSessionID,
      role: normalizeRole(entry.role),
      partType: normalizePartType(part.type),
      agent: entry.agent,
      toolName: part.toolName,
      text: part.text,
      createdAt: entry.createdAt,
    }))
  })
}

const normalizeRole = (role: string): SessionChunk["role"] => {
  switch (role) {
    case "user":
    case "assistant":
    case "system":
    case "tool":
      return role
    default:
      return "unknown"
  }
}

const normalizePartType = (partType: string): SessionChunk["partType"] => {
  switch (partType) {
    case "text":
    case "tool":
    case "reasoning":
    case "step-start":
    case "step-finish":
    case "agent-switched":
    case "model-switched":
    case "compaction":
      return partType
    default:
      return "unknown"
  }
}
