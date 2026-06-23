# mission control opencode plugin

OpenCode plugin for session intelligence, transcript inspection, and indexed search.

## Role

You are helping develop and maintain this OpenCode plugin. Work from local
evidence first, make focused changes, and verify the result with the most
relevant affordable checks.

## Primary Agents

| Agent | Role | When to Use |
|-------|------|-------------|
| `@plan` | Strategy and blueprints | Plan non-trivial changes before implementation. Map the problem, scope, files, and validation. |
| `@build` | Universal implementation | Implement the plan. Edit code, run tests, validate changes. Owns the full change. |
| `@code-vet` | Code review | Review meaningful diffs for bugs, risk, and complexity. |
| `@explore` | Context finder | Map unfamiliar areas, locate files, identify entry points. |
| `@architecture-cartographer` | Codebase mapper | Deeply map module boundaries, runtime/data flow, integrations. |

## Recommended Workflow

1. When files, entry points, or structure are unclear — `@explore` first.
2. For non-trivial changes — `@plan` produces a blueprint.
3. `@build` implements the blueprint. One agent, one change.
4. `@code-vet` reviews the result.
5. Prefer the smallest correct change over opportunistic cleanup.
6. Run the most relevant validation after changes.

## Key Files

| File/Directory | Purpose |
| --- | --- |
| `package.json` | Package metadata, scripts, dependencies |
| `src/` | TypeScript source (25 modules) |
| `src/plugin.ts` | Plugin wiring and lifecycle |
| `src/server.ts` | Server/session tool registration |
| `src/session-service.ts` | Core session query and search logic |
| `src/tools.ts` | Tool definitions |
| `src/types.ts` | Shared type definitions |
| `src/config.ts` | Plugin configuration |
| `src/search.ts` | Search functionality |
| `src/index-db/` | Indexed session storage |
| `src/session-extractors/` | Session content extraction |
| `src/storage/` | Storage backends |
| `src/opencode/` | OpenCode client integration |
| `tests/` | Bun test suites (11 test files) |
| `docs/` | Tool docs and runtime model |
| `docs/runtime_model.md` | Runtime rules and behavior |
| `dist/` | Build output |

## Bash Commands

```bash
bun install         # Install dependencies
bun test            # Run test suite
bun run typecheck   # TypeScript type checking
bun run build       # Build plugin (bunx tsc)
opencode plugin -g opencode-mission-control  # Register plugin locally
```

## Conventions

- ESM TypeScript; source in `src/`, build output in `dist/`.
- Tests use Bun's test runner in `tests/*.test.ts`.
- Prefer `docs/runtime_model.md` and `docs/*.md` as source of truth for runtime behavior.
- Use `@opencode-ai/plugin` for plugin types and hooks.
- Keep changes small and verify with the most relevant affordable checks.
- Prefer targeted tests first, then broader checks if needed.
