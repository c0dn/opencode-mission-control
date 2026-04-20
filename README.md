# opencode-mission-control

OpenCode Mission Control adds session-aware retrieval and lightweight orchestration to OpenCode. It can read transcripts, inspect session trees, observe recent session activity, search indexed session content, and launch attached background jobs as child sessions under a parent session. Lexical search works out of the box, semantic search is optional, and background jobs stay attached to the current OpenCode runtime.

## Install

```bash
opencode plugin -g opencode-mission-control
```

## Tools

Detailed usage and caveats live under `docs/`.

- [`mission_control_status()`](docs/mission_control_status.md) — runtime health, config, counters, and capability probe
- [`mission_control_session_read(sessionID, limit?, includeChildren?, includeToolOutputs?)`](docs/mission_control_session_read.md) — read a transcript, optionally including child sessions and raw tool outputs
- [`mission_control_session_tree(sessionID, depth?)`](docs/mission_control_session_tree.md) — inspect a session’s parent/child tree
- [`mission_control_session_observe(sessionID, includeChildren?, eventLimit?)`](docs/mission_control_session_observe.md) — view recent live events and current status
- [`mission_control_session_search(query, sessionID?, global?, exact?, limit?)`](docs/mission_control_session_search.md) — search indexed session content; `global=true` widens scope, `exact=true` forces lexical matching
- [`mission_control_job_start(title, prompt, parentSessionID?, attach?, relayToParent?)`](docs/mission_control_job_start.md) — launch an attached background child-session job
- [`mission_control_job_status(jobID)`](docs/mission_control_job_status.md) — inspect one tracked job
- [`mission_control_job_list(parentSessionID?, state?, limit?)`](docs/mission_control_job_list.md) — list tracked jobs with optional filters
- [`mission_control_job_result(jobID, relayToParent?)`](docs/mission_control_job_result.md) — fetch the latest stable result snapshot for a job
- [`mission_control_job_cancel(jobID)`](docs/mission_control_job_cancel.md) — abort a running tracked job
