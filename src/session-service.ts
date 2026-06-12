import { GlobalSessionDiscoveryError, OpenCodeAdapter, SessionMessagePagingUnsupportedError } from "./opencode-client.js"
import { MissionControlRuntimeState } from "./runtime-state.js"
import {
  extractTailText,
  extractDirectory,
  hasVisibleTranscriptContent,
  extractParentSessionID,
  extractSessionID,
  extractSessionTimestamp,
  extractStatus,
  extractTitle,
  extractWorkspaceID,
  normalizeMessage,
} from "./session-extractors.js"
import { MissionControlSourceDB, type SourceSessionRecord } from "./source-db.js"
import type {
  SessionFindArgs,
  SessionAbortResult,
  SessionFindResult,
  SessionGetResult,
  SessionMetadata,
  SessionObserveResult,
  SessionReadResult,
  SessionSendResult,
  SessionTailEntry,
  SessionTailResult,
  SessionTranscriptEntry,
  SessionTreeNode,
  ToolResult,
} from "./types.js"
import { fail, ok } from "./types.js"

export class MissionControlSessionService {
  constructor(
    private readonly state: MissionControlRuntimeState,
    private readonly sourceDB = new MissionControlSourceDB(),
  ) {}

  async getSession(adapter: OpenCodeAdapter, sessionId: string): Promise<ToolResult<SessionGetResult>> {
    try {
      const resolved = await adapter.resolveSession(sessionId)
      return ok({
        session: this.normalizeSessionMetadata(sessionId, resolved.session, resolved.directory, resolved.workspaceID),
      })
    } catch {
      await adapter.debug("getSession failed to resolve session", { sessionId })
      return fail("SessionNotFound", `Session '${sessionId}' was not found.`)
    }
  }

