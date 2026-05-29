import { createHash } from "node:crypto"

import { MissionControlIndexDB } from "./index-db.js"
import { OpenCodeAdapter } from "./opencode-client.js"
import { MissionControlRuntimeState } from "./runtime-state.js"
import { MissionControlSearchService } from "./search.js"
import { createSemanticProvider } from "./semantic-provider.js"
import { extractSessionID, extractWorkspaceID } from "./session-extractors.js"
import { MissionControlSessionService } from "./session-service.js"
import { MissionControlSourceDB } from "./source-db.js"
import { MissionControlTerminalRegistry, type TerminalStatus } from "./terminals/registry.js"
import { ZellijAdapter } from "./terminals/zellij.js"
import type {
  MissionControlCapabilityMatrix,
  MissionControlConfig,
  MissionControlRuntimeSecrets,
  MissionControlStatus,
  SessionFindArgs,
} from "./types.js"

type PluginContext = {
  client: any
  directory?: string
  worktree?: string
  serverUrl?: URL
  workspaceID?: string
  workspaceId?: string
  workspace?: string | { id?: string }
  project?: { workspaceID?: string; workspaceId?: string; workspace?: string | { id?: string } }
}

const SERVER_STORE_KEY = "__opencodeMissionControlServerStore__"

type ServerStore = Map<string, MissionControlServer>

const getServerStore = (): ServerStore => {
  const globalScope = globalThis as typeof globalThis & { [SERVER_STORE_KEY]?: ServerStore }
  globalScope[SERVER_STORE_KEY] ??= new Map<string, MissionControlServer>()
  return globalScope[SERVER_STORE_KEY]
}

export class MissionControlServer {
  readonly startedAt = Date.now()

  context: PluginContext
  config: MissionControlConfig

  private adapter: OpenCodeAdapter
  private secrets: MissionControlRuntimeSecrets
  private semanticProvider = undefined as ReturnType<typeof createSemanticProvider>
  private readonly runtimeState: MissionControlRuntimeState
  private readonly sourceDB: MissionControlSourceDB
  private readonly searchService: MissionControlSearchService
  private readonly sessionService: MissionControlSessionService
  private terminalRegistry: MissionControlTerminalRegistry
  private readonly workspaceID?: string
  private readonly workspaceKey?: string
  private storeKey?: string
  private started = false
  private disposed = false

  constructor(context: PluginContext, config: MissionControlConfig, secrets: MissionControlRuntimeSecrets) {
    const rootDir = context.directory ?? context.worktree ?? "."
    this.workspaceID = resolveAmbientWorkspaceID(context)
    this.workspaceKey = this.workspaceID ? createWorkspaceKey(this.workspaceID) : undefined

    this.context = context
    this.config = config
    this.secrets = secrets
    this.adapter = new OpenCodeAdapter(context.client, {
      rootDir,
      directory: context.directory,
      debug: config.debug,
      serverUrl: context.serverUrl,
      workspaceID: this.workspaceID,
    })
    this.semanticProvider = createSemanticProvider(config, secrets)
    this.runtimeState = new MissionControlRuntimeState(config.observe.eventBufferSize)
    this.sourceDB = new MissionControlSourceDB()
    this.searchService = new MissionControlSearchService(this.sourceDB, this.runtimeState)
    this.sessionService = new MissionControlSessionService(this.runtimeState, this.sourceDB)
    this.terminalRegistry = new MissionControlTerminalRegistry(new ZellijAdapter(), this.adapter)
  }

  static async fromContext(context: PluginContext, config: MissionControlConfig, secrets: MissionControlRuntimeSecrets) {
    const workspaceID = resolveAmbientWorkspaceID(context)
    const workspaceKey = workspaceID ? createWorkspaceKey(workspaceID) : undefined
    const key = workspaceKey ? `${workspaceKey}:${context.directory ?? context.worktree ?? "default"}` : context.directory ?? context.worktree ?? "default"
    const store = getServerStore()
    const existing = store.get(key)

    if (existing) {
      if (existing.disposed) {
        store.delete(key)
      } else {
        existing.rebind(context, config, secrets)
        return existing
      }
    }

    const created = new MissionControlServer(context, config, secrets)
    created.storeKey = key
    store.set(key, created)

    try {
      await created.start()
      return created
    } catch (error) {
      store.delete(key)
      throw error
    }
  }

