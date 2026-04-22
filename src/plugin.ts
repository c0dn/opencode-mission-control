import type { Plugin } from "@opencode-ai/plugin"

import { resolveMissionControlRuntime } from "./config.js"
import { MISSION_CONTROL_EVENT_HOOKS } from "./events.js"
import { MissionControlServer } from "./server.js"
import { createMissionControlTools } from "./tools.js"
import type { MissionControlPluginOptions } from "./types.js"

const TOOL_GUIDANCE: Record<string, string> = {
  mc_session_read:
    "Use this when you need exact transcript entries or raw tool outputs. Example: mc_session_read({ sessionId: 'ses_123', withToolOutputs: true }).",
  mc_session_events:
    "Use this for recent live state, not full transcript history. Example: mc_session_events({ sessionId: 'ses_123', withChildren: true, limit: 25 }).",
  mc_session_search:
    "Use this for indexed search. Examples: mc_session_search({ query: 'retry logic', limit: 5 }); mc_session_search({ query: 'AmbiguousParentSession', scope: 'global', exact: true }); mc_session_search({ query: 'relay failure', sessionId: 'ses_123' }). Prefer mc_session_read when you need raw tool outputs.",
  mc_job_start:
    "Starts a background child session. Examples: mc_job_start({ prompt: 'Summarize blockers in this session.' }); mc_job_start({ sessionId: 'ses_123', title: 'Search audit', prompt: 'Find mentions of global scope behavior.' }). Omit sessionId to attach to the current parent session. Automatic parent notifications depend on the current runtime supporting parent relay.",
  mc_job_status:
    "Use this to inspect one background job, including any pending permission/question input and its latest stable result, if available. Example: mc_job_status({ jobId: 'job_123' }).",
  mc_job_events:
    "Use this for the persisted job event feed, including lifecycle changes and child progress updates. Example: mc_job_events({ jobId: 'job_123', limit: 25 }).",
  mc_job_list:
    "Use this to see recent jobs, optionally filtered by parent session or state. Example: mc_job_list({ sessionId: 'ses_123', state: 'running', limit: 10 }).",
  mc_job_update:
    "Use this from the background child session itself to record a progress checkpoint. Example: mc_job_update({ message: 'Finished scanning the last 4 files.' }); set notifyParent: true only for notable updates.",
  mc_job_permission_reply:
    "Use this from the parent session to approve or reject a pending permission request that blocked a child job. Example: mc_job_permission_reply({ jobId: 'job_123', reply: 'once' }).",
  mc_job_question_reply:
    "Use this from the parent session to answer a pending question for a blocked child job. Example: mc_job_question_reply({ jobId: 'job_123', answers: [['Option A']] }).",
  mc_job_question_reject:
    "Use this from the parent session to reject a pending question for a blocked child job. Example: mc_job_question_reject({ jobId: 'job_123' }).",
  mc_job_abort:
    "Use this from the parent session to stop an active background job. Example: mc_job_abort({ jobId: 'job_123' }).",
  mc_job_result:
    "Use this to fetch a stable job snapshot. Example: mc_job_result({ jobId: 'job_123' }). Set sendToParent: true to re-send a stored result to the parent session; run that from the parent session that launched the job.",
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
    "tool.definition": async (input: any, output: any) => {
      output.description = applyMissionControlToolGuidance(input.toolID, output.description)
    },
  } as any
}

export const server = MissionControlPlugin

export default MissionControlPlugin
