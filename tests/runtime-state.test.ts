import { describe, expect, test } from "bun:test"

import { MissionControlRuntimeState } from "../src/runtime-state.ts"

describe("MissionControlRuntimeState", () => {
  test("tracks status updates and recent session events", () => {
    const state = new MissionControlRuntimeState(2)

    state.recordEvent("session.status", {
      sessionID: "session-1",
      status: {
        type: "busy",
      },
    })
    state.recordEvent("session.idle", {
      sessionID: "session-1",
    })
    state.recordEvent("message.updated", {
      sessionID: "session-2",
    })

    expect(state.statusForSession("session-1")).toBe("idle")
    expect(state.counters().byType["session.status"]).toBe(1)

    const recent = state.recentEventsForSessions(["session-1", "session-2"], 5)
    expect(recent).toHaveLength(2)
    expect(recent[0]?.type).toBe("message.updated")
    expect(recent[1]?.type).toBe("session.idle")
  })

  test("extracts session ids from nested SDK event payloads", () => {
    const state = new MissionControlRuntimeState(10)

    state.recordEvent("message.updated", {
      info: {
        sessionID: "session-nested",
      },
    })

    state.recordEvent("message.part.updated", {
      part: {
        sessionID: "session-part",
      },
    })

    expect(state.recentEventsForSessions(["session-nested"], 5)).toHaveLength(1)
    expect(state.recentEventsForSessions(["session-part"], 5)).toHaveLength(1)
  })

  test("tracks blocked and resumed statuses from permission and question events", () => {
    const state = new MissionControlRuntimeState(10)

    state.recordEvent("permission.asked", { sessionID: "session-blocked" })
    expect(state.statusForSession("session-blocked")).toBe("waiting_permission")

    state.recordEvent("permission.replied", { sessionID: "session-blocked" })
    expect(state.statusForSession("session-blocked")).toBe("running")

    state.recordEvent("question.asked", { sessionID: "session-blocked" })
    expect(state.statusForSession("session-blocked")).toBe("waiting_question")

    state.recordEvent("question.rejected", { sessionID: "session-blocked" })
    expect(state.statusForSession("session-blocked")).toBe("failed")
  })

  test("tracks and clears dirty sessions for index invalidation", () => {
    const state = new MissionControlRuntimeState(10)

    state.recordEvent("message.part.updated", { sessionID: "session-dirty" })
    const firstDirtySnapshot = state.dirtySessionsWithTimestamps(["session-dirty"])
    state.recordEvent("session.updated", { sessionID: "session-cleanable" })
    state.recordEvent("permission.asked", { sessionID: "session-not-dirty" })

    expect(state.isSessionDirty("session-dirty")).toBe(true)
    expect(state.dirtySessionIDs().sort()).toEqual(["session-cleanable", "session-dirty"])
    expect(state.dirtySessionCount(["session-dirty", "session-not-dirty"])).toBe(1)

    state.recordEvent("message.updated", { sessionID: "session-dirty" })
    state.clearDirtySessionsUpTo(firstDirtySnapshot)
    expect(state.isSessionDirty("session-dirty")).toBe(true)

    state.clearDirtySessionsUpTo(state.dirtySessionsWithTimestamps(["session-dirty"]))
    expect(state.isSessionDirty("session-dirty")).toBe(false)
    expect(state.dirtySessionIDs()).toEqual(["session-cleanable"])
  })

  test("marks destructive message and compaction events as dirty", () => {
    const state = new MissionControlRuntimeState(10)

    state.recordEvent("message.removed", { sessionID: "session-removed" })
    state.recordEvent("session.compacted", { sessionID: "session-compacted" })

    expect(state.dirtySessionIDs().sort()).toEqual(["session-compacted", "session-removed"])
  })
})
