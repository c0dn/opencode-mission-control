import {
  extractDirectory,
  extractParentSessionID,
  extractSessionID,
  extractSessionTimestamp,
  extractStatus,
  extractTitle,
  extractWorkspaceID,
  hasParentSessionReference,
} from "./session-extractors.js"
import type { MissionControlEventRecord, RuntimeSessionMetadata } from "./types.js"
import type { RuntimeChildSessionSummary } from "./types.js"

export class MissionControlRuntimeState {
  private bufferSize: number
  private readonly eventCounts = new Map<string, number>()
  private readonly recentEvents: MissionControlEventRecord[] = []
  private readonly sessionStatuses = new Map<string, string>()
  private readonly dirtySessions = new Map<string, number>()
  private readonly sessionMetadata = new Map<string, RuntimeSessionMetadata>()
  private readonly childSessionIDsByParent = new Map<string, Set<string>>()

  constructor(bufferSize: number) {
    this.bufferSize = this.normalizeBufferSize(bufferSize)
  }

  setBufferSize(bufferSize: number) {
    this.bufferSize = this.normalizeBufferSize(bufferSize)
    this.trimBuffer()
  }

  recordEvent(type: string, payload: unknown) {
    const record = this.normalizeEvent(type, payload)
    this.recentEvents.push(record)
    this.eventCounts.set(type, (this.eventCounts.get(type) ?? 0) + 1)
    this.trimBuffer()

    if (record.sessionId && shouldRefreshSessionMetadata(type)) {
      this.refreshSessionMetadata(record.sessionId, payload)
    }

    if (record.sessionId && shouldMarkSessionDirty(type)) {
      this.dirtySessions.set(record.sessionId, Math.max((this.dirtySessions.get(record.sessionId) ?? 0) + 1, record.at))
    }

    if (!record.sessionId) {
      return
    }

    if (type === "session.deleted") {
      this.deleteSession(record.sessionId)
      this.dirtySessions.set(record.sessionId, Math.max((this.dirtySessions.get(record.sessionId) ?? 0) + 1, record.at))
      return
    }

    if (type === "session.idle") {
      this.sessionStatuses.set(record.sessionId, "idle")
      return
    }

    if (type === "session.error") {
      this.sessionStatuses.set(record.sessionId, "error")
      return
    }

    if (type === "permission.asked") {
      this.sessionStatuses.set(record.sessionId, "waiting_permission")
      return
    }

    if (type === "permission.replied") {
      this.sessionStatuses.set(record.sessionId, "running")
      return
    }

    if (type === "question.asked") {
      this.sessionStatuses.set(record.sessionId, "waiting_question")
      return
    }

    if (type === "question.replied") {
      this.sessionStatuses.set(record.sessionId, "running")
      return
    }

    if (type === "question.rejected") {
      this.sessionStatuses.set(record.sessionId, "failed")
      return
    }

    if (type === "session.status") {
        const status = extractStatus(payload)
        if (status) {
        this.sessionStatuses.set(record.sessionId, status)
      }
      return
    }

    if (type === "session.next.step.failed" || type === "session.next.tool.failed") {
      this.sessionStatuses.set(record.sessionId, "error")
      return
    }

    if (type.startsWith("session.next.")) {
      this.sessionStatuses.set(record.sessionId, "running")
    }
  }

  counters() {
    return {
      totalEvents: Array.from(this.eventCounts.values()).reduce((sum, count) => sum + count, 0),
      byType: Object.fromEntries(this.eventCounts.entries()),
    }
  }

  statusForSession(sessionID: string, fallback?: string) {
    return this.sessionStatuses.get(sessionID) ?? fallback
  }

  metadataForSession(sessionID: string) {
    return this.sessionMetadata.get(sessionID)
  }

  childSessionIDs(parentSessionID: string) {
    return Array.from(this.childSessionIDsByParent.get(parentSessionID) ?? [])
  }

  childSessionSummaries(parentSessionID: string, options: { recursive?: boolean; limit?: number } = {}) {
    const recursive = options.recursive ?? true
    const limit = Math.max(1, Math.trunc(options.limit ?? 20))
    const summaries: RuntimeChildSessionSummary[] = []
    const visited = new Set<string>([parentSessionID])
    const queue = this.childSessionIDs(parentSessionID).map((sessionID) => ({ sessionID, depth: 1 }))

    while (queue.length > 0 && summaries.length < limit) {
      const next = queue.shift()
      if (!next || visited.has(next.sessionID)) {
        continue
      }
      visited.add(next.sessionID)

      const metadata = this.sessionMetadata.get(next.sessionID)
      summaries.push({
        sessionId: next.sessionID,
        parentSessionId: metadata?.parentSessionId ?? parentSessionID,
        title: metadata?.title,
        status: this.statusForSession(next.sessionID),
        directory: metadata?.directory,
        workspaceID: metadata?.workspaceID,
        depth: next.depth,
      })

      if (recursive) {
        for (const childID of this.childSessionIDs(next.sessionID)) {
          queue.push({ sessionID: childID, depth: next.depth + 1 })
        }
      }
    }

    return summaries
  }

  dirtySessionCount(sessionIDs?: Iterable<string>) {
    return this.getDirtySessionIDs(sessionIDs).length
  }

  dirtySessionIDs(sessionIDs?: Iterable<string>) {
    return this.getDirtySessionIDs(sessionIDs)
  }