  rebind(context: PluginContext, config: MissionControlConfig, secrets: MissionControlRuntimeSecrets) {
    const rootDir = context.directory ?? context.worktree ?? "."

    this.context = context
    this.config = config
    this.secrets = secrets
    this.adapter = new OpenCodeAdapter(context.client, {
      rootDir,
      directory: context.directory,
      debug: config.debug,
      serverUrl: context.serverUrl,
      workspaceID: this.workspaceID,
    })
    this.semanticProvider = createSemanticProvider(config, secrets)
    this.runtimeState.setBufferSize(config.observe.eventBufferSize)
    if (this.disposed) {
      this.terminalRegistry = new MissionControlTerminalRegistry(new ZellijAdapter(), this.adapter)
      this.disposed = false
    } else {
      this.terminalRegistry.setOpenCodeAdapter(this.adapter)
    }
  }

  async start() {
    const adapter = this.adapter

    if (this.started) {
      return
    }

    this.started = true
    await adapter.debug("Mission Control server started", {
      directory: this.context.directory,
      worktree: this.context.worktree,
      workspaceID: this.workspaceID,
      debugFileEnabled: this.config.debug.enabled,
    })
    await adapter.log("info", "Mission Control plugin initialized", {
      directory: this.context.directory,
      worktree: this.context.worktree,
      workspaceID: this.workspaceID,
    })
  }

  async dispose() {
    this.disposed = true
    this.terminalRegistry.dispose()
    if (this.storeKey && getServerStore().get(this.storeKey) === this) {
      getServerStore().delete(this.storeKey)
    }
  }

  capabilities(): MissionControlCapabilityMatrix {
    const exposesSessionTools = true
    const exposesTerminalTools = true

    return {
      search: {
        sessionGet: exposesSessionTools,
        sessionFind: exposesSessionTools,
        sessionRead: exposesSessionTools,
        sessionTail: exposesSessionTools,
        sessionTree: exposesSessionTools,
        sessionAbort: exposesSessionTools,
        sessionSend: exposesSessionTools,
        indexedRetrieval: exposesSessionTools && this.config.search.lexicalEnabled,
        semanticRetrieval: exposesSessionTools && (this.semanticProvider?.isAvailable() ?? false),
      },
      observe: {
        liveEvents: exposesSessionTools,
        recentBuffer: exposesSessionTools,
      },
      terminals: {
        zellij: exposesTerminalTools,
        syntheticNotifications: exposesTerminalTools,
      },
    }
  }

  async status(): Promise<MissionControlStatus> {
    const rootDir = this.context.directory ?? this.context.worktree ?? "."
    const indexDB = new MissionControlIndexDB(rootDir, this.config.search.indexPath, undefined, { workspaceKey: this.workspaceKey })
    const index = await indexDB.load()
    const indexStatus = await indexDB.readStatus()
    const persistedDirtySessionIDs = index
        ? await new MissionControlIndexDB(rootDir, this.config.search.indexPath, index.discovery.scope, { workspaceKey: this.workspaceKey }).readDirtySessionIDs(
          index.sessions.map((session) => session.sessionID),
        )
      : []

    return {
      name: "opencode-mission-control",
      startedAt: this.startedAt,
      directory: rootDir,
      workspaceID: this.workspaceID,
      implemented: {
        sessionGet: true,
        sessionFind: true,
        sessionRead: true,
        sessionTail: true,
        sessionTree: true,
        sessionAbort: true,
        sessionSend: true,
        sessionObserve: true,
        sessionSearch: this.config.search.lexicalEnabled || (this.semanticProvider?.isAvailable() ?? false),
        terminalTools: true,
      },
      config: this.config,
      counters: this.runtimeState.counters(),
      capabilities: this.capabilities(),
      index: {
        ...indexStatus,
        includeToolOutputsForIndexing:
          indexStatus.builtAt === undefined
            ? this.config.search.includeToolOutputsForIndexing
            : indexStatus.includeToolOutputsForIndexing,
        dirtySessionCount: index
          ? new Set([
              ...this.runtimeState.dirtySessionIDs(index.sessions.map((session) => session.sessionID)),
              ...persistedDirtySessionIDs,
            ]).size
          : 0,
      },
      recentEvents: this.runtimeState.recentEventsGlobal(this.config.observe.eventBufferSize),
    }
  }

  async onRuntimeEvent(type: string, payload: unknown) {
    this.runtimeState.recordEvent(type, payload)
    const rootDir = this.context.directory ?? this.context.worktree ?? "."
    const sessionID = extractSessionID(payload)
    if (sessionID && shouldPersistSearchInvalidation(type)) {
      await new MissionControlIndexDB(rootDir, this.config.search.indexPath, undefined, { workspaceKey: this.workspaceKey }).markDirtySessions([sessionID])
    }
  }

  async readSession(
    sessionId: string,
    options: {
      beforeMessageId?: string
      offset?: number
      limit?: number
      withChildren?: boolean
      withToolOutputs?: boolean
    },
  ) {
    const adapter = this.adapter
    return this.sessionService.readSession(adapter, sessionId, options)
  }

