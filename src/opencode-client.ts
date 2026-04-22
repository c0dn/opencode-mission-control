import { createHash } from "node:crypto"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path"

import { extractDirectory, extractSessionID, extractSessionTimestamp } from "./session-extractors.js"

import type { MissionControlConfig, ToolCallerContext } from "./types.js"

type MaybeData<T> = T | { data: T }

type UnknownRecord = Record<string, unknown>
type QueryInput = Record<string, unknown> & { query?: Record<string, unknown> }
type RawOpenCodeClient = {
  request: <TData = unknown>(options: {
    method: string
    url: string
    query?: Record<string, unknown>
    body?: unknown
    signal?: AbortSignal
    responseStyle?: "data" | "fields"
    throwOnError?: boolean
    parseAs?: "arrayBuffer" | "auto" | "blob" | "formData" | "json" | "stream" | "text"
  }) => Promise<TData>
}

export class GlobalSessionDiscoveryError extends Error {
  constructor(message = "Global session discovery is unavailable") {
    super(message)
    this.name = "GlobalSessionDiscoveryError"
  }
}

type OpenCodeAdapterOptions = {
  rootDir?: string
  debug?: MissionControlConfig["debug"]
}

const unwrap = <T>(value: MaybeData<T>): T => {
  if (value && typeof value === "object" && "data" in value) {
    return (value as { data: T }).data
  }

  return value as T
}

export class OpenCodeAdapter {
  private debugFileWriteFailed = false

  constructor(
    private readonly client: any,
    private readonly options: OpenCodeAdapterOptions = {},
  ) {}

  supportsChildSessionLaunch() {
    return Boolean(this.client?.session?.create)
  }

  supportsAsyncPrompt() {
    return Boolean(this.client?.session?.promptAsync)
  }

  supportsResultRelay() {
    return Boolean(this.client?.session?.promptAsync || this.client?.session?.prompt)
  }

  supportsAbortSession() {
    return Boolean(this.client?.session?.abort)
  }

  supportsPermissionReply() {
    return Boolean(this.client?.permission?.reply || this.getRawClient())
  }

  supportsQuestionReply() {
    return Boolean(this.client?.question?.reply || this.getRawClient())
  }

  supportsQuestionReject() {
    return Boolean(this.client?.question?.reject || this.getRawClient())
  }

  supportsParentReplies() {
    return Boolean(this.supportsPermissionReply() && this.supportsQuestionReply() && this.supportsQuestionReject())
  }

  private withDirectoryQuery<T extends QueryInput>(input: T, directory?: string): T {
    if (typeof directory !== "string") {
      return input
    }

    return {
      ...input,
      query: {
        ...(input.query ?? {}),
        directory,
      },
    }
  }

  async log(level: "debug" | "info" | "warn" | "error", message: string, extra?: UnknownRecord) {
    await this.writeDebugEntry(level, message, extra)

    if (this.client?.app?.log) {
      await this.client.app.log({
        body: {
          service: "opencode-mission-control",
          level,
          message,
          extra,
        },
      })
    }
  }

  async debug(message: string, extra?: UnknownRecord) {
    await this.writeDebugEntry("debug", message, extra)
  }

  async getCurrentProject() {
    if (!this.client?.project?.current) {
      return undefined
    }

    return unwrap(await this.client.project.current())
  }

  async getSession(sessionID: string, directory?: string) {
    return unwrap(await this.client.session.get(this.withDirectoryQuery({ path: { id: sessionID } }, directory)))
  }

  async listSessions(options: { global?: boolean; directory?: string } = {}) {
    try {
      return unwrap(
        await this.client.session.list(
          options.global
            ? { query: { directory: "" } }
            : typeof options.directory === "string"
              ? { query: { directory: options.directory } }
              : undefined,
        ),
      ) as any[]
    } catch (error) {
      await this.debug("listSessions failed", {
        global: Boolean(options.global),
        directory: options.directory,
        error: error instanceof Error ? error.message : String(error),
      })

      if (options.global) {
        throw new GlobalSessionDiscoveryError(error instanceof Error ? error.message : undefined)
      }

      throw error
    }
  }

