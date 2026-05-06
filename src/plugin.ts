import type { Plugin } from "@opencode-ai/plugin"

import { resolveMissionControlRuntime } from "./config.js"
import { MISSION_CONTROL_EVENT_HOOKS } from "./events.js"
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
  mc_session_search:
    "Use this for indexed content search. Examples: mc_session_search({ query: 'retry logic', limit: 5 }); mc_session_search({ query: 'ParentSessionScopeUnavailable', scope: 'global', exact: true }). Use mc_session_find for title lookup and mc_session_get when you already have a sessionId. Prefer mc_session_tail for recent text and mc_session_read only for deep transcript inspection.",
  mc_job_start:
    "Starts a background child session attached to the current parent session only. Examples: mc_job_start({ prompt: 'Summarize blockers in this session.' }); mc_job_start({ title: 'Search audit', prompt: 'Find mentions of global scope behavior.' }). Call it from the parent session you want to attach to. Automatic parent notifications depend on the current runtime supporting parent relay.",
  mc_job_status:
    "Use this to inspect one background job's compact current state. Example: mc_job_status({ jobId: 'job_123' }). Use mc_job_pending_input for blocked details and mc_job_result for the stored terminal summary.",
  mc_job_pending_input:
    "Use this when a job is blocked and you need the full actionable permission/question payload. Example: mc_job_pending_input({ jobId: 'job_123' }).",
  mc_job_events:
    "Use this for the compact persisted job event timeline, including lifecycle changes and child progress updates. Example: mc_job_events({ jobId: 'job_123', limit: 25 }).",
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
    "Use this to fetch the compact stable job summary after the job reaches a terminal or idle snapshot state. Example: mc_job_result({ jobId: 'job_123' }). Set sendToParent: true to re-send a stored result to the parent session; run that from the parent session that launched the job.",
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
