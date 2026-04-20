import type { MissionControlEventRecord } from "./types.js"
import { extractSessionID, extractStatus } from "./session-extractors.js"

export class MissionControlRuntimeState {
  private bufferSize: number
  private readonly eventCounts = new Map<string, number>()
  private readonly recentEvents: MissionControlEventRecord[] = []
  private readonly sessionStatuses = new Map<string, string>()
  private readonly dirtySessions = new Map<string, number>()

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

    if (record.sessionID && shouldMarkSessionDirty(type)) {
      this.dirtySessions.set(record.sessionID, Math.max((this.dirtySessions.get(record.sessionID) ?? 0) + 1, record.at))
    }

    if (!record.sessionID) {
      return
    }

    if (type === "session.idle") {
      this.sessionStatuses.set(record.sessionID, "idle")
      return
    }

    if (type === "session.error") {
      this.sessionStatuses.set(record.sessionID, "error")
      return
    }

    if (type === "permission.asked") {
      this.sessionStatuses.set(record.sessionID, "waiting_permission")
      return
    }

    if (type === "permission.replied") {
      this.sessionStatuses.set(record.sessionID, "running")
      return
    }

    if (type === "question.asked") {
      this.sessionStatuses.set(record.sessionID, "waiting_question")
      return
    }

    if (type === "question.replied") {
      this.sessionStatuses.set(record.sessionID, "running")
      return
    }

    if (type === "question.rejected") {
      this.sessionStatuses.set(record.sessionID, "failed")
      return
    }

    if (type === "session.status") {
      const status = extractStatus(payload)
      if (status) {
        this.sessionStatuses.set(record.sessionID, status)
      }
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
      .filter((event) => event.sessionID && scopedIDs.has(event.sessionID))
      .slice(-boundedLimit)
      .reverse()
  }

  private normalizeEvent(type: string, payload: unknown): MissionControlEventRecord {
    const sessionID = extractSessionID(payload)
    return {
      type,
      at: Date.now(),
      sessionID,
      summary: this.summarizeEvent(type, payload),
    }
  }

  private summarizeEvent(type: string, payload: unknown) {
    const status = extractStatus(payload)
    if (status) {
      return `${type} (${status})`
    }

    const sessionID = extractSessionID(payload)
    if (sessionID) {
      return `${type} for ${sessionID}`
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
}

const shouldMarkSessionDirty = (type: string) =>
  [
    "session.created",
    "session.updated",
    "session.compacted",
    "message.updated",
    "message.removed",
    "message.part.updated",
    "message.part.removed",
  ].includes(type)