  async getSessionChildren(sessionID: string, directory?: string) {
    return unwrap(
      await this.client.session.children(this.withDirectoryQuery({ path: { id: sessionID } }, directory)),
    ) as any[]
  }

  async getSessionMessages(sessionID: string, directory?: string) {
    return unwrap(
      await this.client.session.messages(this.withDirectoryQuery({ path: { id: sessionID } }, directory)),
    ) as any[]
  }

  async sessionContainsMessage(sessionID: string, messageID: string, directory?: string) {
    const messages = await this.getSessionMessages(sessionID, directory)
    return messages.some((message: any) => message?.info?.id === messageID)
  }

  async findSessionOwningMessage(messageID: string, options: { directory?: string; global?: boolean } = {}) {
    const sessions = await this.listSessions(
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
        if (await this.sessionContainsMessage(sessionID, messageID, directory)) {
          await this.debug("findSessionOwningMessage matched session", {
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
        await this.debug("findSessionOwningMessage session scan failed", {
          messageId: messageID,
          sessionId: sessionID,
          directory,
          error: error instanceof Error ? error.message : String(error),
        })

        continue
      }
    }

    return undefined
  }

  async resolveCallerSession(caller: ToolCallerContext) {
    const callerSessionID = caller.sessionId?.trim()
    const callerMessageID = caller.messageId?.trim()
    const scopeDirectory = caller.directory ?? caller.worktree

    if (callerSessionID) {
      try {
        const resolved = await this.resolveSession(callerSessionID)
        const resolvedCaller = {
          sessionID: callerSessionID,
          directory: resolved.directory ?? scopeDirectory,
        }

        if (!callerMessageID) {
          await this.debug("resolveCallerSession used caller session without message verification", {
            sessionId: callerSessionID,
            directory: resolvedCaller.directory,
          })

          return {
            ...resolvedCaller,
            mode: "current_session" as const,
          }
        }

        if (await this.sessionContainsMessage(callerSessionID, callerMessageID, resolvedCaller.directory)) {
          await this.debug("resolveCallerSession verified caller message in caller session", {
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
        const matched = await this.findSessionOwningMessage(callerMessageID, { directory: scopeDirectory })
        if (matched) {
          await this.debug("resolveCallerSession recovered caller session from message owner", {
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
      await this.debug("resolveCallerSession could not prove caller message ownership", {
        requestedSessionId: callerSessionID,
        messageId: callerMessageID,
        directory: scopeDirectory,
      })
    }

    return undefined
  }

  async resolveSession(sessionID: string) {
    let scopedError: unknown = undefined

    try {
      const session = await this.getSession(sessionID)
      await this.debug("resolveSession resolved scoped session", {
        sessionId: sessionID,
        directory: typeof session?.directory === "string" ? session.directory : undefined,
      })

      return {
        session,
        directory: typeof session?.directory === "string" ? session.directory : undefined,
      }
    } catch (error) {
      await this.debug("resolveSession scoped lookup failed", {
        sessionId: sessionID,
        error: error instanceof Error ? error.message : String(error),
      })

      scopedError = error
    }

    const sessions = await this.listSessions({ global: true })
    const matched = sessions.find((session: any) => extractSessionID(session) === sessionID)
    if (!matched) {
      await this.debug("resolveSession global lookup did not find session", {
        sessionId: sessionID,
      })

      throw scopedError instanceof Error ? scopedError : new Error(`Session '${sessionID}' was not found`)
    }

    const directory = extractDirectory(matched) ?? ""
    const session = await this.getSession(sessionID, directory)
    await this.debug("resolveSession recovered session from global listing", {
      sessionId: sessionID,
      directory,
    })

    return {
      session,
      directory,
    }
  }

  async createChildSession(parentSessionID: string, title?: string, directory?: string) {
    return unwrap(
      await this.client.session.create({
        ...(typeof directory === "string" ? { query: { directory } } : {}),
        body: {
          parentID: parentSessionID,
          title,
        },
      }),
    )
  }

  async abortSession(sessionID: string, directory?: string) {
    return unwrap(await this.client.session.abort(this.withDirectoryQuery({ path: { id: sessionID } }, directory)))
  }

  async listPendingPermissions(directory?: string) {
    if (this.client?.permission?.list) {
      return unwrap(await this.client.permission.list(typeof directory === "string" ? { directory } : undefined)) as any[]
    }

    await this.debug("listPendingPermissions using raw-client fallback", {
      directory,
    })

    return this.rawRequest<any[]>("GET", "/permission", {
      query: this.directoryQuery(directory),
    })
  }

  async replyPermissionRequest(
    requestID: string,
    reply: "once" | "always" | "reject",
    message?: string,
    directory?: string,
  ) {
    if (this.client?.permission?.reply) {
      return unwrap(
        await this.client.permission.reply({
          requestID,
          reply,
          message,
          ...(typeof directory === "string" ? { directory } : {}),
        }),
      )
    }

    await this.debug("replyPermissionRequest using raw-client fallback", {
      requestId: requestID,
      directory,
    })

    return this.rawRequest<boolean>("POST", `/permission/${encodeURIComponent(requestID)}/reply`, {
      query: this.directoryQuery(directory),
      body: {
        reply,
        ...(message !== undefined ? { message } : {}),
      },
    })
  }

  async listPendingQuestions(directory?: string) {
    if (this.client?.question?.list) {
      return unwrap(await this.client.question.list(typeof directory === "string" ? { directory } : undefined)) as any[]
    }

    await this.debug("listPendingQuestions using raw-client fallback", {
      directory,
    })

    return this.rawRequest<any[]>("GET", "/question", {
      query: this.directoryQuery(directory),
    })
  }

  async replyQuestionRequest(requestID: string, answers: string[][], directory?: string) {
    if (this.client?.question?.reply) {
      return unwrap(
        await this.client.question.reply({
          requestID,
          answers,
          ...(typeof directory === "string" ? { directory } : {}),
        }),
      )
    }

    await this.debug("replyQuestionRequest using raw-client fallback", {
      requestId: requestID,
      directory,
    })

    return this.rawRequest<boolean>("POST", `/question/${encodeURIComponent(requestID)}/reply`, {
      query: this.directoryQuery(directory),
      body: {
        answers,
      },
    })
  }

  async rejectQuestionRequest(requestID: string, directory?: string) {
    if (this.client?.question?.reject) {
      return unwrap(
        await this.client.question.reject({
          requestID,
          ...(typeof directory === "string" ? { directory } : {}),
        }),
      )
    }

    await this.debug("rejectQuestionRequest using raw-client fallback", {
      requestId: requestID,
      directory,
    })

    return this.rawRequest<boolean>("POST", `/question/${encodeURIComponent(requestID)}/reject`, {
      query: this.directoryQuery(directory),
    })
  }

  async promptNoReply(sessionID: string, text: string, directory?: string) {
    if (this.client?.session?.prompt) {
      try {
        return unwrap(
          await this.client.session.prompt({
            ...(this.withDirectoryQuery({ path: { id: sessionID } }, directory) as Record<string, unknown>),
            body: {
              noReply: true,
              parts: [{ type: "text", text }],
            },
          }),
        )
      } catch (error) {
        if (isNoReplyParseError(error)) {
          await this.debug("promptNoReply swallowed known no-reply parse error", {
            sessionId: sessionID,
            directory,
            error: error instanceof Error ? error.message : String(error),
          })

          return undefined
        }

        await this.debug("promptNoReply prompt failed", {
          sessionId: sessionID,
          directory,
          error: error instanceof Error ? error.message : String(error),
        })

        throw error
      }
    }

    try {
      return unwrap(
        await this.client.session.promptAsync({
          ...(this.withDirectoryQuery({ path: { id: sessionID } }, directory) as Record<string, unknown>),
          body: {
            noReply: true,
            parts: [{ type: "text", text }],
          },
        }),
      )
    } catch (error) {
      if (isNoReplyParseError(error)) {
        await this.debug("promptNoReply swallowed known no-reply parse error", {
          sessionId: sessionID,
          directory,
          error: error instanceof Error ? error.message : String(error),
        })

        return undefined
      }

      await this.debug("promptNoReply promptAsync failed", {
        sessionId: sessionID,
        directory,
        error: error instanceof Error ? error.message : String(error),
      })

      throw error
    }
  }

  async promptAsync(sessionID: string, text: string, directory?: string) {
    return unwrap(
      await this.client.session.promptAsync({
        ...(this.withDirectoryQuery({ path: { id: sessionID } }, directory) as Record<string, unknown>),
        body: {
          parts: [{ type: "text", text }],
        },
      }),
      )
  }

  private directoryQuery(directory?: string) {
    return typeof directory === "string" ? { directory } : undefined
  }

  private getRawClient(): RawOpenCodeClient | undefined {
    const raw = (this.client as { _client?: RawOpenCodeClient } | undefined)?._client
    return typeof raw?.request === "function" ? raw : undefined
  }

  private async rawRequest<TData = unknown>(
    method: string,
    url: string,
    options: {
      query?: Record<string, unknown>
      body?: unknown
    } = {},
  ) {
    const raw = this.getRawClient()
    if (!raw) {
      throw new Error("OpenCode client does not expose the underlying request client")
    }

    try {
      return await raw.request<TData>({
        method,
        url,
        query: options.query,
        body: options.body,
        responseStyle: "data",
        throwOnError: true,
        parseAs: "auto",
      })
    } catch (error) {
      const normalizedMessage = extractRawRequestErrorMessage(error)
      if (error instanceof Error && normalizedMessage === error.message) {
        throw error
      }

      throw new Error(normalizedMessage)
    }
  }

  private async writeDebugEntry(level: "debug" | "info" | "warn" | "error", message: string, extra?: UnknownRecord) {
    if (!this.options.debug?.enabled || this.debugFileWriteFailed) {
      return
    }

    try {
      const filePath = resolveDebugFilePath(this.options.rootDir, this.options.debug.filePath)
      await mkdir(dirname(filePath), { recursive: true })
      await appendFile(
        filePath,
        `${JSON.stringify({
          at: new Date().toISOString(),
          service: "opencode-mission-control",
          level,
          message,
          extra,
        })}\n`,
        "utf8",
      )
    } catch (error) {
      this.debugFileWriteFailed = true

      if (this.client?.app?.log) {
        try {
          await this.client.app.log({
            body: {
              service: "opencode-mission-control",
              level: "warn",
              message: "Mission Control debug-file logging failed; disabling the file sink until restart.",
              extra: {
                configuredFilePath: this.options.debug?.filePath,
                error: error instanceof Error ? error.message : String(error),
              },
            },
          })
        } catch {
          // Never let debug logging break plugin behavior.
        }
      }
    }
  }
}

const sessionUpdatedAt = (session: any) =>
  extractSessionTimestamp(session, "updated") ?? extractSessionTimestamp(session, "created") ?? 0

const extractRawRequestErrorMessage = (error: unknown) => {
  if (typeof error === "object" && error !== null) {
    const objectError = error as {
      message?: unknown
      data?: {
        message?: unknown
      }
    }

    if (typeof objectError.data?.message === "string") {
      return objectError.data.message
    }

    if (typeof objectError.message === "string") {
      return objectError.message
    }
  }

  return String(error)
}

const isNoReplyParseError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false
  }

  return error.message.includes("Unexpected EOF") || error.message.includes("Unexpected end of JSON input")
}

const resolveDebugFilePath = (rootDir: string | undefined, configuredPath: string | undefined) => {
  const trimmed = configuredPath?.trim()
  if (trimmed) {
    if (trimmed.startsWith("~/")) {
      return join(process.env.HOME?.trim() || homedir(), trimmed.slice(2))
    }

    return isAbsolute(trimmed) ? trimmed : resolvePath(getMissionControlCacheRoot(rootDir || "."), trimmed)
  }

  return join(getMissionControlCacheRoot(rootDir || "."), "debug.jsonl")
}

const getMissionControlCacheRoot = (rootDir: string) => {
  const xdgCache = process.env.XDG_CACHE_HOME?.trim()
  const home = process.env.HOME?.trim() || homedir()
  const baseDir = xdgCache || (home ? join(home, ".cache") : tmpdir())
  return join(baseDir, "opencode-mission-control", scopeKey(rootDir))
}

const scopeKey = (rootDir: string) => createHash("sha1").update(rootDir || "default").digest("hex").slice(0, 16)