  dirtySessionsWithTimestamps(sessionIDs?: Iterable<string>) {
    return this.getDirtySessionsWithTimestamps(sessionIDs)
  }

  isSessionDirty(sessionID: string) {
    return this.dirtySessions.has(sessionID)
  }

  clearDirtySessionsUpTo(dirtySessions: Record<string, number>) {
    for (const [sessionID, dirtyAt] of Object.entries(dirtySessions)) {
      if ((this.dirtySessions.get(sessionID) ?? 0) <= dirtyAt) {
        this.dirtySessions.delete(sessionID)
      }
    }
  }

  recentEventsForSessions(sessionIDs: Iterable<string>, limit: number) {
    const scopedIDs = new Set(sessionIDs)
    const boundedLimit = Math.max(1, Math.trunc(limit))

    return this.recentEvents
      .filter((event) => event.sessionId && scopedIDs.has(event.sessionId))
      .slice(-boundedLimit)
      .reverse()
  }

  recentEventsGlobal(limit?: number) {
    const boundedLimit = Math.max(1, Math.trunc(limit ?? this.bufferSize))
    return this.recentEvents.slice(-boundedLimit).reverse()
  }

  private normalizeEvent(type: string, payload: unknown): MissionControlEventRecord {
    const sessionId = extractSessionID(payload)
    return {
      type,
      at: Date.now(),
      sessionId,
      summary: this.summarizeEvent(type, payload),
    }
  }

  private summarizeEvent(type: string, payload: unknown) {
    const status = extractStatus(payload)
    if (status) {
      return `${type} (${status})`
    }

    const sessionId = extractSessionID(payload)
    if (sessionId) {
      return `${type} for ${sessionId}`
    }

    return type
  }

  private trimBuffer() {
    while (this.recentEvents.length > this.bufferSize) {
      this.recentEvents.shift()
    }
  }

  private normalizeBufferSize(bufferSize: number) {
    return Math.max(1, Math.trunc(bufferSize))
  }

  private getDirtySessionIDs(sessionIDs?: Iterable<string>) {
    return Object.keys(this.getDirtySessionsWithTimestamps(sessionIDs))
  }

  private getDirtySessionsWithTimestamps(sessionIDs?: Iterable<string>) {
    if (!sessionIDs) {
      return Object.fromEntries(this.dirtySessions.entries())
    }

    const allowed = new Set(sessionIDs)
    return Object.fromEntries(Array.from(this.dirtySessions.entries()).filter(([sessionID]) => allowed.has(sessionID)))
  }

  private refreshSessionMetadata(sessionId: string, payload: unknown) {
    const previous = this.sessionMetadata.get(sessionId)
    const parentSessionId = hasParentSessionReference(payload)
      ? extractParentSessionID(payload)
      : previous?.parentSessionId
    const createdAt = extractSessionTimestamp(payload, "created") ?? previous?.createdAt
    const updatedAt = extractSessionTimestamp(payload, "updated") ?? previous?.updatedAt
    const previousVersion = previous?.updatedAt ?? previous?.createdAt
    const nextVersion = updatedAt ?? createdAt

    if (
      previousVersion !== undefined &&
      nextVersion !== undefined &&
      nextVersion < previousVersion
    ) {
      return
    }

    const next: RuntimeSessionMetadata = {
      sessionId,
      parentSessionId,
      title: extractTitle(payload) ?? previous?.title,
      directory: extractDirectory(payload) ?? previous?.directory,
      workspaceID: extractWorkspaceID(payload) ?? previous?.workspaceID,
      createdAt,
      updatedAt,
      observedAt: Date.now(),
    }

    if (
      !next.parentSessionId &&
      !next.title &&
      !next.directory &&
      !next.workspaceID &&
      next.createdAt === undefined &&
      next.updatedAt === undefined
    ) {
      return
    }

    if (previous?.parentSessionId && previous.parentSessionId !== next.parentSessionId) {
      const previousChildren = this.childSessionIDsByParent.get(previous.parentSessionId)
      previousChildren?.delete(sessionId)
      if (previousChildren && previousChildren.size === 0) {
        this.childSessionIDsByParent.delete(previous.parentSessionId)
      }
    }

    if (next.parentSessionId) {
      const siblings = this.childSessionIDsByParent.get(next.parentSessionId) ?? new Set<string>()
      siblings.add(sessionId)
      this.childSessionIDsByParent.set(next.parentSessionId, siblings)
    }

    this.sessionMetadata.set(sessionId, next)
  }

  private deleteSession(sessionId: string) {
    this.sessionStatuses.delete(sessionId)
    this.sessionMetadata.delete(sessionId)
    for (const [parentID, children] of this.childSessionIDsByParent.entries()) {
      children.delete(sessionId)
      if (children.size === 0) {
        this.childSessionIDsByParent.delete(parentID)
      }
    }
    this.childSessionIDsByParent.delete(sessionId)
  }
}

const shouldMarkSessionDirty = (type: string) =>
  [
    "session.created",
    "session.updated",
    "session.compacted",
    "session.deleted",
    "message.updated",
    "message.removed",
    "message.part.updated",
    "message.part.removed",
  ].includes(type)

const shouldRefreshSessionMetadata = (type: string) =>
  ["session.created", "session.updated", "session.status", "session.idle", "session.error"].includes(type)
