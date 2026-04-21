import { describe, expect, test } from "bun:test"

import { OpenCodeAdapter } from "../src/opencode-client.ts"
import { MissionControlRuntimeState } from "../src/runtime-state.ts"
import { MissionControlSessionService } from "../src/session-service.ts"

describe("MissionControlSessionService", () => {
  test("reads a session outside the current directory by resolving its actual directory first", async () => {
    const remoteDirectory = "/tmp/remote-project"
    let globalListCalls = 0

    const adapter = new OpenCodeAdapter({
      session: {
        async get({ path, query }: { path: { id: string }; query?: { directory?: string } }) {
          if (path.id !== "remote-session") {
            throw new Error("not found")
          }

          if (query?.directory === remoteDirectory) {
            return {
              id: "remote-session",
              directory: remoteDirectory,
              title: "Remote Session",
              time: { created: 1, updated: 2 },
            }
          }

          throw new Error("not found")
        },
        async list({ query }: { query?: { directory?: string } } = {}) {
          if (query?.directory === "") {
            globalListCalls += 1
            return [
              {
                id: "remote-session",
                directory: remoteDirectory,
                title: "Remote Session",
                time: { created: 1, updated: 2 },
              },
            ]
          }

          return []
        },
        async messages({ path, query }: { path: { id: string }; query?: { directory?: string } }) {
          expect(path.id).toBe("remote-session")
          expect(query?.directory).toBe(remoteDirectory)

          return [
            {
              info: {
                id: "remote-message",
                role: "assistant",
                time: { created: 3 },
              },
              parts: [
                {
                  id: "remote-part",
                  type: "text",
                  text: "Cross-directory transcript content",
                },
              ],
            },
          ]
        },
      },
    })

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "remote-session", {})

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected cross-directory session read to succeed")
    }

    expect(result.data.entries[0]?.parts[0]?.text).toContain("Cross-directory transcript")
    expect(globalListCalls).toBe(1)
  })

  test("applies beforeMessageID before limit across parent and child transcript entries", async () => {
    const adapter = new OpenCodeAdapter({
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory: "/tmp/project",
            title: path.id,
            time: { created: 1, updated: 2 },
          }
        },
        async children() {
          return [
            {
              id: "child-session",
              directory: "/tmp/project",
              parentID: "root-session",
              title: "Child Session",
              time: { created: 3, updated: 4 },
            },
          ]
        },
        async messages({ path }: { path: { id: string } }) {
          if (path.id === "root-session") {
            return [
              {
                info: { id: "msg-1", role: "assistant", time: { created: 1 } },
                parts: [{ id: "part-1", type: "text", text: "root-1" }],
              },
              {
                info: { id: "msg-3", role: "assistant", time: { created: 3 } },
                parts: [{ id: "part-3", type: "text", text: "root-3" }],
              },
            ]
          }

          return [
            {
              info: { id: "msg-2", role: "assistant", time: { created: 2 } },
              parts: [{ id: "part-2", type: "text", text: "child-2" }],
            },
            {
              info: { id: "msg-4", role: "assistant", time: { created: 4 } },
              parts: [{ id: "part-4", type: "text", text: "child-4" }],
            },
          ]
        },
      },
    })

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "root-session", {
      beforeMessageID: "msg-4",
      includeChildren: true,
      limit: 2,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected session read with beforeMessageID to succeed")
    }

    expect(result.data.entries.map((entry) => entry.messageID)).toEqual(["msg-2", "msg-3"])
    expect(result.data.includedChildSessionIDs).toEqual(["child-session"])
  })

  test("treats beforeMessageID as a hard boundary even when the cursor message is filtered out", async () => {
    const adapter = new OpenCodeAdapter({
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory: "/tmp/project",
            title: path.id,
            time: { created: 1, updated: 2 },
          }
        },
        async messages() {
          return [
            {
              info: { id: "msg-1", role: "assistant", time: { created: 1 } },
              parts: [{ id: "part-1", type: "text", text: "visible before cursor" }],
            },
            {
              info: { id: "msg-2", role: "assistant", time: { created: 2 } },
              parts: [
                {
                  id: "part-2",
                  type: "tool",
                  tool: "read",
                  state: { output: "tool output boundary" },
                },
              ],
            },
            {
              info: { id: "msg-3", role: "assistant", time: { created: 3 } },
              parts: [{ id: "part-3", type: "text", text: "should not leak past cursor" }],
            },
          ]
        },
      },
    })

    const service = new MissionControlSessionService(new MissionControlRuntimeState(20))
    const result = await service.readSession(adapter, "root-session", {
      beforeMessageID: "msg-2",
      includeToolOutputs: false,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected filtered cursor session read to succeed")
    }

    expect(result.data.entries.map((entry) => entry.messageID)).toEqual(["msg-1"])
  })

  test("uses cached child directories when includeChildren child records omit directory", async () => {
    const state = new MissionControlRuntimeState(20)
    state.recordEvent("session.created", {
      sessionID: "child-session",
      parentID: "root-session",
      directory: "/tmp/child-project",
      title: "Child Session",
      time: { created: 2, updated: 3 },
    })

    const adapter = new OpenCodeAdapter({
      session: {
        async get({ path }: { path: { id: string } }) {
          return {
            id: path.id,
            directory: "/tmp/root-project",
            title: path.id,
            time: { created: 1, updated: 2 },
          }
        },
        async children() {
          return [
            {
              id: "child-session",
              parentID: "root-session",
              title: "Child Session",
            },
          ]
        },
        async messages({ path, query }: { path: { id: string }; query?: { directory?: string } }) {
          if (path.id === "root-session") {
            expect(query?.directory).toBe("/tmp/root-project")
            return [
              {
                info: { id: "root-message", role: "assistant", time: { created: 1 } },
                parts: [{ id: "root-part", type: "text", text: "root" }],
              },
            ]
          }

          expect(path.id).toBe("child-session")
          expect(query?.directory).toBe("/tmp/child-project")
          return [
            {
              info: { id: "child-message", role: "assistant", time: { created: 2 } },
              parts: [{ id: "child-part", type: "text", text: "child" }],
            },
          ]
        },
      },
    })

    const service = new MissionControlSessionService(state)
    const result = await service.readSession(adapter, "root-session", {
      includeChildren: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error("Expected cached-child-directory read to succeed")
    }

    expect(result.data.entries.map((entry) => entry.messageID)).toEqual(["root-message", "child-message"])
  })
})
