import { extractDirectory, extractSessionID, extractWorkspaceID } from "../session-extractors.js"

type UnknownRecord = Record<string, unknown>

export class GlobalSessionDiscoveryError extends Error {
  constructor(message = "Global session discovery is unavailable") {
    super(message)
    this.name = "GlobalSessionDiscoveryError"
  }
}

type DebugFn = (message: string, extra?: UnknownRecord) => Promise<void>

type SessionLookupDeps = {
  getSession: (sessionID: string, directory?: string, workspaceID?: string) => Promise<any>
  listSessions: (options?: { global?: boolean; directory?: string; workspaceID?: string }) => Promise<any[]>
  debug: DebugFn
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
      workspaceID: extractWorkspaceID(session),
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
  const workspaceID = extractWorkspaceID(matched)
  const session = await deps.getSession(sessionID, directory, workspaceID)
  await deps.debug("resolveSession recovered session from global listing", {
    sessionId: sessionID,
    directory,
    workspaceID,
  })

  return {
    session,
    directory,
    workspaceID,
  }
}
