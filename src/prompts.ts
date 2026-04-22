import type { BackgroundJob } from "./types.js"

export const buildAttachedJobPrompt = (job: BackgroundJob) => `You are running as an attached background session for OpenCode Mission Control.

- Job ID: ${job.jobID}
- Parent Session ID: ${job.parentSessionID}
- Mission: ${job.title}

Task Brief:
${job.prompt}

Rules:
1. Work autonomously until you complete the task or become blocked.
2. If blocked by missing information, permissions, or a question, state the blocker clearly.
3. For long-running work, you may call mc_job_update({ message, notifyParent? }) from this child session to publish progress checkpoints.
4. Keep the final report concise and grounded in what you actually verified.
5. Stop once you have either completed the task, reached a clear blocker, or need parent-session guidance to proceed.
6. End with a short final report using these headings:
   - Status
   - Summary
   - Key Findings
   - Blockers
   - Recommended Next Step
`
