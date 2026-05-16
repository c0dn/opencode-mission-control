import { createOpencodeClient as createV2OpencodeClient } from "@opencode-ai/sdk/v2"

import { DebugLogWriter, type OpenCodeAdapterOptions } from "./opencode/debug-log.js"
import { directoryQuery, getRawClient, rawRequest, unwrap, withDirectoryQuery } from "./opencode/raw-client.js"
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

  async getSession(sessionID: string, directory?: string) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (getRawClient(this.client)) {
      return rawRequest(this.client, {
        path: `/session/${encodeURIComponent(sessionID)}`,
        query: directoryQuery(resolvedDirectory),
        throwOnError: true,
      })
    }

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
      if (getRawClient(this.client)) {
        if (options.global) {
          return (await rawRequest(this.client, {
            path: "/experimental/session",
            throwOnError: true,
          })) as any[]
        }

        return (await rawRequest(this.client, {
          path: "/session",
          query: directoryQuery(this.resolveDirectory(options.directory)),
          throwOnError: true,
        })) as any[]
      }

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

    if (getRawClient(this.client)) {
      return (await rawRequest(this.client, {
        path: `/session/${encodeURIComponent(sessionID)}/children`,
        query: directoryQuery(resolvedDirectory),
        throwOnError: true,
      })) as any[]
    }

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

    if (getRawClient(this.client)) {
      return (await rawRequest(this.client, {
        path: `/session/${encodeURIComponent(sessionID)}/message`,
        query: directoryQuery(resolvedDirectory),
        throwOnError: true,
      })) as any[]
    }

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
    if (getRawClient(this.client)) {
      const response = await rawRequest<{ data?: any[]; response?: Response }>(this.client, {
        path: `/session/${encodeURIComponent(sessionID)}/message`,
        query: {
          ...(directoryQuery(this.resolveDirectory(options.directory)) ?? {}),
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
