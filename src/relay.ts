import type { OpenCodeAdapter } from "./opencode-client.js"
import type { BackgroundJob, JobPendingInput, JobResultSnapshot, ParentRelayPayload } from "./types.js"

export const buildParentRelayPayload = (job: BackgroundJob, result: JobResultSnapshot): ParentRelayPayload => ({
  jobID: job.jobID,
  childSessionID: result.childSessionID,
  title: job.title,
  state: result.state,
  summary: result.summary,
  blockers: result.blockers,
  recommendedNextStep: result.recommendedNextStep,
})

export const formatParentRelay = (payload: ParentRelayPayload) => {
  const blockers = payload.blockers.length > 0 ? payload.blockers.map((blocker) => `- ${blocker}`).join("\n") : "- None"
  const recommendedNextStep = payload.recommendedNextStep
    ? `\n\nRecommended Next Step:\n${payload.recommendedNextStep}`
    : ""

  return `Attached background session update

- Job ID: ${payload.jobID}
- Child Session ID: ${payload.childSessionID}
- Mission: ${payload.title}
- Status: ${payload.state}

Summary:
${payload.summary}

Blockers:
${blockers}${recommendedNextStep}`
}

export const formatPendingInputRelay = (job: BackgroundJob, pendingInput: JobPendingInput) => {
  const header =
    pendingInput.kind === "permission"
      ? "Attached background session blocked on permission"
      : "Attached background session is waiting on a question"
  const body =
    pendingInput.kind === "permission"
      ? formatPermissionRequestBody(job.jobID, pendingInput)
      : formatQuestionRequestBody(job.jobID, pendingInput)

  return `${header}

- Job ID: ${job.jobID}
- Child Session ID: ${job.childSessionID ?? "unknown"}
- Mission: ${job.title}

${body}`
}

export const formatProgressRelay = (job: BackgroundJob, message: string) => `Attached background session progress update

- Job ID: ${job.jobID}
- Child Session ID: ${job.childSessionID ?? "unknown"}
- Mission: ${job.title}

Progress:
${message}`

export const formatBlockedStateRelay = (job: BackgroundJob, kind: "permission" | "question") => `Attached background session blocked

- Job ID: ${job.jobID}
- Child Session ID: ${job.childSessionID ?? "unknown"}
- Mission: ${job.title}
- Blocked On: ${kind}

Mission Control detected that the child session is blocked, but the detailed request payload is not available yet.
Re-check mc_job_status({ jobId: "${job.jobID}" }) or mc_job_events({ jobId: "${job.jobID}", limit: 25 }) shortly for the normalized pending input.`

export const deliverParentRelay = async (
  adapter: OpenCodeAdapter,
  job: BackgroundJob,
  result: JobResultSnapshot,
) => {
  await adapter.promptNoReply(job.parentSessionID, formatParentRelay(buildParentRelayPayload(job, result)), job.parentDirectory)
}

export const deliverPendingInputRelay = async (
  adapter: OpenCodeAdapter,
  job: BackgroundJob,
  pendingInput: JobPendingInput,
) => {
  await adapter.promptNoReply(job.parentSessionID, formatPendingInputRelay(job, pendingInput), job.parentDirectory)
}

export const deliverProgressRelay = async (
  adapter: OpenCodeAdapter,
  job: BackgroundJob,
  message: string,
) => {
  await adapter.promptNoReply(job.parentSessionID, formatProgressRelay(job, message), job.parentDirectory)
}

export const deliverBlockedStateRelay = async (
  adapter: OpenCodeAdapter,
  job: BackgroundJob,
  kind: "permission" | "question",
) => {
  await adapter.promptNoReply(job.parentSessionID, formatBlockedStateRelay(job, kind), job.parentDirectory)
}

const formatPermissionRequestBody = (jobID: string, pendingInput: Extract<JobPendingInput, { kind: "permission" }>) => {
  const patterns =
    pendingInput.patterns.length > 0 ? pendingInput.patterns.map((pattern) => `- ${pattern}`).join("\n") : "- None"

  return `Permission:
${pendingInput.permission}

Patterns:
${patterns}

Reply with one of:
- mc_job_permission_reply({ jobId: "${jobID}", reply: "once" })
- mc_job_permission_reply({ jobId: "${jobID}", reply: "always" })
- mc_job_permission_reply({ jobId: "${jobID}", reply: "reject", message: "optional reason" })`
}

const formatQuestionRequestBody = (jobID: string, pendingInput: Extract<JobPendingInput, { kind: "question" }>) => {
  const questions = pendingInput.questions
    .map((question, index) => {
      const options =
        question.options.length > 0
          ? question.options.map((option) => `  - ${option.label}: ${option.description}`).join("\n")
          : "  - No predefined options"

      return `${index + 1}. ${question.header}\n${question.question}\n${options}`
    })
    .join("\n\n")

  return `Questions:
${questions}

Reply with:
- mc_job_question_reply({ jobId: "${jobID}", answers: [["selected label"]] })
- mc_job_question_reject({ jobId: "${jobID}" })`
}
