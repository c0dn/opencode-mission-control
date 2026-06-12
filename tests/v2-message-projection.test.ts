import { describe, expect, test } from "bun:test"

import { buildSessionChunks } from "../src/normalize.js"
import { normalizeMessage } from "../src/session-extractors.js"
import { projectV2Message } from "../src/opencode/v2-message-projection.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeUser = (overrides?: object) => ({
  id: "msg-user-1",
  type: "user",
  time: { created: 1000 },
  text: "hello from user",
  ...overrides,
})

const makeSynthetic = (overrides?: object) => ({
  id: "msg-synth-1",
  type: "synthetic",
  time: { created: 1001 },
  sessionID: "ses_abc",
  text: "synthetic notification",
  ...overrides,
})

const makeAssistant = (overrides?: object) => ({
  id: "msg-asst-1",
  type: "assistant",
  time: { created: 1002 },
  agent: "claude-sonnet",
  content: [
    { type: "text", text: "Here is my answer." },
    { id: "rsn-1", type: "reasoning", text: "I thought about it." },
    {
      id: "tool-1",
      type: "tool",
      name: "mc_status",
      state: {
        status: "completed",
        content: [{ type: "text", text: "tool output line 1" }, { type: "text", text: "tool output line 2" }],
        input: {},
        structured: {},
      },
    },
  ],
  ...overrides,
})

const makeShell = (overrides?: object) => ({
  id: "msg-shell-1",
  type: "shell",
  time: { created: 1003 },
  callID: "call-42",
  command: "ls -la",
  output: "total 0\n-rw-r--r-- 1 user user 0 file.txt",
  ...overrides,
})

const makeCompaction = (overrides?: object) => ({
  id: "msg-comp-1",
  type: "compaction",
  time: { created: 1004 },
  reason: "manual",
  summary: "We built a plugin with V2 session support.",
  ...overrides,
})

const makeAgentSwitched = (overrides?: object) => ({
  id: "msg-ag-sw-1",
  type: "agent-switched",
  time: { created: 1005 },
  agent: "gpt-4o",
  ...overrides,
})

const makeModelSwitched = (overrides?: object) => ({
  id: "msg-mdl-sw-1",
  type: "model-switched",
  time: { created: 1006 },
  model: { id: "claude-opus-4", providerID: "anthropic", variant: "default" },
  ...overrides,
})

// ---------------------------------------------------------------------------
// Projection — shape assertions
// ---------------------------------------------------------------------------

