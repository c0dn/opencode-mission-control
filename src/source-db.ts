import {
  extractDirectory,
  extractParentSessionID,
  extractSessionID,
  extractSessionTimestamp,
  extractTitle,
  normalizeMessage,
} from "./session-extractors.js"
import type { SessionTranscriptEntry } from "./types.js"
import { OpenCodeAdapter } from "./opencode-client.js"

export interface SourceSessionRecord {
  sessionID: string
  title: string
  directory?: string
  parentSessionID?: string
  createdAt: number
  updatedAt: number
}

export class MissionControlSourceDB {
  async listSessions(adapter: OpenCodeAdapter, options: { global?: boolean } = {}): Promise<SourceSessionRecord[]> {
    const sessions = await adapter.listSessions(options)

    return sessions.flatMap((session: any) => {
      const sessionID = extractSessionID(session)
      if (!sessionID) {
        return []
      }

      return [
        {
          sessionID,
          title: extractTitle(session) ?? "Untitled session",
          directory: extractDirectory(session) ?? (options.global ? "" : undefined),
          parentSessionID: extractParentSessionID(session),
          createdAt: extractSessionTimestamp(session, "created") ?? Date.now(),
          updatedAt: extractSessionTimestamp(session, "updated") ?? Date.now(),
        },
      ]
    })
  }

  async readSessionEntries(
    adapter: OpenCodeAdapter,
    sessions: Iterable<SourceSessionRecord>,
    options: {
      includeToolOutputs: boolean
    },
  ): Promise<SessionTranscriptEntry[]> {
    const entries: SessionTranscriptEntry[] = []

    for (const session of sessions) {
      const messages = await adapter.getSessionMessages(session.sessionID, session.directory)
      for (const message of messages) {
        const normalized = normalizeMessage(session.sessionID, message, options.includeToolOutputs)
        if (normalized) {
          entries.push(normalized)
        }
      }
    }

    entries.sort((left, right) => left.createdAt - right.createdAt)
    return entries
  }

  collectScopedSessionIDs(
    sessions: SourceSessionRecord[],
    scope: {
      sessionId?: string
      includeChildren?: boolean
    },
  ): Set<string> {
    if (!scope.sessionId) {
      return new Set(sessions.map((session) => session.sessionID))
    }

    const allowed = new Set<string>([scope.sessionId])
    if (!scope.includeChildren) {
      return allowed
    }

    const childrenByParent = new Map<string, string[]>()
    for (const session of sessions) {
      if (!session.parentSessionID) {
        continue
      }

      const siblings = childrenByParent.get(session.parentSessionID) ?? []
      siblings.push(session.sessionID)
      childrenByParent.set(session.parentSessionID, siblings)
    }

    const queue = [scope.sessionId]
    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) {
        continue
      }

      for (const childID of childrenByParent.get(current) ?? []) {
        if (allowed.has(childID)) {
          continue
        }

        allowed.add(childID)
        queue.push(childID)
      }
    }

    return allowed
  }

  findSessionsByExactTitle(
    sessions: SourceSessionRecord[],
    title: string,
    options: {
      limit?: number
    } = {},
  ): SourceSessionRecord[] {
    const limit = Math.max(1, Math.trunc(options.limit ?? (sessions.length || 1)))
    return sessions
      .filter((session) => session.title === title)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.sessionID.localeCompare(right.sessionID))
      .slice(0, limit)
  }
}
