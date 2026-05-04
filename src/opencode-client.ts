import { createOpencodeClient as createV2OpencodeClient } from "@opencode-ai/sdk/v2"

import { DebugLogWriter, type OpenCodeAdapterOptions } from "./opencode/debug-log.js"
import {
  GlobalSessionDiscoveryError,
  findSessionOwningMessage,
  resolveCallerSession,
  resolveSession,
} from "./opencode/session-resolution.js"

import type { ToolCallerContext } from "./types.js"

export { GlobalSessionDiscoveryError } from "./opencode/session-resolution.js"

type UnknownRecord = Record<string, unknown>

export interface SessionMessagePage {
  messages: any[]
  nextCursor?: string
}

export class SessionMessagePagingUnsupportedError extends Error {
  constructor(message = "OpenCode session-message paging is unavailable from the raw client response") {
    super(message)
    this.name = "SessionMessagePagingUnsupportedError"
  }
}

export class OpenCodeAdapter {
  private readonly debugLogWriter: DebugLogWriter
  private readonly publicClient: any

  constructor(
    private readonly client: any,
    private readonly options: OpenCodeAdapterOptions = {},
  ) {
    this.debugLogWriter = new DebugLogWriter(client, options)
    this.publicClient =
      options.sdkClient ??
      (options.serverUrl
        ? createV2OpencodeClient({
            baseUrl: typeof options.serverUrl === "string" ? options.serverUrl : options.serverUrl.toString(),
          })
        : undefined)
  }

  supportsChildSessionLaunch() {
    return Boolean(this.publicClient?.session?.create || this.client?.session?.create)
  }

  supportsAsyncPrompt() {
    return Boolean(this.publicClient?.session?.promptAsync || this.client?.session?.promptAsync)
  }

  supportsResultRelay() {
    return Boolean(
      this.publicClient?.session?.promptAsync ||
        this.publicClient?.session?.prompt ||
        this.client?.session?.promptAsync ||
        this.client?.session?.prompt,
    )
  }

  supportsAbortSession() {
    return Boolean(this.publicClient?.session?.abort || this.client?.session?.abort)
  }

  supportsPermissionReply() {
    return Boolean(this.publicClient?.permission?.reply || this.client?.permission?.reply)
  }

  supportsQuestionReply() {
    return Boolean(this.publicClient?.question?.reply || this.client?.question?.reply)
  }

  supportsQuestionReject() {
    return Boolean(this.publicClient?.question?.reject || this.client?.question?.reject)
  }

  supportsSessionMessagePaging() {
    return Boolean(this.publicClient?.session?.messages)
  }

  supportsParentReplies() {
    return Boolean(this.supportsPermissionReply() && this.supportsQuestionReply() && this.supportsQuestionReject())
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
    if (this.publicClient?.project?.current) {
      return unwrap(await this.publicClient.project.current(this.scopedParams()))
    }

    if (!this.client?.project?.current) {
      return undefined
    }

    return unwrap(await this.client.project.current())
  }

  async getSession(sessionID: string, directory?: string) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (this.publicClient?.session?.get) {
      return unwrap(
        await this.publicClient.session.get(this.scopedParams({ sessionID }, resolvedDirectory), {
          responseStyle: "data",
          throwOnError: true,
        }),
      )
    }