describe("projectV2Message", () => {
  test("user → role:user, single text part", () => {
    const projected = projectV2Message(makeUser())
    expect(projected.info.role).toBe("user")
    expect(projected.info.id).toBe("msg-user-1")
    expect(projected.info.time.created).toBe(1000)
    expect(projected.parts).toHaveLength(1)
    expect(projected.parts[0]).toMatchObject({ type: "text", text: "hello from user" })
  })

  test("synthetic → role:user, single text part", () => {
    const projected = projectV2Message(makeSynthetic())
    expect(projected.info.role).toBe("user")
    expect(projected.parts[0]).toMatchObject({ type: "text", text: "synthetic notification" })
  })

  test("assistant → role:assistant with agent, maps text/reasoning/tool content", () => {
    const projected = projectV2Message(makeAssistant())
    expect(projected.info.role).toBe("assistant")
    expect(projected.info.agent).toBe("claude-sonnet")
    expect(projected.parts).toHaveLength(3)
    expect(projected.parts[0]).toMatchObject({ type: "text", text: "Here is my answer." })
    expect(projected.parts[1]).toMatchObject({ id: "rsn-1", type: "reasoning", text: "I thought about it." })
    expect(projected.parts[2]).toMatchObject({
      id: "tool-1",
      type: "tool",
      toolName: "mc_status",
      state: { status: "completed", output: "tool output line 1\ntool output line 2" },
    })
  })

  test("assistant tool with error state preserves error message", () => {
    const item = makeAssistant({
      content: [
        {
          id: "tool-err",
          type: "tool",
          name: "bash",
          state: {
            status: "error",
            content: [],
            input: {},
            structured: {},
            error: { message: "command not found", _tag: "UnknownError" },
          },
        },
      ],
    })
    const projected = projectV2Message(item)
    expect(projected.parts[0]?.state?.error).toBe("command not found")
    expect(projected.parts[0]?.state?.status).toBe("error")
  })

  test("shell → role:assistant, tool part with joined command+output", () => {
    const projected = projectV2Message(makeShell())
    expect(projected.info.role).toBe("assistant")
    expect(projected.parts).toHaveLength(1)
    expect(projected.parts[0]).toMatchObject({
      id: "call-42",
      type: "tool",
      toolName: "shell",
      state: { status: "completed", output: "ls -la\ntotal 0\n-rw-r--r-- 1 user user 0 file.txt" },
    })
  })

  test("compaction → role:system, compaction part with summary text", () => {
    const projected = projectV2Message(makeCompaction())
    expect(projected.info.role).toBe("system")
    expect(projected.parts[0]).toMatchObject({
      id: "msg-comp-1",
      type: "compaction",
      text: "We built a plugin with V2 session support.",
    })
  })

  test("agent-switched → role:system, agent-switched part with agent name", () => {
    const projected = projectV2Message(makeAgentSwitched())
    expect(projected.info.role).toBe("system")
    expect(projected.parts[0]).toMatchObject({ id: "msg-ag-sw-1", type: "agent-switched", text: "gpt-4o" })
  })

  test("model-switched → role:system, model-switched part with model id", () => {
    const projected = projectV2Message(makeModelSwitched())
    expect(projected.info.role).toBe("system")
    expect(projected.parts[0]).toMatchObject({ id: "msg-mdl-sw-1", type: "model-switched", text: "claude-opus-4" })
  })

  test("unknown type → role:unknown, empty parts", () => {
    const projected = projectV2Message({ id: "x", type: "future-unknown", time: { created: 0 } })
    expect(projected.info.role).toBe("unknown")
    expect(projected.parts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Round-trip: projectV2Message → normalizeMessage
// ---------------------------------------------------------------------------

describe("projectV2Message → normalizeMessage round-trip", () => {
  test("user message survives normalizeMessage", () => {
    const projected = projectV2Message(makeUser())
    const entry = normalizeMessage("ses_1", projected, false)
    expect(entry).toBeDefined()
    expect(entry!.role).toBe("user")
    expect(entry!.parts[0]?.text).toBe("hello from user")
  })

  test("assistant text+reasoning survives normalizeMessage", () => {
    const projected = projectV2Message(makeAssistant())
    const entry = normalizeMessage("ses_1", projected, false)
    expect(entry).toBeDefined()
    // tool parts excluded when includeToolOutputs=false
    const types = entry!.parts.map((p) => p.type)
    expect(types).toContain("text")
    expect(types).toContain("reasoning")
    expect(types).not.toContain("tool")
  })

  test("assistant message with tool survives normalizeMessage with includeToolOutputs=true", () => {
    const projected = projectV2Message(makeAssistant())
    const entry = normalizeMessage("ses_1", projected, true)
    expect(entry!.parts.map((p) => p.type)).toContain("tool")
  })

  test("compaction survives normalizeMessage with compaction partType", () => {
    const projected = projectV2Message(makeCompaction())
    const entry = normalizeMessage("ses_1", projected, false)
    expect(entry).toBeDefined()
    expect(entry!.parts[0]?.type).toBe("compaction")
    expect(entry!.parts[0]?.text).toBe("We built a plugin with V2 session support.")
  })

  test("agent-switched survives normalizeMessage with agent-switched partType", () => {
    const projected = projectV2Message(makeAgentSwitched())
    const entry = normalizeMessage("ses_1", projected, false)
    expect(entry).toBeDefined()
    expect(entry!.parts[0]?.type).toBe("agent-switched")
  })

  test("model-switched survives normalizeMessage with model-switched partType", () => {
    const projected = projectV2Message(makeModelSwitched())
    const entry = normalizeMessage("ses_1", projected, false)
    expect(entry).toBeDefined()
    expect(entry!.parts[0]?.type).toBe("model-switched")
  })

  test("agent-switched and model-switched are dropped when message has no text parts (empty assistant)", () => {
    // Switch events with empty text are dropped — normalizeMessage requires at least one part with text
    const item = { id: "x", type: "agent-switched", time: { created: 0 }, agent: "" }
    const projected = projectV2Message(item)
    const entry = normalizeMessage("ses_1", projected, false)
    // empty text → part is dropped → no entry
    expect(entry).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Round-trip: projectV2Message → normalizeMessage → buildSessionChunks
// ---------------------------------------------------------------------------

describe("projectV2Message → buildSessionChunks chunk IDs", () => {
  test("tool and reasoning parts use V2 content IDs as chunkID", () => {
    const sessionRecord = {
      sessionID: "ses_1",
      title: "Test",
      createdAt: 0,
      updatedAt: 0,
    } as any

    const projected = projectV2Message(makeAssistant())
    const entry = normalizeMessage("ses_1", projected, true)!
    const chunks = buildSessionChunks([sessionRecord], [entry])

    const toolChunk = chunks.find((c) => c.partType === "tool")
    expect(toolChunk?.chunkID).toBe("tool-1")

    const reasoningChunk = chunks.find((c) => c.partType === "reasoning")
    expect(reasoningChunk?.chunkID).toBe("rsn-1")
  })

  test("text part without id uses positional fallback chunkID", () => {
    const sessionRecord = { sessionID: "ses_1", title: "Test", createdAt: 0, updatedAt: 0 } as any
    const projected = projectV2Message(makeUser())
    const entry = normalizeMessage("ses_1", projected, false)!
    const chunks = buildSessionChunks([sessionRecord], [entry])

    // No explicit part id → fallback: sessionId:messageId:index
    expect(chunks[0]?.chunkID).toBe("ses_1:msg-user-1:0")
  })

  test("compaction chunk has compaction partType", () => {
    const sessionRecord = { sessionID: "ses_1", title: "Test", createdAt: 0, updatedAt: 0 } as any
    const projected = projectV2Message(makeCompaction())
    const entry = normalizeMessage("ses_1", projected, false)!
    const chunks = buildSessionChunks([sessionRecord], [entry])

    expect(chunks[0]?.partType).toBe("compaction")
    expect(chunks[0]?.chunkID).toBe("msg-comp-1")
    expect(chunks[0]?.role).toBe("system")
  })
})
