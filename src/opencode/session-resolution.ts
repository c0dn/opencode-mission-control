import { extractDirectory, extractSessionID, extractSessionTimestamp } from "../session-extractors.js"

import type { ToolCallerContext } from "../types.js"
import type { UnknownRecord } from "./raw-client.js"

export class GlobalSessionDiscoveryError extends Error {
  constructor(message = "Global session discovery is unavailable") {
    super(message)
    this.name = "GlobalSessionDiscoveryError"
  }
}

type DebugFn = (message: string, extra?: UnknownRecord) => Promise<void>

type SessionLookupDeps = {
  getSession: (sessionID: string, directory?: string) => Promise<any>
  listSessions: (options?: { global?: boolean; directory?: string }) => Promise<any[]>
  sessionContainsMessage: (sessionID: string, messageID: string, directory?: string) => Promise<boolean>
  debug: DebugFn
}

type CallerResolutionDeps = {
  resolveSession: (sessionID: string) => Promise<{ session: any; directory?: string }>
  findSessionOwningMessage: (
    messageID: string,
    options?: { directory?: string; global?: boolean },
  ) => Promise<{ session: any; sessionID: string; directory?: string } | undefined>
  sessionContainsMessage: (sessionID: string, messageID: string, directory?: string) => Promise<boolean>
  debug: DebugFn
}

export const findSessionOwningMessage = async (
  deps: SessionLookupDeps,
  messageID: string,
  options: { directory?: string; global?: boolean } = {},
) => {
  const sessions = await deps.listSessions(
    options.global ? { global: true } : typeof options.directory === "string" ? { directory: options.directory } : {},
  )

  const ordered = [...sessions].sort((left, right) => sessionUpdatedAt(right) - sessionUpdatedAt(left))
  for (const session of ordered) {
    const sessionID = extractSessionID(session)
    if (!sessionID) {
      continue
    }

    const directory = extractDirectory(session) ?? options.directory
    try {
      if (await deps.sessionContainsMessage(sessionID, messageID, directory)) {
        await deps.debug("findSessionOwningMessage matched session", {
          messageId: messageID,
          sessionId: sessionID,
          directory,
        })

        return {
          session,
          sessionID,
          directory,
        }
      }
    } catch (error) {
      await deps.debug("findSessionOwningMessage session scan failed", {
        messageId: messageID,
        sessionId: sessionID,
        directory,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return undefined
}

export const resolveSession = async (deps: Pick<SessionLookupDeps, "getSession" | "listSessions" | "debug">, sessionID: string) => {
  let scopedError: unknown = undefined

  try {
    const session = await deps.getSession(sessionID)
    await deps.debug("resolveSession resolved scoped session", {
      sessionId: sessionID,
      directory: typeof session?.directory === "string" ? session.directory : undefined,
    })

    return {
      session,
      directory: typeof session?.directory === "string" ? session.directory : undefined,
    }
  } catch (error) {
    await deps.debug("resolveSession scoped lookup failed", {
      sessionId: sessionID,
      error: error instanceof Error ? error.message : String(error),
    })

    scopedError = error
  }

  const sessions = await deps.listSessions({ global: true })
  const matched = sessions.find((session: any) => extractSessionID(session) === sessionID)
  if (!matched) {
    await deps.debug("resolveSession global lookup did not find session", {
      sessionId: sessionID,
    })

    throw scopedError instanceof Error ? scopedError : new Error(`Session '${sessionID}' was not found`)
  }

  const directory = extractDirectory(matched) ?? ""
  const session = await deps.getSession(sessionID, directory)
  await deps.debug("resolveSession recovered session from global listing", {
    sessionId: sessionID,
    directory,
  })

  return {
    session,
    directory,
  }
}

export const resolveCallerSession = async (deps: CallerResolutionDeps, caller: ToolCallerContext) => {
  const callerSessionID = caller.sessionId?.trim()
  const callerMessageID = caller.messageId?.trim()
  const scopeDirectory = caller.directory ?? caller.worktree

  if (callerSessionID) {
    try {
      const resolved = await deps.resolveSession(callerSessionID)
      const resolvedCaller = {
        sessionID: callerSessionID,
        directory: resolved.directory ?? scopeDirectory,
      }

      if (!callerMessageID) {
        await deps.debug("resolveCallerSession used caller session without message verification", {
          sessionId: callerSessionID,
          directory: resolvedCaller.directory,
        })

        return {
          ...resolvedCaller,
          mode: "current_session" as const,
        }
      }

      if (await deps.sessionContainsMessage(callerSessionID, callerMessageID, resolvedCaller.directory)) {
        await deps.debug("resolveCallerSession verified caller message in caller session", {
          sessionId: callerSessionID,
          messageId: callerMessageID,
          directory: resolvedCaller.directory,
        })

        return {
          ...resolvedCaller,
          mode: "current_session" as const,
        }
      }
    } catch {
      // Fall through to message-owner recovery.
    }
  }

  if (callerMessageID) {
    try {
      const matched = await deps.findSessionOwningMessage(callerMessageID, { directory: scopeDirectory })
      if (matched) {
        await deps.debug("resolveCallerSession recovered caller session from message owner", {
          requestedSessionId: callerSessionID,
          recoveredSessionId: matched.sessionID,
          messageId: callerMessageID,
          directory: matched.directory,
        })

        return {
          sessionID: matched.sessionID,
          directory: matched.directory,
          mode: "message_owner_session" as const,
        }
      }
    } catch {
      // Best-effort caller recovery only.
    }
  }

  if (callerMessageID) {
    await deps.debug("resolveCallerSession could not prove caller message ownership", {
      requestedSessionId: callerSessionID,
      messageId: callerMessageID,
      directory: scopeDirectory,
    })
  }

  return undefined
}

const sessionUpdatedAt = (session: any) =>
  extractSessionTimestamp(session, "updated") ?? extractSessionTimestamp(session, "created") ?? 0
