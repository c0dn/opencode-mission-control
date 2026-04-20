import type { Plugin } from "@opencode-ai/plugin"

import { resolveMissionControlRuntime } from "./config.js"
import { MISSION_CONTROL_EVENT_HOOKS } from "./events.js"
import { MissionControlServer } from "./server.js"
import { createMissionControlTools } from "./tools.js"
import type { MissionControlPluginOptions } from "./types.js"

export const MissionControlPlugin: Plugin = async (context: any, options?: MissionControlPluginOptions) => {
  const { config, secrets } = resolveMissionControlRuntime(options)
  const server = await MissionControlServer.fromContext(context, config, secrets)

  return {
    tool: createMissionControlTools(server),
    event: async (input: any) => {
      const runtimeEvent = input?.event ?? input
      const eventName = runtimeEvent?.type

      if (
        typeof eventName === "string" &&
        MISSION_CONTROL_EVENT_HOOKS.includes(eventName as (typeof MISSION_CONTROL_EVENT_HOOKS)[number])
      ) {
        await server.onRuntimeEvent(eventName, runtimeEvent?.properties ?? runtimeEvent)
      }
    },
  } as any
}

export const server = MissionControlPlugin

export default MissionControlPlugin
