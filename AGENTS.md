# AGENTS.md

## Product

Oh My Code is a Node.js 22 and TypeScript code-agent CLI for macOS and Linux. It combines a polished terminal UI, repository-aware coding tools, durable sessions, and Dynamic Workflow orchestration.

## Working principles

- Build the smallest complete vertical slice for the selected Issue.
- Keep safe interactive defaults. Autonomous behavior must be explicit.
- Preserve unrelated user changes and never use destructive Git operations.
- Keep credentials out of repositories, logs, transcripts, screenshots, and diagnostic artifacts.
- Prefer strict types, transparent local state, and minimal dependencies.
- Do not add speculative abstractions or future features outside the active Issue.

## Autonomous Issue policy

- Only implement open Issues authored by `qwen-code-dev-bot` and labeled `agent-ready`.
- Never implement an Issue labeled `roadmap` directly.
- Respect the Issue's `Blocked by` section; all listed blockers must be closed before selection.
- Work on one Issue per mutation lease and one focused branch per Issue.
- Use conventional commits and link the Issue from the pull request.
- Do not close Issues manually. Let the normal merged pull-request lifecycle close them.

## Verification contract

All six commands must remain stable:

```bash
make install
make build
make typecheck
make unit
make integration
make smoke
```

Every behavior-changing pull request requires focused tests and tmux E2E evidence from its exact head commit:

- `timeline.json`
- `transcript.txt`
- `terminal.ansi`
- `terminal.png`
- a PASS report with commit SHA, scenario, commands, and assertions

Evidence belongs on the dedicated evidence ref, not the product branch. Never bypass a missing or failed evidence receipt.

## Code conventions

- ESM modules and TypeScript strict mode.
- Two-space indentation, single quotes, and semicolons.
- Source under `src/`; tests are collocated or under `test/` when they exercise the packaged CLI.
- Comments explain non-obvious reasons, not obvious mechanics.
- Each commit must leave the repository buildable and its focused tests passing.