    return unwrap(await this.client.session.get(withDirectoryQuery({ path: { id: sessionID } }, resolvedDirectory)))
  }

  async listSessions(options: { global?: boolean; directory?: string } = {}) {
    try {
      if (this.publicClient?.session?.list) {
        if (options.global) {
          return unwrap(
            await this.publicClient.experimental.session.list({}, { responseStyle: "data", throwOnError: true }),
          ) as any[]
        }

        return unwrap(
          await this.publicClient.session.list(this.scopedParams({}, this.resolveDirectory(options.directory)), {
            responseStyle: "data",
            throwOnError: true,
          }),
        ) as any[]
      }

      return unwrap(
        await this.client.session.list(
          options.global
            ? { query: { directory: "" } }
            : typeof this.resolveDirectory(options.directory) === "string"
              ? { query: { directory: this.resolveDirectory(options.directory) } }
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
    const resolvedDirectory = this.resolveDirectory(directory)

    if (this.publicClient?.session?.children) {
      return unwrap(
        await this.publicClient.session.children(this.scopedParams({ sessionID }, resolvedDirectory), {
          responseStyle: "data",
          throwOnError: true,
        }),
      ) as any[]
    }

    return unwrap(await this.client.session.children(withDirectoryQuery({ path: { id: sessionID } }, resolvedDirectory))) as any[]
  }

  async getSessionMessages(sessionID: string, directory?: string) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (this.publicClient?.session?.messages) {
      return unwrap(
        await this.publicClient.session.messages(this.scopedParams({ sessionID }, resolvedDirectory), {
          responseStyle: "data",
          throwOnError: true,
        }),
      ) as any[]
    }

    return unwrap(await this.client.session.messages(withDirectoryQuery({ path: { id: sessionID } }, resolvedDirectory))) as any[]
  }

  async getSessionMessagePage(
    sessionID: string,
    options: {
      directory?: string
      limit: number
      before?: string
    },
  ): Promise<SessionMessagePage> {
    if (!this.publicClient?.session?.messages) {
      throw new Error("OpenCode client does not expose public session message paging")
    }

    const response = await this.publicClient.session.messages(
      this.scopedParams(
        {
          sessionID,
          limit: options.limit,
          ...(typeof options.before === "string" ? { before: options.before } : {}),
        },
        this.resolveDirectory(options.directory),
      ),
      {
        responseStyle: "fields",
        throwOnError: true,
      },
    )
    const messages = unwrap(response.data) as any[]
    const nextCursor = extractSessionMessagePagingCursor(response.response.headers)

    if (messages.length >= options.limit && !nextCursor) {
      throw new SessionMessagePagingUnsupportedError()
    }

    return {
      messages,
      nextCursor,
    }
  }

  async sessionContainsMessage(sessionID: string, messageID: string, directory?: string) {
    const messages = await this.getSessionMessages(sessionID, directory)
    return messages.some((message: any) => message?.info?.id === messageID)
  }

  async findSessionOwningMessage(messageID: string, options: { directory?: string; global?: boolean } = {}) {
    return findSessionOwningMessage(
      {
        getSession: this.getSession.bind(this),
        listSessions: this.listSessions.bind(this),
        sessionContainsMessage: this.sessionContainsMessage.bind(this),
        debug: this.debug.bind(this),
      },
      messageID,
      options,
    )
  }

  async resolveCallerSession(caller: ToolCallerContext) {
    return resolveCallerSession(
      {
        resolveSession: this.resolveSession.bind(this),
        findSessionOwningMessage: this.findSessionOwningMessage.bind(this),
        sessionContainsMessage: this.sessionContainsMessage.bind(this),
        debug: this.debug.bind(this),
      },
      caller,
    )
  }

  async resolveSession(sessionID: string) {
    return resolveSession(
      {
        getSession: this.getSession.bind(this),
        listSessions: this.listSessions.bind(this),
        debug: this.debug.bind(this),
      },
      sessionID,
    )
  }

  async createChildSession(parentSessionID: string, title?: string, directory?: string) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (this.publicClient?.session?.create) {
      return unwrap(
        await this.publicClient.session.create(
          this.scopedParams({ parentID: parentSessionID, title }, resolvedDirectory),
          {
            responseStyle: "data",
            throwOnError: true,
          },
        ),
      )
    }

    return unwrap(
      await this.client.session.create({
        ...(typeof resolvedDirectory === "string" ? { query: { directory: resolvedDirectory } } : {}),
        body: {
          parentID: parentSessionID,
          title,
        },
      }),
    )
  }

  async abortSession(sessionID: string, directory?: string) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (this.publicClient?.session?.abort) {
      return unwrap(
        await this.publicClient.session.abort(this.scopedParams({ sessionID }, resolvedDirectory), {
          responseStyle: "data",
          throwOnError: true,
        }),
      )
    }

    return unwrap(await this.client.session.abort(withDirectoryQuery({ path: { id: sessionID } }, resolvedDirectory)))
  }

  async listPendingPermissions(directory?: string) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (this.publicClient?.permission?.list) {
      return unwrap(
        await this.publicClient.permission.list(this.scopedParams({}, resolvedDirectory), {
          responseStyle: "data",
          throwOnError: true,
        }),
      ) as any[]
    }

    if (this.client?.permission?.list) {
      return unwrap(await this.client.permission.list(typeof resolvedDirectory === "string" ? { directory: resolvedDirectory } : undefined)) as any[]
    }

    throw new Error("OpenCode client does not expose pending permission listing")
  }

  async replyPermissionRequest(
    requestID: string,
    reply: "once" | "always" | "reject",
    message?: string,
    directory?: string,
  ) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (this.publicClient?.permission?.reply) {
      return unwrap(
        await this.publicClient.permission.reply(
          this.scopedParams(
            {
              requestID,
              reply,
              ...(message !== undefined ? { message } : {}),
            },
            resolvedDirectory,
          ),
          {
            responseStyle: "data",
            throwOnError: true,
          },
        ),
      )
    }

    if (this.client?.permission?.reply) {
      return unwrap(
        await this.client.permission.reply({
          requestID,
          reply,
          message,
          ...(typeof resolvedDirectory === "string" ? { directory: resolvedDirectory } : {}),
        }),
      )
    }

    throw new Error("OpenCode client does not expose permission replies")
  }

  async listPendingQuestions(directory?: string) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (this.publicClient?.question?.list) {
      return unwrap(
        await this.publicClient.question.list(this.scopedParams({}, resolvedDirectory), {
          responseStyle: "data",
          throwOnError: true,
        }),
      ) as any[]
    }

    if (this.client?.question?.list) {
      return unwrap(await this.client.question.list(typeof resolvedDirectory === "string" ? { directory: resolvedDirectory } : undefined)) as any[]
    }

    throw new Error("OpenCode client does not expose pending question listing")
  }

  async replyQuestionRequest(requestID: string, answers: string[][], directory?: string) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (this.publicClient?.question?.reply) {
      return unwrap(
        await this.publicClient.question.reply(
          this.scopedParams({ requestID, answers }, resolvedDirectory),
          {
            responseStyle: "data",
            throwOnError: true,
          },
        ),
      )
    }

    if (this.client?.question?.reply) {
      return unwrap(
        await this.client.question.reply({
          requestID,
          answers,
          ...(typeof resolvedDirectory === "string" ? { directory: resolvedDirectory } : {}),
        }),
      )
    }

    throw new Error("OpenCode client does not expose question replies")
  }

  async rejectQuestionRequest(requestID: string, directory?: string) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (this.publicClient?.question?.reject) {
      return unwrap(
        await this.publicClient.question.reject(this.scopedParams({ requestID }, resolvedDirectory), {
          responseStyle: "data",
          throwOnError: true,
        }),
      )
    }

    if (this.client?.question?.reject) {
      return unwrap(
        await this.client.question.reject({
          requestID,
          ...(typeof resolvedDirectory === "string" ? { directory: resolvedDirectory } : {}),
        }),
      )
    }

    throw new Error("OpenCode client does not expose question rejection")
  }

  async promptNoReply(sessionID: string, text: string, directory?: string) {
    const resolvedDirectory = this.resolveDirectory(directory)
    const request = {
      noReply: true,
      parts: [{ type: "text", text }],
    }

    if (this.publicClient?.session?.prompt) {
      try {
        return unwrap(
          await this.publicClient.session.prompt(this.scopedParams({ sessionID, ...request }, resolvedDirectory), {
            responseStyle: "data",
            throwOnError: true,
          }),
        )
      } catch (error) {
        if (isNoReplyParseError(error)) {
          await this.debug("promptNoReply swallowed known no-reply parse error", {
            sessionId: sessionID,
            directory: resolvedDirectory,
            error: error instanceof Error ? error.message : String(error),
          })

          return undefined
        }

        await this.debug("promptNoReply prompt failed", {
          sessionId: sessionID,
          directory: resolvedDirectory,
          error: error instanceof Error ? error.message : String(error),
        })

        throw error
      }
    }

    const legacyRequest = {
      ...(withDirectoryQuery({ path: { id: sessionID } }, resolvedDirectory) as Record<string, unknown>),
      body: request,
    }

    if (this.client?.session?.prompt) {
      try {
        return unwrap(await this.client.session.prompt(legacyRequest))
      } catch (error) {
        if (isNoReplyParseError(error)) {
          await this.debug("promptNoReply swallowed known no-reply parse error", {
            sessionId: sessionID,
            directory: resolvedDirectory,
            error: error instanceof Error ? error.message : String(error),
          })

          return undefined
        }

        await this.debug("promptNoReply prompt failed", {
          sessionId: sessionID,
          directory: resolvedDirectory,
          error: error instanceof Error ? error.message : String(error),
        })

        throw error
      }
    }

    try {
      return unwrap(await this.client.session.promptAsync(legacyRequest))
    } catch (error) {
      if (isNoReplyParseError(error)) {
        await this.debug("promptNoReply swallowed known no-reply parse error", {
          sessionId: sessionID,
          directory: resolvedDirectory,
          error: error instanceof Error ? error.message : String(error),
        })

        return undefined
      }

      await this.debug("promptNoReply promptAsync failed", {
        sessionId: sessionID,
        directory: resolvedDirectory,
        error: error instanceof Error ? error.message : String(error),
      })

      throw error
    }
  }

  async promptAsync(sessionID: string, text: string, directory?: string) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (this.publicClient?.session?.promptAsync) {
      return unwrap(
        await this.publicClient.session.promptAsync(
          this.scopedParams(
            {
              sessionID,
              parts: [{ type: "text", text }],
            },
            resolvedDirectory,
          ),
          {
            responseStyle: "data",
            throwOnError: true,
          },
        ),
      )
    }

    return unwrap(
      await this.client.session.promptAsync({
        ...(withDirectoryQuery({ path: { id: sessionID } }, resolvedDirectory) as Record<string, unknown>),
        body: {
          parts: [{ type: "text", text }],
        },
      }),
    )
  }

  private async writeDebugEntry(level: "debug" | "info" | "warn" | "error", message: string, extra?: UnknownRecord) {
    await this.debugLogWriter.write(level, message, extra)
  }

  private resolveDirectory(directory?: string) {
    return typeof directory === "string" ? directory : this.options.directory
  }

  private scopedParams<T extends Record<string, unknown>>(input: T = {} as T, directory?: string) {
    const resolvedDirectory = this.resolveDirectory(directory)

    return {
      ...input,
      ...(typeof resolvedDirectory === "string" ? { directory: resolvedDirectory } : {}),
    }
  }
}

