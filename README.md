# opencode-mission-control

OpenCode Mission Control adds session-aware retrieval and inspection to OpenCode. It can search transcript content, read sessions, look up session metadata, and message peer subagents.

**Requires a Jina API key** (`search.jinaApiKey` in plugin options). Without a key the plugin registers no tools.

## Install

```bash
opencode plugin -g opencode-mission-control
```

## Tools

Detailed behavior and caveats live under `docs/`.

- [`runtime_model.md`](docs/runtime_model.md) — cross-cutting runtime behavior, lifecycle rules, persistence, and non-goals
- [`session_search({ query, limit? })`](docs/session_search.md) — hybrid semantic+lexical search in the current project
- [`session_search_global({ query, limit? })`](docs/session_search_global.md) — same, across all projects globally
- [`session_read({ sessionId, beforeMessageId?, offset?, limit?, withChildren?, withToolOutputs? })`](docs/session_read.md) — read a transcript with pagination
- [`session_tail({ sessionId, offset?, limit?, withChildren? })`](docs/session_tail.md) — view recent text-only messages
- [`session_find({ title, scope?, limit? })`](docs/session_find.md) — find exact-title metadata candidates
- [`session_get({ sessionId })`](docs/session_get.md) — get normalized metadata for one session ID
- [`session_list({ scope?, start?, search?, limit? })`](docs/session_list.md) — browse and filter sessions
- [`subagent_abort({ sessionId })`](docs/subagent_abort.md) — cancel a session, primarily background subagents
- [`subagent_send_async({ targetSessionId, message })`](docs/subagent_send.md) — queue a message to a peer subagent
- [`subagent_send_interrupt({ targetSessionId, message })`](docs/subagent_send.md) — abort a peer's in-flight response, then deliver a message immediately

## Common patterns

### Search sessions

```text
session_search({ query: "retry logic", limit: 5 })

session_search_global({ query: "deploy pipeline" })
```

Search is always hybrid: FTS5/BM25 lexical + Jina semantic embeddings fused with RRF. Use `session_find` for exact title lookup and `session_get` when you already have a session ID.

### Look up and read sessions

```text
session_find({ title: "Search audit", limit: 5 })

session_get({ sessionId: "ses_123" })

session_list({ search: "CTF", scope: "global" })
```

Read transcript content:

```text
session_read({ sessionId: "ses_123", withToolOutputs: true })

session_tail({ sessionId: "ses_123", limit: 10 })
```

### Peer subagent messaging

```text
subagent_send_async({
  targetSessionId: "ses_peer_456",
  message: "Found shared credential — skip auth step.",
})
```

Only works between sibling subagents (same parent session). To return a result to your calling agent, end your loop — results auto-return to the parent.

## Optional local skills

This plugin does **not** install native OpenCode skills automatically. If you want reusable local skills for your workspace, ask OpenCode to generate them from these docs:

- `@docs/session_search.md`
- `@docs/session_get.md`
- `@docs/session_find.md`
- `@docs/session_read.md`
- `@docs/runtime_model.md`
