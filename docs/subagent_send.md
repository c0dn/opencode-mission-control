# `subagent_send_async` / `subagent_send_interrupt`

Sends a message from the current subagent to a **peer subagent** (a sibling with the same parent session).

There are two distinct tools:

- `subagent_send_async` queues the message without interrupting the peer.
- `subagent_send_interrupt` aborts the peer's in-flight response first, then queues the message for immediate pickup.

## Call

```text
subagent_send_async({ targetSessionId, message })
subagent_send_interrupt({ targetSessionId, message })
```

## Arguments

- `targetSessionId` — required session ID of the peer subagent to message
- `message` — required message text

The sender session ID is taken from the tool execution context automatically.

## Examples

```text
subagent_send_async({
  targetSessionId: "ses_peer_456",
  message: "Found a shared credential — skip the auth step, already handled.",
})

subagent_send_interrupt({
  targetSessionId: "ses_peer_456",
  message: "Stop — the spec changed. Re-read it before continuing.",
})
```

## Delivery semantics

- Both tools deliver through OpenCode's public `POST /session/{sessionID}/prompt_async` API.
- The queued prompt is processed at the next loop boundary, not mid-token.
- `async` — queue only; peer picks it up at its next idle boundary.
- `interrupt` — abort first, then queue, so the peer acts on it immediately.

## Peer-only guard

These tools only deliver to **peer subagents** (sessions that share the same parent as the sender):

- ✅ Allowed: sender and target are siblings (same parent session)
- ❌ Rejected: target is the sender's own calling/parent session — **end your loop instead**; results auto-return to the parent automatically
- ❌ Rejected: target is unrelated (different orchestration tree)

To stop a peer rather than message it, use `subagent_abort({ sessionId })`.

## Inter-agent message envelope

The message is wrapped so the peer can attribute it to the sender:

```text
<inter_agent_message from="ses_sender_123">
the message text
</inter_agent_message>
```

## Reading the reply

These tools do not return the peer's reply. Pair with `session_tail({ sessionId: targetSessionId })` to read what the peer produced after processing the message.

## Caveats

- Delivery confirms the prompt was accepted; it does not confirm the peer acted on it.
- Non-peer targets return `SubagentPromptRejected`.
- Unknown targets return `SessionNotFound`.
- A failed delivery returns `SessionLookupUnavailable`.
