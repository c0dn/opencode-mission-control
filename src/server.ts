import { MissionControlIndexDB } from "./index-db.js"
import { OpenCodeAdapter } from "./opencode-client.js"
import { MissionControlRuntimeState } from "./runtime-state.js"
import { MissionControlSearchService } from "./search.js"
import { createSemanticProvider } from "./semantic-provider.js"
import { extractSessionID } from "./session-extractors.js"
import { MissionControlSessionService } from "./session-service.js"
import { MissionControlSourceDB } from "./source-db.js"
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
  private started = false

  constructor(context: PluginContext, config: MissionControlConfig, secrets: MissionControlRuntimeSecrets) {
    const rootDir = context.directory ?? context.worktree ?? "."

    this.context = context
    this.config = config
    this.secrets = secrets
    this.adapter = new OpenCodeAdapter(context.client, {
      rootDir,
      directory: context.directory,
      debug: config.debug,
      serverUrl: context.serverUrl,
    })
    this.semanticProvider = createSemanticProvider(config, secrets)
    this.runtimeState = new MissionControlRuntimeState(config.observe.eventBufferSize)
    this.sourceDB = new MissionControlSourceDB()
    this.searchService = new MissionControlSearchService(this.sourceDB, this.runtimeState)
    this.sessionService = new MissionControlSessionService(this.runtimeState, this.sourceDB)
  }

  static async fromContext(context: PluginContext, config: MissionControlConfig, secrets: MissionControlRuntimeSecrets) {
    const key = context.directory ?? context.worktree ?? "default"
    const store = getServerStore()
    const existing = store.get(key)

    if (existing) {
      existing.rebind(context, config, secrets)
      return existing
    }

    const created = new MissionControlServer(context, config, secrets)
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
    })
    this.semanticProvider = createSemanticProvider(config, secrets)
    this.runtimeState.setBufferSize(config.observe.eventBufferSize)
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
      debugFileEnabled: this.config.debug.enabled,
    })
    await adapter.log("info", "Mission Control plugin initialized", {
      directory: this.context.directory,
      worktree: this.context.worktree,
    })
  }

  capabilities(): MissionControlCapabilityMatrix {
    const exposesSessionTools = true

    return {
      search: {
        sessionGet: exposesSessionTools,
        sessionFind: exposesSessionTools,
        sessionRead: exposesSessionTools,
        sessionTail: exposesSessionTools,
        sessionTree: exposesSessionTools,
        indexedRetrieval: exposesSessionTools && this.config.search.lexicalEnabled,
        semanticRetrieval: exposesSessionTools && (this.semanticProvider?.isAvailable() ?? false),
      },
      observe: {
        liveEvents: exposesSessionTools,
        recentBuffer: exposesSessionTools,
      },
    }
  }

  async status(): Promise<MissionControlStatus> {
    const rootDir = this.context.directory ?? this.context.worktree ?? "."
    const indexDB = new MissionControlIndexDB(rootDir, this.config.search.indexPath)
    const index = await indexDB.load()
    const indexStatus = await indexDB.readStatus()
    const persistedDirtySessionIDs = index
      ? await new MissionControlIndexDB(rootDir, this.config.search.indexPath, index.discovery.scope).readDirtySessionIDs(
          index.sessions.map((session) => session.sessionID),
        )
      : []

    return {
      name: "opencode-mission-control",
      startedAt: this.startedAt,
      directory: rootDir,
      implemented: {
        sessionGet: true,
        sessionFind: true,
        sessionRead: true,
        sessionTail: true,
        sessionTree: true,
        sessionObserve: true,
        sessionSearch: this.config.search.lexicalEnabled || (this.semanticProvider?.isAvailable() ?? false),
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
    }
  }

  async onRuntimeEvent(type: string, payload: unknown) {
    this.runtimeState.recordEvent(type, payload)
    const rootDir = this.context.directory ?? this.context.worktree ?? "."
    const sessionID = extractSessionID(payload)
    if (sessionID && shouldPersistSearchInvalidation(type)) {
      await new MissionControlIndexDB(rootDir, this.config.search.indexPath).markDirtySessions([sessionID])
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
    return this.searchService.search(adapter, this.config, rootDir, args, this.semanticProvider)
  }

}

const shouldPersistSearchInvalidation = (type: string) =>
  [
    "session.created",
    "session.updated",
    "session.compacted",
    "message.updated",
    "message.removed",
    "message.part.updated",
    "message.part.removed",
  ].includes(type)
