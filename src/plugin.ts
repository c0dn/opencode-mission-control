import type { Plugin } from "@opencode-ai/plugin"

import { resolveMissionControlRuntime } from "./config.js"
import { MISSION_CONTROL_DISPOSAL_EVENT_HOOKS, MISSION_CONTROL_EVENT_HOOKS } from "./events.js"
import { MissionControlServer } from "./server.js"
import { createMissionControlTools } from "./tools.js"
import type { MissionControlPluginOptions } from "./types.js"

const TOOL_GUIDANCE: Record<string, string> = {
  mc_session_get:
    "Use this to resolve a known session ID to normalized metadata only. It does not read transcript entries; use mc_session_read or mc_session_tail for content.",
  mc_session_find:
    "Use this to find sessions by exact title and inspect metadata candidates. If ambiguous is true, choose a returned sessionId before reading transcript content.",
  mc_session_read:
    "Use this for exact transcript inspection across older session history. Prefer paging with offset/limit instead of reading everything at once. Only set withToolOutputs: true when raw tool output is truly required.",
  mc_session_tail:
    "Use this for the latest text-only session messages. Example: mc_session_tail({ sessionId: 'ses_123', limit: 10 }). Prefer this over mc_session_read when you only need the recent conversation.",
  mc_session_events:
    "Use this for recent live state, not full transcript history. Example: mc_session_events({ sessionId: 'ses_123', withChildren: true, limit: 25 }).",
  mc_session_abort:
    "Use this to request cancellation for an OpenCode session, primarily background subagents by subagent session ID. It calls OpenCode's public session abort endpoint. Foreground subagents can block the parent tool loop, so this works best when another active tool loop can issue the abort.",
  mc_session_send_async:
    "Use this to queue a message into another OpenCode session without blocking. The target sees the message at its next loop boundary, not mid-response. Your sender session ID is wrapped into an inter_agent_message envelope so the target knows who sent it. Mission Control refuses to prompt child/subagent sessions directly; send to the parent session if you intend to steer orchestration. Pair it with mc_session_tail to read the target's reply.",
  mc_session_send_interrupt:
    "Use this to abort the target session's in-flight response first, then deliver a message so it is acted on immediately. It interrupts any current generation or tool call. Mission Control refuses to prompt child/subagent sessions directly; use mc_session_abort for stopping a child session, or send to the parent session if you intend to steer orchestration. The sender session ID is included as an inter_agent_message envelope.",
  mc_session_search:
    "Use this for indexed content search. Examples: mc_session_search({ query: 'retry logic', limit: 5 }); mc_session_search({ query: 'SessionLookupUnavailable', scope: 'global', exact: true }). Use mc_session_find for title lookup and mc_session_get when you already have a sessionId. Prefer mc_session_tail for recent text and mc_session_read only for deep transcript inspection.",
}

export const applyMissionControlToolGuidance = (toolID: string, description: string) => {
  const guidance = TOOL_GUIDANCE[toolID]
  if (!guidance) {
    return description
  }

  return `${description}\n\n${guidance}`
}

export const MissionControlPlugin: Plugin = async (context: any, options?: MissionControlPluginOptions) => {
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
