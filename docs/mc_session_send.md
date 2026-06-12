# `mc_session_send_async` / `mc_session_send_interrupt`

Sends a message from one OpenCode session into another running session by session ID.

There are two distinct tools, not a mode switch:

- `mc_session_send_async` queues the message without blocking the target.
- `mc_session_send_interrupt` aborts the target's in-flight response first, then queues the message.

## Call

```text
mc_session_send_async({ targetSessionId, message })
mc_session_send_interrupt({ targetSessionId, message })
```

## Arguments

- `targetSessionId` — required OpenCode session ID to deliver the message to
- `message` — required message text to deliver to the target session

The sender session ID is taken from the tool execution context and does not need to be passed explicitly.

## Examples

```text
mc_session_send_async({
  targetSessionId: "ses_subagent_123",
  message: "Skip the auth refactor; the parent already handled it.",
})

mc_session_send_interrupt({
  targetSessionId: "ses_subagent_123",
  message: "Stop the current run and re-read the updated spec before continuing.",
})
```

## What it returns

- `ok: true` when the OpenCode delivery request was accepted by the runtime client
- `data.targetSessionId` for the requested target session
- `data.fromSessionId` for the sender session, when the execution context exposes one
- `data.delivery` is `"async"` or `"interrupt"` depending on the tool used
- `data.requestAccepted: true`
- `data.aborted` (interrupt only) when OpenCode returns a boolean abort result
- `data.note` describing the delivery semantics

## Delivery semantics

- Both tools deliver through OpenCode's public `POST /session/{sessionID}/prompt_async` API. This creates a real, reply-generating user message and returns immediately.
- OpenCode serializes one runner per session: a queued prompt is processed at the next loop boundary, not mid-token.
  - `async` means queue only. The target picks the message up at its next loop boundary.
  - `interrupt` aborts first, then queues, so the message is acted on immediately because aborting frees the runner.
- `mc_session_send_interrupt` interrupts any in-flight generation or tool call on the target.

## Child/subagent session guard

- Mission Control refuses to deliver `mc_session_send_*` prompts directly to child/subagent sessions.
- Why: `prompt_async` creates a real user message, and prompting a child session can bounce back into orchestration or trigger manager relaunch loops.
- If you need to stop a child/subagent, use `mc_session_abort({ sessionId })`.
- If you need to influence orchestration, send the message to the parent session intentionally instead.

## Inter-agent message envelope

The delivered message is wrapped so the target can attribute it to the sender:

```text
<inter_agent_message from="ses_sender_123">
the message text
</inter_agent_message>
```

When the sender session ID is unknown, `from="unknown"` is used.

## Reading the reply

These tools do not return the target's reply. Pair them with `mc_session_tail({ sessionId: targetSessionId })` to read what the target produced after processing the message.

## Caveats

- Delivery only confirms the prompt was accepted by the runtime; it does not confirm the target acted on it.
- Child/subagent targets are rejected with `SubagentPromptRejected` before any prompt or abort request is sent.
- If the current runtime cannot discover the target session scope, these tools return `GlobalSessionDiscoveryUnavailable`.
- A failed delivery returns `SessionLookupUnavailable`; an unknown target returns `SessionNotFound`.
- Mission Control does not mutate OpenCode storage directly; it only sends the public prompt (and, for interrupt, the public abort) request.
