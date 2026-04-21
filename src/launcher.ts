import type { OpenCodeAdapter } from "./opencode-client.js"
import { extractDirectory, extractParentSessionID, extractSessionID, extractSessionTimestamp } from "./session-extractors.js"
import { MissionControlJobController } from "./jobs.js"
import { buildAttachedJobPrompt } from "./prompts.js"
import type {
  JobStartArgs,
  JobStartResult,
  MissionControlConfig,
  ParentSessionResolution,
  ToolCallerContext,
  ToolResult,
} from "./types.js"
import { fail, ok } from "./types.js"

export class MissionControlJobLauncher {
  constructor(
    private readonly config: () => MissionControlConfig,
    private readonly controller: MissionControlJobController,
  ) {}

  async launch(
    adapter: OpenCodeAdapter,
    args: JobStartArgs,
    caller: ToolCallerContext = {},
  ): Promise<ToolResult<JobStartResult>> {
    const config = this.config()
    if (!config.jobs.enabled) {
      return fail(
        "JobLaunchFailed",
        "Background jobs are disabled in the current configuration.",
        "Enable jobs.enabled before launching attached child sessions.",
      )
    }

    if (!this.controller.tryReserveLaunchSlot(config.jobs.maxConcurrent)) {
      return fail(
        "JobLaunchFailed",
        "The job concurrency limit has been reached.",
        "Wait for an active job to finish or raise jobs.maxConcurrent.",
      )
    }

    let job: Awaited<ReturnType<MissionControlJobController["createJob"]>> | undefined
    let reservationTransferred = false

    try {
      const parentResolution = await this.resolveParentSession(adapter, args, caller, config)
      if (!parentResolution.ok) {
        return parentResolution
      }

      reservationTransferred = true
      job = await this.controller.createJob(
        args,
        {
          sessionID: parentResolution.data.sessionID,
          directory: parentResolution.data.directory,
        },
        {
          consumeLaunchReservation: true,
        },
      )

      await this.controller.markLaunching(job.jobID)
      const childSession = await adapter.createChildSession(
        parentResolution.data.sessionID,
        `${config.jobs.titlePrefix}: ${args.title}`,
        parentResolution.data.directory,
      )
      const childSessionID = typeof childSession?.id === "string" ? childSession.id : undefined
      const childDirectory =
        typeof childSession?.directory === "string" ? childSession.directory : parentResolution.data.directory
      if (!childSessionID) {
        throw new Error("Child session creation did not return a session id")
      }

      await this.controller.bindChildSession(job.jobID, childSessionID, childDirectory)

      await adapter.promptAsync(childSessionID, buildAttachedJobPrompt(job), childDirectory)
      await this.controller.markLaunched(job.jobID, childSessionID, childDirectory)

      return ok({
        jobID: job.jobID,
        parentSessionID: job.parentSessionID,
        childSessionID,
        state: "running",
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown launch failure"

      if (job && this.controller.status(job.jobID).ok) {
        const currentStatus = this.controller.status(job.jobID)
        if (currentStatus.ok && currentStatus.data.job.childSessionID) {
          try {
            await adapter.abortSession(currentStatus.data.job.childSessionID, currentStatus.data.job.childDirectory)
            await this.controller.markLaunchFailed(job.jobID, message)
          } catch {
            await this.controller.markOrphaned(
              job.jobID,
              `${message}; the child session could not be aborted and is now orphaned`,
            )
          }
        } else {
          await this.controller.markLaunchFailed(job.jobID, message)
        }
      }

      return fail(
        "JobLaunchFailed",
        `Failed to launch background job '${job?.jobID ?? "pending"}'.`,
        message,
      )
    } finally {
      if (!job && !reservationTransferred) {
        this.controller.releaseLaunchSlot()
      }
    }
  }

  private async resolveParentSession(
    adapter: OpenCodeAdapter,
    args: JobStartArgs,
    caller: ToolCallerContext,
    config: MissionControlConfig,
  ): Promise<ToolResult<ParentSessionResolution>> {
    if (args.parentSessionID !== undefined) {
      const explicitParentSessionID = args.parentSessionID.trim()
      if (!explicitParentSessionID) {
        return fail(
          "ParentSessionNotFound",
          "A blank parentSessionID is not a valid explicit parent session reference.",
          "Pass a real session ID or omit parentSessionID to use automatic attachment.",
        )
      }

      try {
        const resolved = await adapter.resolveSession(explicitParentSessionID)
        return ok({
          mode: "explicit_parent",
          sessionID: explicitParentSessionID,
          directory: resolved.directory,
          confidence: "explicit",
        })
      } catch {
        return fail(
          "ParentSessionNotFound",
          `Parent session '${explicitParentSessionID}' was not found.`,
          "Pass an existing parentSessionID or omit it to use automatic attachment.",
        )
      }
    }

    const autoAttachEnabled = args.attach === "auto" || (args.attach !== "explicit_only" && config.jobs.autoAttachToCurrentSession)
    if (!autoAttachEnabled) {
      return fail(
        "ParentSessionNotFound",
        "Automatic parent-session attachment is disabled for this job launch.",
        "Pass parentSessionID explicitly or use attach='auto'.",
      )
    }

    if (caller.sessionID) {
      try {
        const resolved = await adapter.resolveSession(caller.sessionID)
        return ok({
          mode: "current_session",
          sessionID: caller.sessionID,
          directory: resolved.directory ?? caller.directory,
          confidence: "high",
        })
        } catch {
          if (!config.jobs.allowLatestSessionFallback) {
            return fail(
              "ParentSessionScopeUnavailable",
              "The current session could not be resolved for automatic attachment.",
              "Pass parentSessionID explicitly or enable latest-session fallback.",
            )
        }
      }
    }

    if (!config.jobs.allowLatestSessionFallback) {
      return fail(
        "ParentSessionScopeUnavailable",
        "Automatic attachment could not resolve a current parent session.",
        "Pass parentSessionID explicitly or enable latest-session fallback.",
      )
    }

    let sessions: any[]
    try {
      sessions = await adapter.listSessions({ directory: caller.directory })
    } catch {
      return fail(
        "ParentSessionScopeUnavailable",
        "Mission Control could not inspect the current session scope for a fallback parent.",
        "Pass parentSessionID explicitly and retry.",
      )
    }

    const rootSessions = sessions
      .filter((session) => extractSessionID(session) && !extractParentSessionID(session))
      .sort((left, right) => toUpdatedAt(right) - toUpdatedAt(left))

    if (rootSessions.length === 0) {
      return fail(
        "ParentSessionNotFound",
        "No root session is available in the current scope for fallback attachment.",
        "Pass parentSessionID explicitly and retry.",
      )
    }

    if (rootSessions.length > 1 && config.safety.requireExplicitParentOnAmbiguousAttach) {
      return fail(
        "AmbiguousParentSession",
        "More than one root session is available for fallback attachment.",
        "Pass parentSessionID explicitly to choose the correct parent session.",
      )
    }

    const chosen = rootSessions[0]
    const chosenSessionID = extractSessionID(chosen)
    if (!chosenSessionID) {
      return fail(
        "ParentSessionScopeUnavailable",
        "Mission Control could not read a fallback parent session ID from the current scope.",
        "Pass parentSessionID explicitly and retry.",
      )
    }

    return ok({
      mode: "scope_latest_session",
      sessionID: chosenSessionID,
      directory: extractDirectory(chosen) ?? caller.directory,
      confidence: "best_effort",
    })
  }
}

const toUpdatedAt = (session: any) => {
  return extractSessionTimestamp(session, "updated") ?? extractSessionTimestamp(session, "created") ?? 0
}