const extractSessionMessagePagingCursor = (headers: Headers) => {
  const directCursor = headers.get("x-next-cursor")?.trim()
  if (directCursor) {
    return directCursor
  }

  const linkHeader = headers.get("link")
  if (!linkHeader) {
    return undefined
  }

  for (const entry of linkHeader.split(",")) {
    const linkMatch = entry.match(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/i)
    if (!linkMatch) {
      continue
    }

    const relTokens = linkMatch[2]!
      .split(/\s+/)
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean)
    if (!relTokens.includes("next") && !relTokens.includes("prev")) {
      continue
    }

    try {
      const parsed = new URL(linkMatch[1]!, "https://example.test")
      const before = parsed.searchParams.get("before")?.trim()
      if (before) {
        return before
      }
    } catch {
      continue
    }
  }

  return undefined
}

const unwrap = <T>(value: T | { data: T }): T => {
  if (value && typeof value === "object" && "data" in value) {
    return (value as { data: T }).data
  }

  return value as T
}

const withDirectoryQuery = <T extends Record<string, unknown> & { query?: Record<string, unknown> }>(
  input: T,
  directory?: string,
): T => {
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

const isNoReplyParseError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false
  }

  return error.message.includes("Unexpected EOF") || error.message.includes("Unexpected end of JSON input")
}
