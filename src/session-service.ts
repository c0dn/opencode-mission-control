import { OpenCodeAdapter } from "./opencode-client.js"
import { MissionControlRuntimeState } from "./runtime-state.js"
import {
  extractParentSessionID,
  extractSessionID,
  extractStatus,
  extractTitle,
  normalizeMessage,
} from "./session-extractors.js"
import type { SessionObserveResult, SessionReadResult, SessionTranscriptEntry, SessionTreeNode, ToolResult } from "./types.js"
import { fail, ok } from "./types.js"

const extractSessionDirectory = (session: unknown) => {
  return typeof (session as { directory?: unknown } | undefined)?.directory === "string"
    ? ((session as { directory?: string }).directory ?? undefined)
    : undefined
}

export class MissionControlSessionService {
  constructor(private readonly state: MissionControlRuntimeState) {}

  async readSession(
    adapter: OpenCodeAdapter,
    sessionID: string,
    options: {
      beforeMessageID?: string
      limit?: number
      includeChildren?: boolean
      includeToolOutputs?: boolean
    },
  ): Promise<ToolResult<SessionReadResult>> {
    const relatedSessions: Array<{ sessionID: string; directory?: string }> = []

    try {
      const resolved = await adapter.resolveSession(sessionID)
      relatedSessions.push({
        sessionID,
        directory: resolved.directory ?? extractSessionDirectory(resolved.session),
      })
    } catch {
      return fail("ParentSessionNotFound", `Session '${sessionID}' was not found.`)
    }

    if (options.includeChildren) {
      try {
        const parentDirectory = relatedSessions[0]?.directory
        const children = await adapter.getSessionChildren(sessionID, parentDirectory)
        for (const child of children) {
          const childID = extractSessionID(child)
          if (childID) {
            relatedSessions.push({
              sessionID: childID,
              directory: extractSessionDirectory(child) ?? parentDirectory,
            })
          }
        }
      } catch {
        return fail(
          "CurrentSessionUnavailable",
          `Failed to load child sessions for '${sessionID}'.`,
          "Retry the read, or retry without includeChildren if the runtime is unstable.",
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
    const cursorIndex = options.beforeMessageID
      ? messages.findIndex(({ message }) => getMessageID(message) === options.beforeMessageID)
      : -1
    const cursorScopedMessages = cursorIndex >= 0 ? messages.slice(0, cursorIndex) : messages

    const entries: SessionTranscriptEntry[] = []
    for (const { sessionID, message } of cursorScopedMessages) {
      const normalized = normalizeMessage(sessionID, message, options.includeToolOutputs ?? false)
      if (normalized) {
        entries.push(normalized)
      }
    }

    entries.sort((left, right) => left.createdAt - right.createdAt)
    const boundedEntries = typeof options.limit === "number" ? entries.slice(-options.limit) : entries

    return ok({
      sessionID,
      entries: boundedEntries,
      includedChildSessionIDs: relatedSessions.slice(1).map((session) => session.sessionID),
    })
  }

  async sessionTree(adapter: OpenCodeAdapter, sessionID: string, depth = 1): Promise<ToolResult<SessionTreeNode>> {
    try {
      const resolved = await adapter.resolveSession(sessionID)

      try {
        const node = await this.buildTree(
          adapter,
          sessionID,
          Math.max(0, Math.trunc(depth)),
          resolved.session,
          resolved.directory,
        )
        return ok(node)
      } catch {
        return fail(
          "CurrentSessionUnavailable",
          `Failed to build the tree for session '${sessionID}'.`,
          "Retry after the runtime settles, or reduce the requested depth.",
        )
      }
    } catch {
      return fail("ParentSessionNotFound", `Session '${sessionID}' was not found.`)
    }
  }

  async observeSession(
    adapter: OpenCodeAdapter,
    sessionID: string,
    options: {
      includeChildren?: boolean
      eventLimit?: number
    },
  ): Promise<ToolResult<SessionObserveResult>> {
    let session: unknown
    let sessionDirectory: string | undefined

    try {
      const resolved = await adapter.resolveSession(sessionID)
      session = resolved.session
      sessionDirectory = resolved.directory ?? extractSessionDirectory(resolved.session)
    } catch {
      return fail("ParentSessionNotFound", `Session '${sessionID}' was not found.`)
    }

    const sessionIDs = new Set<string>([sessionID])
    let childSummaries: SessionObserveResult["children"] = undefined

    if (options.includeChildren) {
      try {
        const children = await adapter.getSessionChildren(sessionID, sessionDirectory)
        childSummaries = children.map((child) => {
          const childID = extractSessionID(child) ?? "unknown"
          sessionIDs.add(childID)

          return {
            sessionID: childID,
            status: this.state.statusForSession(childID, extractStatus(child)),
            title: extractTitle(child),
          }
        })
      } catch {
        return fail(
          "CurrentSessionUnavailable",
          `Failed to load child sessions for '${sessionID}'.`,
          "Retry without includeChildren if you only need the parent session state.",
        )
      }
    }

    const rawEventLimit = options.eventLimit ?? 20

    return ok({
      sessionID,
      status: this.state.statusForSession(sessionID, extractStatus(session)),
      recentEvents: this.state.recentEventsForSessions(sessionIDs, rawEventLimit),
      children: childSummaries,
    })
  }

  private async buildTree(
    adapter: OpenCodeAdapter,
    sessionID: string,
    depth: number,
    seededSession?: unknown,
    seededDirectory?: string,
  ): Promise<SessionTreeNode> {
    const session = seededSession ?? (await adapter.getSession(sessionID, seededDirectory))
    const sessionDirectory = extractSessionDirectory(session) ?? seededDirectory
    const node: SessionTreeNode = {
      sessionID,
      title: extractTitle(session),
      parentSessionID: extractParentSessionID(session),
      status: this.state.statusForSession(sessionID, extractStatus(session)),
      children: [],
    }

    if (depth <= 0) {
      return node
    }

    const children = await adapter.getSessionChildren(sessionID, sessionDirectory)
    for (const child of children) {
      const childID = extractSessionID(child)
      if (!childID) {
        continue
      }

      node.children.push(
        await this.buildTree(adapter, childID, depth - 1, child, extractSessionDirectory(child) ?? sessionDirectory),
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
