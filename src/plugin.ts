import type { Plugin } from "@opencode-ai/plugin"

import { resolveMissionControlRuntime } from "./config.js"
import { MISSION_CONTROL_DISPOSAL_EVENT_HOOKS, MISSION_CONTROL_EVENT_HOOKS } from "./events.js"
import { MissionControlServer } from "./server.js"
import { createMissionControlTools } from "./tools.js"
import type { MissionControlPluginOptions } from "./types.js"

const TOOL_GUIDANCE: Record<string, string> = {
  session_get:
    "Use this to resolve a known session ID to normalized metadata only. It does not read transcript entries; use session_read or session_tail for content.",
  session_find:
    "Use this to find sessions by exact title and inspect metadata candidates. If ambiguous is true, choose a returned sessionId before reading transcript content.",
  session_list:
    "Use this to browse and filter sessions by scope, timestamp floor, or title substring. Returns all matching sessions (parents and children) sorted by most-recently-updated.",
  session_read:
    "Use this for exact transcript inspection across older session history. Prefer paging with offset/limit instead of reading everything at once. Only set withToolOutputs: true when raw tool output is truly required.",
  session_tail:
    "Use this for the latest text-only session messages. Example: session_tail({ sessionId: 'ses_123', limit: 10 }). Prefer this over session_read when you only need the recent conversation.",
  session_search:
    "Use this for semantic content search within the current project. Example: session_search({ query: 'retry logic', limit: 5 }). Use session_find for title lookup and session_get when you already have a sessionId. Prefer session_tail for recent text and session_read only for deep transcript inspection.",
  session_search_global:
    "Use this for semantic content search across all projects globally. Same as session_search but searches all sessions regardless of directory. Use when the target session may be from a different project.",
  subagent_abort:
    "Use this to request cancellation for an OpenCode session, primarily background subagents by subagent session ID. It calls OpenCode's public session abort endpoint. Foreground subagents can block the parent tool loop, so this works best when another active tool loop can issue the abort.",
  subagent_send_async:
    "Use this to queue a message to a peer subagent (a sibling with the same parent session). The target sees the message at its next loop boundary. Your sender session ID is wrapped into an inter_agent_message envelope so the target knows who sent it. To return a result to your calling agent, finish and end your loop — results auto-return to the parent. Pair with session_tail to read the peer's reply.",
  subagent_send_interrupt:
    "Use this to abort a peer subagent's in-flight response and deliver a message immediately. Reserved for when a peer's current work is actively wrong or obsolete. To return a result to your calling agent, end your loop instead. The sender session ID is included as an inter_agent_message envelope.",
}

export const applyMissionControlToolGuidance = (toolID: string, description: string) => {
  const guidance = TOOL_GUIDANCE[toolID]
  if (!guidance) {
    return description
  }

  return `${description}\n\n${guidance}`
}

export const MissionControlPlugin: Plugin = async (context: any, options?: MissionControlPluginOptions) => {
  // Gate: a Jina API key is required. Without one, search cannot run and the
  // plugin registers no tools rather than silently delivering a degraded surface.
  const jinaApiKey = options?.search?.jinaApiKey?.trim()
  if (!jinaApiKey) {
    return {
      dispose: async () => {},
    } as any
  }

  const { config, secrets } = resolveMissionControlRuntime(options)
  const server = await MissionControlServer.fromContext(context, config, secrets)

  return {
    dispose: async () => {
      await server.dispose()
    },
    tool: createMissionControlTools(server),
    event: async (input: any) => {
      const runtimeEvent = input?.event ?? input
      const eventName = runtimeEvent?.type

      if (
        typeof eventName === "string" &&
        MISSION_CONTROL_DISPOSAL_EVENT_HOOKS.includes(
          eventName as (typeof MISSION_CONTROL_DISPOSAL_EVENT_HOOKS)[number],
        )
      ) {
        await server.dispose()
        return
      }

      if (
        typeof eventName === "string" &&
        MISSION_CONTROL_EVENT_HOOKS.includes(eventName as (typeof MISSION_CONTROL_EVENT_HOOKS)[number])
      ) {
        await server.onRuntimeEvent(eventName, runtimeEvent?.properties ?? runtimeEvent)
      }
    },
    "tool.definition": async (input: any, output: any) => {
      output.description = applyMissionControlToolGuidance(input.toolID, output.description)
    },
    "experimental.session.compacting": async (input: any, output: any) => {
      const sessionID = input?.sessionID
      if (typeof sessionID !== "string") {
        return
      }

      const context = server.compactionContext(sessionID)
      if (context.length === 0) {
        return
      }

      if (!Array.isArray(output.context)) {
        output.context = []
      }
      output.context.push(...context)
    },
  } as any
}

export const server = MissionControlPlugin

export default MissionControlPlugin
