# Zellij terminal tools

Mission Control exposes a small Zellij-backed terminal surface for running and inspecting commands from an owning OpenCode session.

## Tools

- `mc_terminal_start` creates or reuses a background Zellij session for `sessionId`, opens a pane, and runs a command.
- `mc_terminal_list` lists plugin-known terminals, optionally filtered by `sessionId` and `status`.
- `mc_terminal_get` returns one terminal record plus a short output preview.
- `mc_terminal_read` returns full scrollback using `offset` / `limit` paging.
- `mc_terminal_send` writes literal text and/or simple key chords such as `Ctrl c`, `Enter`, `Tab`, or `Esc`.
- `mc_terminal_cancel` sends `Ctrl-C` by default and preserves the pane/scrollback unless `closePane` is explicitly true.

## Start example

```text
mc_terminal_start({
  sessionId: "ses_123",
  command: ["bun", "test"],
  cwd: "/path/to/project",
  title: "tests"
})
```

Prefer `command` argv arrays. Use `commandString` only when shell behavior is intentional.

The result includes:

- Mission Control terminal id
- Zellij session name
- session-local Zellij pane id
- `followCommand`, for example `zellij attach mc-ses_123`
- current status

## Runtime behavior

- Zellij is the terminal backend. Mission Control invokes the `zellij` CLI and does not own long-running terminal processes itself.
- Terminal state is kept in memory by the plugin runtime.
- Known terminals are polled for bounded completion detection. Completion, cancellation, and error states trigger a best-effort synthetic text notification in the owning OpenCode session.
- Panes are always addressed with both Zellij session name and pane id internally because pane ids are session-local.
