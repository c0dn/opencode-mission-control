import { createOpencodeClient as createV2OpencodeClient } from "@opencode-ai/sdk/v2"

import { DebugLogWriter, type OpenCodeAdapterOptions } from "./opencode/debug-log.js"
import { getRawClient, rawRequest, scopeQuery, unwrap, withScopeQuery } from "./opencode/raw-client.js"
import { GlobalSessionDiscoveryError, resolveSession } from "./opencode/session-resolution.js"

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
    const resolvedServerUrl =
      recoverServerUrlFromInternalClient(client) ?? options.serverUrl ?? recoverServerUrlFromInternalClient(options.sdkClient)
    this.publicClient =
      options.sdkClient ??
      (resolvedServerUrl
        ? createV2OpencodeClient({
            baseUrl: typeof resolvedServerUrl === "string" ? resolvedServerUrl : resolvedServerUrl.toString(),
            ...(options.directory ? { directory: options.directory } : {}),
            ...(options.workspaceID ? { experimental_workspaceID: options.workspaceID } : {}),
          })
        : undefined)
  }

  supportsSessionMessagePaging() {
    return Boolean(getRawClient(this.client) || this.publicClient?.session?.messages)
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

  async getSession(sessionID: string, directory?: string, workspaceID = this.options.workspaceID) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (getRawClient(this.client)) {
      return rawRequest(this.client, {
        path: `/session/${encodeURIComponent(sessionID)}`,
        query: scopeQuery(resolvedDirectory, workspaceID),
        throwOnError: true,
      })
    }

    if (this.publicClient?.session?.get) {
      return unwrap(
        await this.publicClient.session.get(this.scopedParams({ sessionID }, resolvedDirectory, workspaceID), {
          responseStyle: "data",
          throwOnError: true,
        }),
      )
    }

    return unwrap(await this.client.session.get(withScopeQuery({ path: { id: sessionID } }, resolvedDirectory, workspaceID)))
  }

  async listSessions(options: { global?: boolean; directory?: string; workspaceID?: string } = {}) {
    const workspaceID = options.workspaceID ?? this.options.workspaceID
    try {
      if (getRawClient(this.client)) {
        if (options.global) {
          return (await rawRequest(this.client, {
            path: "/experimental/session",
            query: this.globalParams(workspaceID),
            throwOnError: true,
          })) as any[]
        }

        return (await rawRequest(this.client, {
          path: "/session",
          query: scopeQuery(this.resolveDirectory(options.directory), workspaceID),
          throwOnError: true,
        })) as any[]
      }

      if (this.publicClient?.session?.list) {
        if (options.global) {
          return unwrap(
            await this.publicClient.experimental.session.list(this.globalParams(workspaceID), {
              responseStyle: "data",
              throwOnError: true,
            }),
          ) as any[]
        }

        return unwrap(
          await this.publicClient.session.list(this.scopedParams({}, this.resolveDirectory(options.directory), workspaceID), {
            responseStyle: "data",
            throwOnError: true,
          }),
        ) as any[]
      }

      return unwrap(
        await this.client.session.list(
          options.global
            ? { query: this.globalParams(workspaceID) }
            : typeof this.resolveDirectory(options.directory) === "string"
              ? withScopeQuery({}, this.resolveDirectory(options.directory), workspaceID)
              : typeof workspaceID === "string"
                ? withScopeQuery({}, undefined, workspaceID)
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

  async getSessionChildren(sessionID: string, directory?: string, workspaceID = this.options.workspaceID) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (getRawClient(this.client)) {
      return (await rawRequest(this.client, {
        path: `/session/${encodeURIComponent(sessionID)}/children`,
        query: scopeQuery(resolvedDirectory, workspaceID),
        throwOnError: true,
      })) as any[]
    }

    if (this.publicClient?.session?.children) {
      return unwrap(
        await this.publicClient.session.children(this.scopedParams({ sessionID }, resolvedDirectory, workspaceID), {
          responseStyle: "data",
          throwOnError: true,
        }),
      ) as any[]
    }

    return unwrap(await this.client.session.children(withScopeQuery({ path: { id: sessionID } }, resolvedDirectory, workspaceID))) as any[]
  }

  async getSessionMessages(sessionID: string, directory?: string, workspaceID = this.options.workspaceID) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (getRawClient(this.client)) {
      return (await rawRequest(this.client, {
        path: `/session/${encodeURIComponent(sessionID)}/message`,
        query: scopeQuery(resolvedDirectory, workspaceID),
        throwOnError: true,
      })) as any[]
    }

    if (this.publicClient?.session?.messages) {
      return unwrap(
        await this.publicClient.session.messages(this.scopedParams({ sessionID }, resolvedDirectory, workspaceID), {
          responseStyle: "data",
          throwOnError: true,
        }),
      ) as any[]
    }

    return unwrap(await this.client.session.messages(withScopeQuery({ path: { id: sessionID } }, resolvedDirectory, workspaceID))) as any[]
  }

  async getSessionMessagePage(
    sessionID: string,
    options: {
      directory?: string
      limit: number
      before?: string
      workspaceID?: string
    },
  ): Promise<SessionMessagePage> {
    if (getRawClient(this.client)) {
      const response = await rawRequest<{ data?: any[]; response?: Response }>(this.client, {
        path: `/session/${encodeURIComponent(sessionID)}/message`,
        query: {
          ...(scopeQuery(this.resolveDirectory(options.directory), options.workspaceID ?? this.options.workspaceID) ?? {}),
          limit: options.limit,
          ...(typeof options.before === "string" ? { before: options.before } : {}),
        },
        responseStyle: "fields",
        throwOnError: true,
      })
      const messages = unwrap(response.data ?? []) as any[]
      const nextCursor = response.response ? extractSessionMessagePagingCursor(response.response.headers) : undefined

      if (messages.length >= options.limit && !nextCursor) {
        throw new SessionMessagePagingUnsupportedError()
      }

      return {
        messages,
        nextCursor,
      }
    }

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
        options.workspaceID ?? this.options.workspaceID,
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

  async injectSyntheticText(sessionID: string, text: string) {
    const parts = [{ type: "text", text, synthetic: true }]
    const noReply = true
    const attempts: Array<() => Promise<void>> = []

    if (getRawClient(this.client)) {
      attempts.push(async () => {
        await rawRequest(this.client, {
          method: "POST",
          path: `/session/${encodeURIComponent(sessionID)}/message`,
          query: scopeQuery(this.resolveDirectory(undefined), this.options.workspaceID),
          body: { parts, noReply },
          throwOnError: true,
        })
      })
    }

    if (this.publicClient?.session?.prompt) {
      attempts.push(async () => {
        await this.publicClient.session.prompt(this.scopedParams({ sessionID, parts, noReply }), {
          responseStyle: "data",
          throwOnError: true,
        })
      })
      attempts.push(async () => {
        await this.publicClient.session.prompt(this.scopedParams({ sessionID, prompt: { text }, delivery: "deferred", noReply }), {
          responseStyle: "data",
          throwOnError: true,
        })
      })
    }

    if (this.client?.session?.prompt) {
      attempts.push(async () => {
        await this.client.session.prompt(withScopeQuery({ path: { id: sessionID }, parts, noReply }, this.resolveDirectory(undefined), this.options.workspaceID))
      })
      attempts.push(async () => {
        await this.client.session.prompt(
          withScopeQuery({ path: { id: sessionID }, prompt: { text }, delivery: "deferred", noReply }, this.resolveDirectory(undefined), this.options.workspaceID),
        )
      })
    }

    for (const attempt of attempts) {
      try {
        await attempt()
        return { ok: true }
      } catch (error) {
        await this.debug("synthetic session notification failed", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    await this.debug("synthetic session notification unavailable", { sessionID })
    return { ok: false }
  }

  private async writeDebugEntry(level: "debug" | "info" | "warn" | "error", message: string, extra?: UnknownRecord) {
    await this.debugLogWriter.write(level, message, extra)
  }

  private resolveDirectory(directory?: string) {
    return typeof directory === "string" ? directory : this.options.directory
  }

  private scopedParams<T extends Record<string, unknown>>(input: T = {} as T, directory?: string, workspaceID = this.options.workspaceID) {
    const resolvedDirectory = this.resolveDirectory(directory)

    return {
      ...input,
      ...(typeof resolvedDirectory === "string" ? { directory: resolvedDirectory } : {}),
      ...(typeof workspaceID === "string" ? { workspace: workspaceID } : {}),
    }
  }

  private globalParams(workspaceID = this.options.workspaceID) {
    return {
      directory: "",
      ...(typeof workspaceID === "string" ? { workspace: workspaceID } : {}),
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

const recoverServerUrlFromInternalClient = (client: unknown): URL | undefined => {
  if (!client || typeof client !== "object") {
    return undefined
  }

  const rawClient = (client as { _client?: { getConfig?: () => { baseUrl?: unknown } } })._client
  const baseUrl = rawClient?.getConfig?.().baseUrl
  if (baseUrl instanceof URL) {
    return baseUrl
  }

  if (typeof baseUrl !== "string") {
    return undefined
  }

  try {
    return new URL(baseUrl)
  } catch {
    return undefined
  }
}
