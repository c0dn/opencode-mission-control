import { OpenCodeAdapter } from "./opencode-client.js"
import { MissionControlRuntimeState } from "./runtime-state.js"
import {
  extractDirectory,
  extractParentSessionID,
  extractSessionID,
  extractStatus,
  extractTitle,
  normalizeMessage,
} from "./session-extractors.js"
import type { SessionObserveResult, SessionReadResult, SessionTranscriptEntry, SessionTreeNode, ToolResult } from "./types.js"
import { fail, ok } from "./types.js"

export class MissionControlSessionService {
  constructor(private readonly state: MissionControlRuntimeState) {}

  async readSession(
    adapter: OpenCodeAdapter,
    sessionId: string,
    options: {
      beforeMessageId?: string
      limit?: number
      withChildren?: boolean
      withToolOutputs?: boolean
    },
  ): Promise<ToolResult<SessionReadResult>> {
    const relatedSessions: Array<{ sessionID: string; directory?: string }> = []

    try {
      const resolved = await adapter.resolveSession(sessionId)
      relatedSessions.push({
        sessionID: sessionId,
        directory: resolved.directory ?? extractDirectory(resolved.session),
      })
    } catch {
      return fail("ParentSessionNotFound", `Session '${sessionId}' was not found.`)
    }

    if (options.withChildren) {
      try {
        const parentDirectory = relatedSessions[0]?.directory
        const children = await adapter.getSessionChildren(sessionId, parentDirectory)
        for (const child of children) {
          const childID = extractSessionID(child)
          if (childID) {
            const cachedMetadata = this.state.metadataForSession(childID)
            relatedSessions.push({
              sessionID: childID,
              directory: extractDirectory(child) ?? cachedMetadata?.directory ?? parentDirectory,
            })
          }
        }
      } catch {
        return fail(
          "CurrentSessionUnavailable",
          `Failed to load child sessions for '${sessionId}'.`,
          "Retry the read, or retry without withChildren if the runtime is unstable.",
        )
      }
    }

    const messages: Array<{ sessionID: string; message: any; createdAt: number }> = []

    for (const relatedSession of relatedSessions) {
      try {
        const sessionMessages = await adapter.getSessionMessages(relatedSession.sessionID, relatedSession.directory)
        for (const message of sessionMessages) {
          messages.push({
            sessionID: relatedSession.sessionID,
            message,
            createdAt: getMessageCreatedAt(message),
          })
        }
      } catch {
        return fail(
          "CurrentSessionUnavailable",
          `Failed to load messages for session '${relatedSession.sessionID}'.`,
          "Retry after the session becomes stable, or reduce the request scope.",
        )
      }
    }

    messages.sort((left, right) => left.createdAt - right.createdAt)
    const cursorIndex = options.beforeMessageId
      ? messages.findIndex(({ message }) => getMessageID(message) === options.beforeMessageId)
      : -1
    const cursorScopedMessages = cursorIndex >= 0 ? messages.slice(0, cursorIndex) : messages

    const entries: SessionTranscriptEntry[] = []
    for (const { sessionID, message } of cursorScopedMessages) {
      const normalized = normalizeMessage(sessionID, message, options.withToolOutputs ?? false)
      if (normalized) {
        entries.push(normalized)
      }
    }

    entries.sort((left, right) => left.createdAt - right.createdAt)
    const boundedEntries = typeof options.limit === "number" ? entries.slice(-options.limit) : entries

    return ok({
      sessionId,
      entries: boundedEntries,
      includedChildSessionIds: relatedSessions.slice(1).map((session) => session.sessionID),
    })
  }

  async sessionTree(adapter: OpenCodeAdapter, sessionId: string, depth = 1): Promise<ToolResult<SessionTreeNode>> {
    try {
      const resolved = await adapter.resolveSession(sessionId)

      try {
        const node = await this.buildTree(
          adapter,
          sessionId,
          Math.max(0, Math.trunc(depth)),
          resolved.session,
          resolved.directory,
        )
        return ok(node)
      } catch {
        return fail(
          "CurrentSessionUnavailable",
          `Failed to build the tree for session '${sessionId}'.`,
          "Retry after the runtime settles, or reduce the requested depth.",
        )
      }
    } catch {
      return fail("ParentSessionNotFound", `Session '${sessionId}' was not found.`)
    }
  }

  async observeSession(
    adapter: OpenCodeAdapter,
    sessionId: string,
    options: {
      withChildren?: boolean
      limit?: number
    },
  ): Promise<ToolResult<SessionObserveResult>> {
    let session: unknown
    let sessionDirectory: string | undefined

    try {
      const resolved = await adapter.resolveSession(sessionId)
      session = resolved.session
      sessionDirectory = resolved.directory ?? extractDirectory(resolved.session)
    } catch {
      return fail("ParentSessionNotFound", `Session '${sessionId}' was not found.`)
    }

    const sessionIDs = new Set<string>([sessionId])
    let childSummaries: SessionObserveResult["children"] = undefined

    if (options.withChildren) {
      try {
        const children = await adapter.getSessionChildren(sessionId, sessionDirectory)
        childSummaries = children.map((child) => {
          const childID = extractSessionID(child) ?? "unknown"
          const cachedMetadata = this.state.metadataForSession(childID)
          sessionIDs.add(childID)

          return {
            sessionId: childID,
            status: this.state.statusForSession(childID, extractStatus(child)),
            title: extractTitle(child) ?? cachedMetadata?.title,
          }
        })
      } catch {
        return fail(
          "CurrentSessionUnavailable",
          `Failed to load child sessions for '${sessionId}'.`,
          "Retry without withChildren if you only need the parent session state.",
        )
      }
    }

    const rawEventLimit = options.limit ?? 20

    return ok({
      sessionId,
      status: this.state.statusForSession(sessionId, extractStatus(session)),
      recentEvents: this.state.recentEventsForSessions(sessionIDs, rawEventLimit),
      children: childSummaries,
    })
  }

  private async buildTree(
    adapter: OpenCodeAdapter,
    sessionId: string,
    depth: number,
    seededSession?: unknown,
    seededDirectory?: string,
  ): Promise<SessionTreeNode> {
    const session = seededSession ?? (await adapter.getSession(sessionId, seededDirectory))
    const cachedMetadata = this.state.metadataForSession(sessionId)
    const sessionDirectory = extractDirectory(session) ?? cachedMetadata?.directory ?? seededDirectory
    const node: SessionTreeNode = {
      sessionId,
      title: extractTitle(session) ?? cachedMetadata?.title,
      parentSessionId: extractParentSessionID(session) ?? cachedMetadata?.parentSessionId,
      status: this.state.statusForSession(sessionId, extractStatus(session)),
      children: [],
    }

    if (depth <= 0) {
      return node
    }

    const children = await adapter.getSessionChildren(sessionId, sessionDirectory)
    for (const child of children) {
      const childID = extractSessionID(child)
      if (!childID) {
        continue
      }

      const childMetadata = this.state.metadataForSession(childID)

      node.children.push(
        await this.buildTree(
          adapter,
          childID,
          depth - 1,
          child,
          extractDirectory(child) ?? childMetadata?.directory ?? sessionDirectory,
        ),
      )
    }

    return node
  }
}

const getMessageID = (message: any) => (typeof message?.info?.id === "string" ? message.info.id : undefined)

const getMessageCreatedAt = (message: any) => {
  const createdAt = message?.info?.time?.created ?? message?.info?.createdAt

  if (typeof createdAt === "number") {
    return createdAt
  }

  if (typeof createdAt === "string") {
    const parsed = Date.parse(createdAt)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  return Date.now()
}