  async getSession(sessionId: string) {
    const adapter = this.adapter
    return this.sessionService.getSession(adapter, sessionId)
  }

  async findSessions(args: SessionFindArgs) {
    const adapter = this.adapter
    return this.sessionService.findSessions(adapter, args)
  }

  async tailSession(
    sessionId: string,
    options: {
      offset?: number
      limit?: number
      withChildren?: boolean
    },
  ) {
    const adapter = this.adapter
    return this.sessionService.tailSession(adapter, sessionId, options)
  }

  async sessionTree(sessionId: string, depth = 1) {
    const adapter = this.adapter
    return this.sessionService.sessionTree(adapter, sessionId, depth)
  }

  async abortSession(sessionId: string) {
    const adapter = this.adapter
    return this.sessionService.abortSession(adapter, sessionId)
  }

  async sendSessionMessageAsync(targetSessionId: string, text: string, fromSessionId?: string) {
    return this.sessionService.sendMessageAsync(this.adapter, targetSessionId, text, fromSessionId)
  }

  async sendSessionMessageInterrupt(targetSessionId: string, text: string, fromSessionId?: string) {
    return this.sessionService.sendMessageInterrupt(this.adapter, targetSessionId, text, fromSessionId)
  }

  async observeSession(
    sessionId: string,
    options: {
      withChildren?: boolean
      limit?: number
    },
  ) {
    const adapter = this.adapter
    return this.sessionService.observeSession(adapter, sessionId, options)
  }

  async searchSessions(args: import("./types.js").SessionSearchArgs) {
    const adapter = this.adapter
    const rootDir = this.context.directory ?? this.context.worktree ?? "."
    return this.searchService.search(adapter, this.config, rootDir, args, this.semanticProvider, this.workspaceID, this.workspaceKey)
  }

  async startTerminal(args: import("./terminals/registry.js").TerminalStartArgs) {
    return this.terminalRegistry.start(args)
  }

  async listTerminals(filters: { sessionId?: string; status?: TerminalStatus }) {
    return { terminals: this.terminalRegistry.list(filters) }
  }

  async getTerminal(id: string) {
    return this.terminalRegistry.get(id)
  }

  async readTerminal(id: string, options: { offset?: number; limit?: number; ansi?: boolean }) {
    return this.terminalRegistry.read(id, options)
  }

  async sendTerminal(id: string, args: { text?: string; keys?: string[] }) {
    return this.terminalRegistry.send(id, args)
  }

  async cancelTerminal(id: string, options: { closePane?: boolean; ctrlC?: boolean }) {
    return this.terminalRegistry.cancel(id, options)
  }

  async listTerminalPanes(args: { session?: string; sessionId?: string; all?: boolean }) {
    return this.terminalRegistry.listPanesLive(args)
  }

  async captureTerminalPane(args: {
    session?: string
    sessionId?: string
    paneId?: string
    full?: boolean
    ansi?: boolean
  }) {
    return this.terminalRegistry.capturePaneLive(args)
  }

  async listZellijSessions() {
    return this.terminalRegistry.listZellijSessions()
  }

  compactionContext(sessionId: string) {
    const children = this.runtimeState.childSessionSummaries(sessionId, { recursive: true, limit: 20 })
    if (children.length === 0) {
      return []
    }

    const lines = children.map((child) => {
      const fields = [
        `sessionId=${child.sessionId}`,
        `parentSessionId=${child.parentSessionId}`,
        child.title ? `title=${JSON.stringify(child.title)}` : undefined,
        child.status ? `status=${child.status}` : undefined,
        child.depth > 1 ? `depth=${child.depth}` : undefined,
      ].filter(Boolean)
      return `- ${fields.join("; ")}`
    })

    return [
      [
        "Mission Control known subagent sessions for this session:",
        ...lines,
        "Preserve these session IDs in the compacted summary when they may still be useful; running background subagents can be cancelled with mc_session_abort({ sessionId }).",
      ].join("\n"),
    ]
  }

}

const shouldPersistSearchInvalidation = (type: string) =>
  [
    "session.created",
    "session.updated",
    "session.compacted",
    "session.deleted",
    "message.updated",
    "message.removed",
    "message.part.updated",
    "message.part.removed",
  ].includes(type)

const resolveAmbientWorkspaceID = (context: PluginContext) =>
  extractWorkspaceID({
    workspaceID: context.workspaceID,
    workspaceId: context.workspaceId,
    workspace: context.workspace,
    project: context.project,
  })

const createWorkspaceKey = (workspaceID: string) =>
  createHash("sha1").update(`workspace:${workspaceID}`).digest("hex").slice(0, 16)
