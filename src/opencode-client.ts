import { extractDirectory, extractSessionID } from "./session-extractors.js"

type MaybeData<T> = T | { data: T }

type UnknownRecord = Record<string, unknown>
type QueryInput = Record<string, unknown> & { query?: Record<string, unknown> }

export class GlobalSessionDiscoveryError extends Error {
  constructor(message = "Global session discovery is unavailable") {
    super(message)
    this.name = "GlobalSessionDiscoveryError"
  }
}

const unwrap = <T>(value: MaybeData<T>): T => {
  if (value && typeof value === "object" && "data" in value) {
    return (value as { data: T }).data
  }

  return value as T
}

export class OpenCodeAdapter {
  constructor(private readonly client: any) {}

  supportsChildSessionLaunch() {
    return Boolean(this.client?.session?.create)
  }

  supportsAsyncPrompt() {
    return Boolean(this.client?.session?.promptAsync)
  }

  supportsResultRelay() {
    return Boolean(this.client?.session?.prompt)
  }

  supportsAbortSession() {
    return Boolean(this.client?.session?.abort)
  }

  supportsPermissionReply() {
    return Boolean(this.client?.permission?.reply)
  }

  supportsQuestionReply() {
    return Boolean(this.client?.question?.reply)
  }

  supportsQuestionReject() {
    return Boolean(this.client?.question?.reject)
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

  async resolveSession(sessionID: string) {
    let scopedError: unknown = undefined

    try {
      const session = await this.getSession(sessionID)
      return {
        session,
        directory: typeof session?.directory === "string" ? session.directory : undefined,
      }
    } catch (error) {
      scopedError = error
    }

    const sessions = await this.listSessions({ global: true })
    const matched = sessions.find((session: any) => extractSessionID(session) === sessionID)
    if (!matched) {
      throw scopedError instanceof Error ? scopedError : new Error(`Session '${sessionID}' was not found`)
    }

    const directory = extractDirectory(matched) ?? ""
    const session = await this.getSession(sessionID, directory)

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
    if (!this.client?.permission?.list) {
      throw new Error("OpenCode client does not expose permission.list")
    }

    return unwrap(await this.client.permission.list(typeof directory === "string" ? { directory } : undefined)) as any[]
  }

  async replyPermissionRequest(
    requestID: string,
    reply: "once" | "always" | "reject",
    message?: string,
    directory?: string,
  ) {
    if (!this.client?.permission?.reply) {
      throw new Error("OpenCode client does not expose permission.reply")
    }

    return unwrap(
      await this.client.permission.reply({
        requestID,
        reply,
        message,
        ...(typeof directory === "string" ? { directory } : {}),
      }),
    )
  }

  async listPendingQuestions(directory?: string) {
    if (!this.client?.question?.list) {
      throw new Error("OpenCode client does not expose question.list")
    }

    return unwrap(await this.client.question.list(typeof directory === "string" ? { directory } : undefined)) as any[]
  }

  async replyQuestionRequest(requestID: string, answers: string[][], directory?: string) {
    if (!this.client?.question?.reply) {
      throw new Error("OpenCode client does not expose question.reply")
    }

    return unwrap(
      await this.client.question.reply({
        requestID,
        answers,
        ...(typeof directory === "string" ? { directory } : {}),
      }),
    )
  }

  async rejectQuestionRequest(requestID: string, directory?: string) {
    if (!this.client?.question?.reject) {
      throw new Error("OpenCode client does not expose question.reject")
    }

    return unwrap(
      await this.client.question.reject({
        requestID,
        ...(typeof directory === "string" ? { directory } : {}),
      }),
    )
  }

  async promptNoReply(sessionID: string, text: string, directory?: string) {
    return unwrap(
      await this.client.session.prompt({
        ...(this.withDirectoryQuery({ path: { id: sessionID } }, directory) as Record<string, unknown>),
        body: {
          noReply: true,
          parts: [{ type: "text", text }],
        },
      }),
    )
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
}
