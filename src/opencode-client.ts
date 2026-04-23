import { DebugLogWriter, type OpenCodeAdapterOptions } from "./opencode/debug-log.js"
import {
  directoryQuery,
  getRawClient,
  isNoReplyParseError,
  rawRequest,
  unwrap,
  withDirectoryQuery,
  type UnknownRecord,
} from "./opencode/raw-client.js"
import {
  GlobalSessionDiscoveryError,
  findSessionOwningMessage,
  resolveCallerSession,
  resolveSession,
} from "./opencode/session-resolution.js"

import type { ToolCallerContext } from "./types.js"

export { GlobalSessionDiscoveryError } from "./opencode/session-resolution.js"

export class OpenCodeAdapter {
  private readonly debugLogWriter: DebugLogWriter

  constructor(
    private readonly client: any,
    private readonly options: OpenCodeAdapterOptions = {},
  ) {
    this.debugLogWriter = new DebugLogWriter(client, options)
  }

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
    return Boolean(this.client?.permission?.reply || getRawClient(this.client))
  }

  supportsQuestionReply() {
    return Boolean(this.client?.question?.reply || getRawClient(this.client))
  }

  supportsQuestionReject() {
    return Boolean(this.client?.question?.reject || getRawClient(this.client))
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
    if (!this.client?.project?.current) {
      return undefined
    }

    return unwrap(await this.client.project.current())
  }

  async getSession(sessionID: string, directory?: string) {
    return unwrap(await this.client.session.get(withDirectoryQuery({ path: { id: sessionID } }, directory)))
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
    return unwrap(await this.client.session.children(withDirectoryQuery({ path: { id: sessionID } }, directory))) as any[]
  }

  async getSessionMessages(sessionID: string, directory?: string) {
    return unwrap(await this.client.session.messages(withDirectoryQuery({ path: { id: sessionID } }, directory))) as any[]
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
    return unwrap(await this.client.session.abort(withDirectoryQuery({ path: { id: sessionID } }, directory)))
  }

  async listPendingPermissions(directory?: string) {
    if (this.client?.permission?.list) {
      return unwrap(await this.client.permission.list(typeof directory === "string" ? { directory } : undefined)) as any[]
    }

    await this.debug("listPendingPermissions using raw-client fallback", { directory })
    return rawRequest<any[]>(this.client, "GET", "/permission", { query: directoryQuery(directory) })
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

    return rawRequest<boolean>(this.client, "POST", `/permission/${encodeURIComponent(requestID)}/reply`, {
      query: directoryQuery(directory),
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

    await this.debug("listPendingQuestions using raw-client fallback", { directory })
    return rawRequest<any[]>(this.client, "GET", "/question", { query: directoryQuery(directory) })
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

    return rawRequest<boolean>(this.client, "POST", `/question/${encodeURIComponent(requestID)}/reply`, {
      query: directoryQuery(directory),
      body: { answers },
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

    return rawRequest<boolean>(this.client, "POST", `/question/${encodeURIComponent(requestID)}/reject`, {
      query: directoryQuery(directory),
    })
  }

  async promptNoReply(sessionID: string, text: string, directory?: string) {
    const request = {
      ...(withDirectoryQuery({ path: { id: sessionID } }, directory) as Record<string, unknown>),
      body: {
        noReply: true,
        parts: [{ type: "text", text }],
      },
    }

    if (this.client?.session?.prompt) {
      try {
        return unwrap(await this.client.session.prompt(request))
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
      return unwrap(await this.client.session.promptAsync(request))
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
        ...(withDirectoryQuery({ path: { id: sessionID } }, directory) as Record<string, unknown>),
        body: {
          parts: [{ type: "text", text }],
        },
      }),
    )
  }

  private async writeDebugEntry(level: "debug" | "info" | "warn" | "error", message: string, extra?: UnknownRecord) {
    await this.debugLogWriter.write(level, message, extra)
  }
}