  async abortSession(adapter: OpenCodeAdapter, sessionId: string): Promise<ToolResult<SessionAbortResult>> {
    let resolved: Awaited<ReturnType<OpenCodeAdapter["resolveSession"]>>
    try {
      resolved = await adapter.resolveSession(sessionId)
    } catch (error) {
      await adapter.debug("abortSession failed to resolve session", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      return fail("SessionNotFound", `Session '${sessionId}' was not found.`)
    }

    try {
      const result = await adapter.abortSession(sessionId, resolved.directory, resolved.workspaceID)
      const aborted = typeof result === "boolean" ? result : undefined
      return ok({
        sessionId,
        requestAccepted: true,
        ...(aborted !== undefined ? { aborted } : {}),
        result: result ?? null,
        note: "Abort requested through OpenCode. This is most useful for background subagents by subagent session ID; foreground subagents can block the parent tool loop until they return.",
      })
    } catch (error) {
      await adapter.debug("abortSession request failed", {
        sessionId,
        directory: resolved.directory,
        workspaceID: resolved.workspaceID,
        error: error instanceof Error ? error.message : String(error),
      })
      return fail(
        "SessionLookupUnavailable",
        "Session abort request failed.",
        "Retry after the runtime settles, or verify that the target session is still running.",
      )
    }
  }

  async sendMessageAsync(
    adapter: OpenCodeAdapter,
    targetSessionId: string,
    text: string,
    fromSessionId?: string,
  ): Promise<ToolResult<SessionSendResult>> {
    let resolved: Awaited<ReturnType<OpenCodeAdapter["resolveSession"]>>
    try {
      resolved = await adapter.resolveSession(targetSessionId)
    } catch (error) {
      await adapter.debug("sendMessageAsync failed to resolve session", {
        targetSessionId,
        fromSessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      if (error instanceof GlobalSessionDiscoveryError) {
        return fail(
          "GlobalSessionDiscoveryUnavailable",
          "Global session discovery is unavailable from this OpenCode runtime.",
          "Retry from the directory that owns the target session.",
        )
      }
      return fail("SessionNotFound", `Session '${targetSessionId}' was not found.`)
    }

    const parentSessionId = this.getParentSessionId(targetSessionId, resolved.session)
    if (parentSessionId) {
      return rejectChildSessionPrompt(targetSessionId, parentSessionId)
    }

    const envelope = buildInterAgentMessage({ fromSessionId, text })
    const delivery = await adapter.sendSessionMessageAsync(targetSessionId, envelope, {
      directory: resolved.directory,
      workspaceID: resolved.workspaceID,
    })
    if (!delivery.ok) {
      return fail(
        "SessionLookupUnavailable",
        `Failed to deliver message to session '${targetSessionId}'.`,
        "Verify the target session is still running, or retry after the runtime settles.",
      )
    }

    return ok({
      targetSessionId,
      fromSessionId,
      delivery: "async",
      requestAccepted: true,
      note: "Message queued via OpenCode prompt_async; the target session processes it at its next loop boundary, not mid-response.",
    })
  }

  async sendMessageInterrupt(
    adapter: OpenCodeAdapter,
    targetSessionId: string,
    text: string,
    fromSessionId?: string,
  ): Promise<ToolResult<SessionSendResult>> {
    let resolved: Awaited<ReturnType<OpenCodeAdapter["resolveSession"]>>
    try {
      resolved = await adapter.resolveSession(targetSessionId)
    } catch (error) {
      await adapter.debug("sendMessageInterrupt failed to resolve session", {
        targetSessionId,
        fromSessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      if (error instanceof GlobalSessionDiscoveryError) {
        return fail(
          "GlobalSessionDiscoveryUnavailable",
          "Global session discovery is unavailable from this OpenCode runtime.",
          "Retry from the directory that owns the target session.",
        )
      }
      return fail("SessionNotFound", `Session '${targetSessionId}' was not found.`)
    }

    const parentSessionId = this.getParentSessionId(targetSessionId, resolved.session)
    if (parentSessionId) {
      return rejectChildSessionPrompt(targetSessionId, parentSessionId)
    }

    let aborted: boolean | undefined
    try {
      const abortResult = await adapter.abortSession(targetSessionId, resolved.directory, resolved.workspaceID)
      aborted = typeof abortResult === "boolean" ? abortResult : undefined
    } catch (error) {
      await adapter.debug("sendMessageInterrupt abort attempt failed", {
        targetSessionId,
        fromSessionId,
        directory: resolved.directory,
        workspaceID: resolved.workspaceID,
        error: error instanceof Error ? error.message : String(error),
      })
      aborted = undefined
    }

    const envelope = buildInterAgentMessage({ fromSessionId, text })
    const delivery = await adapter.sendSessionMessageAsync(targetSessionId, envelope, {
      directory: resolved.directory,
      workspaceID: resolved.workspaceID,
    })
    if (!delivery.ok) {
      return fail(
        "SessionLookupUnavailable",
        aborted === true
          ? `Failed to deliver message to session '${targetSessionId}'; the target may already have been aborted.`
          : `Failed to deliver message to session '${targetSessionId}'.`,
        "Verify the target session is still running, or retry after the runtime settles.",
      )
    }

    return ok({
      targetSessionId,
      fromSessionId,
      delivery: "interrupt",
      requestAccepted: true,
      ...(aborted !== undefined ? { aborted } : {}),
      note:
        aborted === true
          ? "Target session aborted, then message queued via prompt_async so it is picked up immediately. Aborting interrupts the target's current in-flight response."
          : "Abort was requested (target may not have had an in-flight response); message queued via prompt_async for immediate pickup at the next loop boundary.",
    })
  }

  async findSessions(adapter: OpenCodeAdapter, args: SessionFindArgs): Promise<ToolResult<SessionFindResult>> {
    const scope = args.scope ?? "local"

    try {
      const sessions = await this.sourceDB.listSessions(adapter, { global: scope === "global" })
      const allMatches = this.sourceDB.findSessionsByExactTitle(sessions, args.title)
      const candidates = this.sourceDB
        .findSessionsByExactTitle(allMatches, args.title, { limit: args.limit })
        .map((session) => this.normalizeSourceSessionMetadata(session))

      return ok({
        title: args.title,
        scope,
        candidates,
        ambiguous: allMatches.length > 1,
      })
    } catch (error) {
      if (error instanceof GlobalSessionDiscoveryError) {
        return fail(
          "GlobalSessionDiscoveryUnavailable",
          "Global session discovery is unavailable from this OpenCode runtime.",
          "Retry with scope: 'local', or run Mission Control in the directory that owns the target session.",
        )
      }

      await adapter.debug("findSessions failed to list sessions", {
        title: args.title,
        scope,
        error: error instanceof Error ? error.message : String(error),
      })

      return fail(
        "SessionLookupUnavailable",
        "Session metadata lookup failed.",
        "Retry after the runtime settles, or narrow the lookup scope.",
      )
    }
  }

  async readSession(
    adapter: OpenCodeAdapter,
    sessionId: string,
    options: {
      beforeMessageId?: string
      offset?: number
      limit?: number
      withChildren?: boolean
      withToolOutputs?: boolean
    },
  ): Promise<ToolResult<SessionReadResult>> {
    const relatedSessions = await this.resolveRelatedSessions(adapter, sessionId, Boolean(options.withChildren), {
      action: "readSession",
      includeOffset: options.offset,
      includeLimit: options.limit,
      includeToolOutputs: options.withToolOutputs,
    })
    if (!relatedSessions.ok) {
      return relatedSessions
    }

    if (!options.beforeMessageId && typeof options.limit === "number" && adapter.supportsSessionMessagePaging()) {
      const paged = await this.loadRecentMessageRecordPage(adapter, sessionId, relatedSessions.data, {
        offset: options.offset,
        limit: options.limit,
        isEligible: (record) => hasVisibleTranscriptContent(record.message, options.withToolOutputs ?? false),
      })
      if (paged === undefined) {
        await adapter.debug("readSession falling back to full-history transcript load", {
          sessionId,
          offset: options.offset,
          limit: options.limit,
        })
      } else if (!paged.ok) {
        return paged
      } else {
        const entries = paged.data.entries
          .map(({ sessionID, message }) => normalizeMessage(sessionID, message, options.withToolOutputs ?? false))
          .filter((entry): entry is SessionTranscriptEntry => Boolean(entry))

        return ok({
          sessionId,
          entries,
          includedChildSessionIds: relatedSessions.data.slice(1).map((session) => session.sessionID),
          offset: paged.data.offset,
          hasMore: paged.data.hasMore,
          nextOffset: paged.data.nextOffset,
          totalEntries: paged.data.totalEntries,
          totalEntriesExact: paged.data.totalEntriesExact,
        })
      }
    }

    const messageGroups = await this.loadMessageGroups(adapter, sessionId, relatedSessions.data)
    if (!messageGroups.ok) {
      return messageGroups
    }

    if (!options.beforeMessageId && typeof options.limit === "number") {
      const paged = selectRecentMessageRecords(messageGroups.data, {
        offset: options.offset,
        limit: options.limit,
        isEligible: (record) => hasVisibleTranscriptContent(record.message, options.withToolOutputs ?? false),
      })
      const entries = paged.entries
        .map(({ sessionID, message }) => normalizeMessage(sessionID, message, options.withToolOutputs ?? false))
        .filter((entry): entry is SessionTranscriptEntry => Boolean(entry))

      return ok({
        sessionId,
        entries,
        includedChildSessionIds: relatedSessions.data.slice(1).map((session) => session.sessionID),
        offset: paged.offset,
        hasMore: paged.hasMore,
        nextOffset: paged.nextOffset,
        totalEntries: paged.totalEntries,
        totalEntriesExact: true,
      })
    }

    const messages = flattenMessageGroups(messageGroups.data)

    const scopedMessages = applyBeforeMessageBoundary(messages, options.beforeMessageId)
    const eligibleMessages = scopedMessages.filter(({ message }) =>
      hasVisibleTranscriptContent(message, options.withToolOutputs ?? false),
    )
    const paged = paginateEntries(eligibleMessages, options.offset, options.limit)
    const entries = paged.entries
      .map(({ sessionID, message }) => normalizeMessage(sessionID, message, options.withToolOutputs ?? false))
      .filter((entry): entry is SessionTranscriptEntry => Boolean(entry))

    return ok({
      sessionId,
      entries,
      includedChildSessionIds: relatedSessions.data.slice(1).map((session) => session.sessionID),
      offset: paged.offset,
      hasMore: paged.hasMore,
      nextOffset: paged.nextOffset,
      totalEntries: paged.totalEntries,
      totalEntriesExact: true,
    })
  }

  async tailSession(
    adapter: OpenCodeAdapter,
    sessionId: string,
    options: {
      offset?: number
      limit?: number
      withChildren?: boolean
    },
  ): Promise<ToolResult<SessionTailResult>> {
    const relatedSessions = await this.resolveRelatedSessions(adapter, sessionId, Boolean(options.withChildren), {
      action: "tailSession",
      includeOffset: options.offset,
      includeLimit: options.limit,
    })
    if (!relatedSessions.ok) {
      return relatedSessions
    }

    if (typeof options.limit === "number" && adapter.supportsSessionMessagePaging()) {
      const paged = await this.loadRecentMessageRecordPage(adapter, sessionId, relatedSessions.data, {
        offset: options.offset,
        limit: options.limit,
        isEligible: (record) => Boolean(extractTailText(record.message)),
      })
      if (paged === undefined) {
        await adapter.debug("tailSession falling back to full-history transcript load", {
          sessionId,
          offset: options.offset,
          limit: options.limit,
        })
      } else if (!paged.ok) {
        return paged
      } else {
        const entries = paged.data.entries
          .map((record) => {
            const tailText = extractTailText(record.message)
            return tailText ? toTailEntry({ ...record, tailText }) : undefined
          })
          .filter((entry): entry is SessionTailEntry => Boolean(entry))

        return ok({
          sessionId,
          entries,
          includedChildSessionIds: relatedSessions.data.slice(1).map((session) => session.sessionID),
          offset: paged.data.offset,
          hasMore: paged.data.hasMore,
          nextOffset: paged.data.nextOffset,
          totalEntries: paged.data.totalEntries,
          totalEntriesExact: paged.data.totalEntriesExact,
        })
      }
    }

    const messageGroups = await this.loadMessageGroups(adapter, sessionId, relatedSessions.data)
    if (!messageGroups.ok) {
      return messageGroups
    }

    if (typeof options.limit === "number") {
      const paged = selectRecentMessageRecords(messageGroups.data, {
        offset: options.offset,
        limit: options.limit,
        isEligible: (record) => Boolean(extractTailText(record.message)),
      })
      const entries = paged.entries
        .map((record) => {
          const tailText = extractTailText(record.message)
          return tailText ? toTailEntry({ ...record, tailText }) : undefined
        })
        .filter((entry): entry is SessionTailEntry => Boolean(entry))

      return ok({
        sessionId,
        entries,
        includedChildSessionIds: relatedSessions.data.slice(1).map((session) => session.sessionID),
        offset: paged.offset,
        hasMore: paged.hasMore,
        nextOffset: paged.nextOffset,
        totalEntries: paged.totalEntries,
        totalEntriesExact: true,
      })
    }

    const messages = flattenMessageGroups(messageGroups.data)

    const eligibleMessages = messages
      .map((record: SessionMessageRecord) => ({
        ...record,
        tailText: extractTailText(record.message),
      }))
      .filter((record): record is SessionMessageRecord & { tailText: string } => Boolean(record.tailText))
    const paged = paginateEntries(eligibleMessages, options.offset, options.limit)
    const entries = paged.entries.map((record) => toTailEntry(record))

    return ok({
      sessionId,
      entries,
      includedChildSessionIds: relatedSessions.data.slice(1).map((session) => session.sessionID),
      offset: paged.offset,
      hasMore: paged.hasMore,
      nextOffset: paged.nextOffset,
      totalEntries: paged.totalEntries,
      totalEntriesExact: true,
    })
  }

  private async loadRecentMessageRecordPage(
    adapter: OpenCodeAdapter,
    sessionId: string,
    relatedSessions: Array<{ sessionID: string; directory?: string; workspaceID?: string }>,
    options: {
      offset?: number
      limit: number
      isEligible: (record: SessionMessageRecord) => boolean
    },
  ): Promise<
    | ToolResult<{
        entries: SessionMessageRecord[]
        offset: number
        hasMore: boolean
        nextOffset?: number
        totalEntries: number
        totalEntriesExact: boolean
      }>
    | undefined
  > {
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const limit = Math.max(1, Math.trunc(options.limit))
    const targetCount = offset + limit + 1
    const pageSize = getSessionMessagePageSize(offset, limit)
    const states: PagedSessionState[] = relatedSessions.map((relatedSession, sessionOrder) => ({
      sessionID: relatedSession.sessionID,
      directory: relatedSession.directory,
      workspaceID: relatedSession.workspaceID,
      sessionOrder,
      eligibleRecords: [],
      nextEligibleIndex: 0,
      initialized: false,
      exhausted: false,
      oldestMessageOrder: 0,
    }))

    try {
      await Promise.all(states.map((state) => loadNextPagedSessionChunk(adapter, state, pageSize, options.isEligible)))

      const selectedNewest: SessionMessageRecord[] = []
      while (selectedNewest.length < targetCount) {
        let bestRecord: SessionMessageRecord | undefined
        let bestState: PagedSessionState | undefined

        for (const state of states) {
          const candidate = await ensurePagedSessionCandidate(adapter, state, pageSize, options.isEligible)
          if (!candidate) {
            continue
          }

          if (!bestRecord || compareMessageRecordDescending(candidate, bestRecord) < 0) {
            bestRecord = candidate
            bestState = state
          }
        }

        if (!bestRecord || !bestState) {
          break
        }

        selectedNewest.push(bestRecord)
        bestState.nextEligibleIndex += 1
      }

      const pageNewest = selectedNewest.slice(offset, offset + limit)
      const entries = [...pageNewest].reverse()
      const hasMore = selectedNewest.length > offset + pageNewest.length

      return ok({
        entries,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + pageNewest.length : undefined,
        totalEntries: selectedNewest.length,
        totalEntriesExact: !hasMore,
      })
    } catch (error) {
      if (error instanceof SessionMessagePagingUnsupportedError) {
        return undefined
      }

      const failedSessionID = error instanceof PagedSessionLoadError ? error.sessionID : relatedSessions[0]?.sessionID ?? sessionId
      const failedDirectory = error instanceof PagedSessionLoadError ? error.directory : relatedSessions[0]?.directory

      await adapter.debug("loadRecentMessageRecordPage failed to load session messages", {
        sessionId,
        relatedSessionId: failedSessionID,
        directory: failedDirectory,
      })

      return fail(
        "CurrentSessionUnavailable",
        `Failed to load messages for session '${failedSessionID}'.`,
        "Retry after the session becomes stable, or reduce the request scope.",
      )
    }
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
        await adapter.debug("sessionTree failed while building tree", {
          sessionId,
          depth,
          directory: resolved.directory,
        })

        return fail(
          "CurrentSessionUnavailable",
          `Failed to build the tree for session '${sessionId}'.`,
          "Retry after the runtime settles, or reduce the requested depth.",
        )
      }
    } catch {
      await adapter.debug("sessionTree failed to resolve session", {
        sessionId,
        depth,
      })

      return fail("SessionNotFound", `Session '${sessionId}' was not found.`)
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
      await adapter.debug("observeSession failed to resolve session", {
        sessionId,
        withChildren: Boolean(options.withChildren),
        limit: options.limit,
      })

      return fail("SessionNotFound", `Session '${sessionId}' was not found.`)
    }

    const sessionIDs = new Set<string>([sessionId])
    let childSummaries: SessionObserveResult["children"] = undefined

    if (options.withChildren) {
      try {
        const children = await adapter.getSessionChildren(sessionId, sessionDirectory, extractWorkspaceID(session))
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
        await adapter.debug("observeSession failed to load child sessions", {
          sessionId,
          directory: sessionDirectory,
        })

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

  private normalizeSessionMetadata(sessionId: string, session: unknown, directory?: string, workspaceID?: string): SessionMetadata {
    const cachedMetadata = this.state.metadataForSession(sessionId)

    return {
      sessionId,
      title: extractTitle(session) ?? cachedMetadata?.title ?? "Untitled session",
      directory: extractDirectory(session) ?? cachedMetadata?.directory ?? directory,
      workspaceID: extractWorkspaceID(session) ?? cachedMetadata?.workspaceID ?? workspaceID,
      parentSessionId: extractParentSessionID(session) ?? cachedMetadata?.parentSessionId,
      createdAt: extractSessionTimestamp(session, "created") ?? cachedMetadata?.createdAt,
      updatedAt: extractSessionTimestamp(session, "updated") ?? cachedMetadata?.updatedAt,
      status: this.state.statusForSession(sessionId, extractStatus(session)),
    }
  }

  private normalizeSourceSessionMetadata(session: SourceSessionRecord): SessionMetadata {
    const cachedMetadata = this.state.metadataForSession(session.sessionID)

    return {
      sessionId: session.sessionID,
      title: session.title,
      directory: session.directory || cachedMetadata?.directory || undefined,
      workspaceID: session.workspaceID ?? cachedMetadata?.workspaceID,
      parentSessionId: session.parentSessionID ?? cachedMetadata?.parentSessionId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: this.state.statusForSession(session.sessionID),
    }
  }

  private getParentSessionId(sessionId: string, session: unknown) {
    return extractParentSessionID(session) ?? this.state.metadataForSession(sessionId)?.parentSessionId
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
      workspaceID: extractWorkspaceID(session) ?? cachedMetadata?.workspaceID,
      status: this.state.statusForSession(sessionId, extractStatus(session)),
      children: [],
    }

    if (depth <= 0) {
      return node
    }

    const children = await adapter.getSessionChildren(sessionId, sessionDirectory, extractWorkspaceID(session) ?? cachedMetadata?.workspaceID)
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

  private async resolveRelatedSessions(
    adapter: OpenCodeAdapter,
    sessionId: string,
    withChildren: boolean,
    debugContext: {
      action: "readSession" | "tailSession"
      includeOffset?: number
      includeLimit?: number
      includeToolOutputs?: boolean
    },
  ): Promise<ToolResult<Array<{ sessionID: string; directory?: string; workspaceID?: string }>>> {
    const relatedSessions: Array<{ sessionID: string; directory?: string; workspaceID?: string }> = []

    try {
      const resolved = await adapter.resolveSession(sessionId)
      relatedSessions.push({
        sessionID: sessionId,
        directory: resolved.directory ?? extractDirectory(resolved.session),
        workspaceID: resolved.workspaceID ?? extractWorkspaceID(resolved.session),
      })
    } catch {
      await adapter.debug(`${debugContext.action} failed to resolve session`, {
        sessionId,
        withChildren,
        offset: debugContext.includeOffset,
        limit: debugContext.includeLimit,
        withToolOutputs: debugContext.includeToolOutputs,
      })

      return fail("SessionNotFound", `Session '${sessionId}' was not found.`)
    }

    if (!withChildren) {
      return ok(relatedSessions)
    }

    try {
      const parentDirectory = relatedSessions[0]?.directory
      const children = await adapter.getSessionChildren(sessionId, parentDirectory, relatedSessions[0]?.workspaceID)
      for (const child of children) {
        const childID = extractSessionID(child)
        if (childID) {
          const cachedMetadata = this.state.metadataForSession(childID)
          relatedSessions.push({
            sessionID: childID,
            directory: extractDirectory(child) ?? cachedMetadata?.directory ?? parentDirectory,
            workspaceID: extractWorkspaceID(child) ?? cachedMetadata?.workspaceID ?? relatedSessions[0]?.workspaceID,
          })
        }
      }
    } catch {
      await adapter.debug(`${debugContext.action} failed to load child sessions`, {
        sessionId,
        directory: relatedSessions[0]?.directory,
      })

      return fail(
        "CurrentSessionUnavailable",
        `Failed to load child sessions for '${sessionId}'.`,
        withChildren ? "Retry without withChildren if the runtime is unstable, or retry after the runtime settles." : "Retry after the runtime settles.",
      )
    }

    return ok(relatedSessions)
  }

  private async loadMessageGroups(
    adapter: OpenCodeAdapter,
    sessionId: string,
    relatedSessions: Array<{ sessionID: string; directory?: string; workspaceID?: string }>,
  ): Promise<ToolResult<SessionMessageGroup[]>> {
    const groups: SessionMessageGroup[] = []

    for (const [sessionOrder, relatedSession] of relatedSessions.entries()) {
      try {
        const sessionMessages = await adapter.getSessionMessages(relatedSession.sessionID, relatedSession.directory, relatedSession.workspaceID)
        const records = sessionMessages
          .map((message, messageOrder) => ({
            sessionID: relatedSession.sessionID,
            message,
            createdAt: getMessageCreatedAt(message),
            sessionOrder,
            messageOrder,
          }))
          .sort(compareMessageRecordAscending)

        groups.push({
          sessionID: relatedSession.sessionID,
          records,
        })
      } catch {
        await adapter.debug("loadMessageGroups failed to load session messages", {
          sessionId,
          relatedSessionId: relatedSession.sessionID,
          directory: relatedSession.directory,
        })

        return fail(
          "CurrentSessionUnavailable",
          `Failed to load messages for session '${relatedSession.sessionID}'.`,
          "Retry after the session becomes stable, or reduce the request scope.",
        )
      }
    }

    return ok(groups)
  }

}

const getMessageID = (message: any) => (typeof message?.info?.id === "string" ? message.info.id : undefined)

const escapeXmlText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const escapeXmlAttribute = (value: string) => escapeXmlText(value).replace(/"/g, "&quot;")

const rejectChildSessionPrompt = (targetSessionId: string, parentSessionId: string) =>
  fail(
    "SubagentPromptRejected",
    `Session '${targetSessionId}' is a child/subagent session (parent '${parentSessionId}') and Mission Control refuses to prompt it directly.`,
    `Send the message to parent session '${parentSessionId}' if you intend to steer orchestration, or use mc_session_abort({ sessionId: '${targetSessionId}' }) to stop the child session.`,
  )

const buildInterAgentMessage = ({ fromSessionId, text }: { fromSessionId?: string; text: string }) =>
  `<inter_agent_message from="${escapeXmlAttribute(fromSessionId ?? "unknown")}">\n${escapeXmlText(text)}\n</inter_agent_message>`

interface SessionMessageRecord {
  sessionID: string
  message: any
  createdAt: number
  sessionOrder: number
  messageOrder: number
}

interface SessionMessageGroup {
  sessionID: string
  records: SessionMessageRecord[]
}

interface PagedSessionState {
  sessionID: string
  directory?: string
  workspaceID?: string
  sessionOrder: number
  eligibleRecords: SessionMessageRecord[]
  nextEligibleIndex: number
  nextCursor?: string
  initialized: boolean
  exhausted: boolean
  oldestMessageOrder: number
}

class PagedSessionLoadError extends Error {
  constructor(
    readonly sessionID: string,
    readonly directory?: string,
    cause?: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "PagedSessionLoadError"
  }
}

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

const getSessionMessagePageSize = (offset: number, limit: number) => Math.max(25, Math.min(200, offset + limit + 1))

const ensurePagedSessionCandidate = async (
  adapter: OpenCodeAdapter,
  state: PagedSessionState,
  pageSize: number,
  isEligible: (record: SessionMessageRecord) => boolean,
) => {
  while (true) {
    const candidate = state.eligibleRecords[state.nextEligibleIndex]
    if (candidate) {
      return candidate
    }

    if (state.exhausted) {
      return undefined
    }

    await loadNextPagedSessionChunk(adapter, state, pageSize, isEligible)
  }
}

const loadNextPagedSessionChunk = async (
  adapter: OpenCodeAdapter,
  state: PagedSessionState,
  pageSize: number,
  isEligible: (record: SessionMessageRecord) => boolean,
) => {
  if (state.exhausted) {
    return
  }

  try {
    const page = await adapter.getSessionMessagePage(state.sessionID, {
      directory: state.directory,
      workspaceID: state.workspaceID,
      limit: pageSize,
      cursor: state.nextCursor,
    })
    const messages = Array.isArray(page.messages) ? page.messages : []
    const orderStart = state.initialized ? state.oldestMessageOrder - messages.length : 0
    const records = messages.map((message, index) => ({
      sessionID: state.sessionID,
      message,
      createdAt: getMessageCreatedAt(message),
      sessionOrder: state.sessionOrder,
      messageOrder: orderStart + index,
    }))

    if (messages.length > 0) {
      state.oldestMessageOrder = orderStart
    }
    state.initialized = true
    state.eligibleRecords.push(...records.filter(isEligible).reverse())

    const nextCursor = typeof page.nextCursor === "string" && page.nextCursor.length > 0 ? page.nextCursor : undefined
    const repeatedCursor = nextCursor !== undefined && nextCursor === state.nextCursor
    state.nextCursor = nextCursor
    state.exhausted = messages.length === 0 || !nextCursor || repeatedCursor
  } catch (error) {
    if (error instanceof SessionMessagePagingUnsupportedError) {
      throw error
    }

    throw new PagedSessionLoadError(state.sessionID, state.directory, error)
  }
}

const paginateEntries = <T>(entries: T[], rawOffset?: number, rawLimit?: number) => {
  const totalEntries = entries.length
  const offset = Math.max(0, Math.trunc(rawOffset ?? 0))
  const endIndex = Math.max(0, totalEntries - offset)

  if (rawLimit === undefined) {
    return {
      entries: entries.slice(0, endIndex),
      offset,
      hasMore: false,
      nextOffset: undefined,
      totalEntries,
    }
  }

  const limit = Math.max(1, Math.trunc(rawLimit))
  const startIndex = Math.max(0, endIndex - limit)
  const visibleEntries = entries.slice(startIndex, endIndex)
  const hasMore = startIndex > 0

  return {
    entries: visibleEntries,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + visibleEntries.length : undefined,
    totalEntries,
  }
}

const selectRecentMessageRecords = (
  groups: SessionMessageGroup[],
  options: {
    offset?: number
    limit: number
    isEligible: (record: SessionMessageRecord) => boolean
  },
) => {
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const limit = Math.max(1, Math.trunc(options.limit))
  const totalEntries = groups.reduce(
    (count, group) => count + group.records.reduce((inner, record) => inner + Number(options.isEligible(record)), 0),
    0,
  )

  if (totalEntries === 0 || offset >= totalEntries) {
    return {
      entries: [] as SessionMessageRecord[],
      offset,
      hasMore: false,
      nextOffset: undefined,
      totalEntries,
    }
  }

  const needed = Math.min(totalEntries, offset + limit)
  const cursors = groups
    .map((group, groupIndex) => ({
      groupIndex,
      recordIndex: findPreviousEligibleIndex(group.records, group.records.length - 1, options.isEligible),
    }))
    .filter((cursor) => cursor.recordIndex >= 0)
  const newestSelected: SessionMessageRecord[] = []

  while (cursors.length > 0 && newestSelected.length < needed) {
    let bestCursorIndex = 0
    for (let index = 1; index < cursors.length; index += 1) {
      const current = groups[cursors[index]!.groupIndex]!.records[cursors[index]!.recordIndex]!
      const best = groups[cursors[bestCursorIndex]!.groupIndex]!.records[cursors[bestCursorIndex]!.recordIndex]!
      if (compareMessageRecordDescending(current, best) < 0) {
        bestCursorIndex = index
      }
    }

    const selectedCursor = cursors[bestCursorIndex]!
    newestSelected.push(groups[selectedCursor.groupIndex]!.records[selectedCursor.recordIndex]!)
    selectedCursor.recordIndex = findPreviousEligibleIndex(
      groups[selectedCursor.groupIndex]!.records,
      selectedCursor.recordIndex - 1,
      options.isEligible,
    )
    if (selectedCursor.recordIndex < 0) {
      cursors.splice(bestCursorIndex, 1)
    }
  }

  const pageNewest = newestSelected.slice(offset, offset + limit)
  const entries = [...pageNewest].reverse()
  const hasMore = totalEntries > offset + pageNewest.length

  return {
    entries,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + pageNewest.length : undefined,
    totalEntries,
  }
}

const findPreviousEligibleIndex = (
  records: SessionMessageRecord[],
  startIndex: number,
  isEligible: (record: SessionMessageRecord) => boolean,
) => {
  for (let index = startIndex; index >= 0; index -= 1) {
    if (isEligible(records[index]!)) {
      return index
    }
  }

  return -1
}

const flattenMessageGroups = (groups: SessionMessageGroup[]): SessionMessageRecord[] =>
  groups.flatMap((group) => group.records).sort(compareMessageRecordAscending)

const compareMessageRecordAscending = (left: SessionMessageRecord, right: SessionMessageRecord) => {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt
  }

  if (left.sessionOrder !== right.sessionOrder) {
    return left.sessionOrder - right.sessionOrder
  }

  return left.messageOrder - right.messageOrder
}

const compareMessageRecordDescending = (left: SessionMessageRecord, right: SessionMessageRecord) =>
  compareMessageRecordAscending(right, left)

const toTailEntry = (entry: { sessionID: string; message: any; createdAt: number; tailText: string }): SessionTailEntry => {
  const info = entry.message?.info ?? {}
  return {
    sessionId: entry.sessionID,
    messageId: typeof info.id === "string" ? info.id : `${entry.sessionID}:${entry.createdAt}`,
    role: typeof info.role === "string" ? info.role : "unknown",
    agent: typeof info.agent === "string" ? info.agent : undefined,
    createdAt: entry.createdAt,
    text: entry.tailText,
  }
}

const applyBeforeMessageBoundary = <T extends { message: any }>(messages: T[], beforeMessageId: string | undefined) => {
  const cursorIndex = beforeMessageId
    ? messages.findIndex(({ message }) => getMessageID(message) === beforeMessageId)
    : -1
  return cursorIndex >= 0 ? messages.slice(0, cursorIndex) : messages
}
