# Oh My Code — Autonomous Code Agent CLI

## 1. Product goal

Build a production-grade, open-source code-agent command-line product from zero. The product runs inside a user's repository, understands natural-language engineering tasks, inspects and edits code through explicit tools, verifies its work, and leaves an auditable execution trail.

The first release must be genuinely usable for small repository tasks while preserving a path toward long-running autonomous development. It must not be a thin wrapper around another agent CLI.

## 2. Target users

- Individual developers who want an interactive terminal coding assistant.
- Maintainers who need reviewable, reproducible repository changes.
- Automation operators who need durable, non-interactive task execution.
- Teams integrating their own model endpoints and MCP-compatible tools.

## 3. Required product capabilities

### CLI and terminal experience

- Cross-platform Node.js CLI with a documented installation path and `oh-my-code` executable.
- Interactive terminal UI with streamed assistant output, tool activity, progress, errors, cancellation, and a concise final summary.
- Non-interactive command mode suitable for scripts and CI.
- Helpful `--help`, version output, configuration diagnostics, and machine-readable JSON output where appropriate.

### Agent execution

- Repository discovery and bounded context collection.
- A tool loop that can read, search, patch, create, and verify files; run approved commands; and inspect Git state.
- Explicit tool schemas, deterministic tool results, timeouts, output limits, and secret redaction.
- Clear completion, failure, cancellation, and blocked states.
- Iterative verification using repository-native tests, lint, build, and typecheck commands.

### Safety and governance

- Approval modes including a safe interactive default and an explicit autonomous/yolo mode.
- Workspace boundary enforcement and protection against accidental writes outside the selected repository.
- No silent destructive Git operations, force pushes, secret disclosure, or permission escalation.
- Auditable event records for prompts, model turns, tool calls, file changes, verification, and final outcome.

### Sessions and durability

- Persisted sessions that can be listed, inspected, resumed, and cleanly terminated.
- Crash-safe checkpoints and recovery without replaying already completed mutations.
- A durable task mode capable of continuing a bounded engineering objective across multiple turns.
- Concurrency protection so two sessions cannot unknowingly mutate the same workspace.

### Models and extensibility

- Provider-neutral model interface with at least one OpenAI-compatible endpoint implementation.
- Streaming responses, tool calls, retry classification, timeouts, and configurable model selection.
- Environment-based secret loading without writing credentials into repositories or logs.
- MCP-compatible external tool integration with validation and discoverable configuration.
- Repository-level instructions and reusable skill/prompt loading.

### Git and delivery workflow

- Git-aware status and diff summaries.
- Branch-safe edits and conventional commit assistance without committing unless authorized.
- A review mode that explains changed behavior, verification evidence, and remaining risks.
- Terminal E2E evidence suitable for attaching to pull requests.

## 4. Architecture expectations

- TypeScript on Node.js 22 or newer.
- Separate domain boundaries for CLI/TUI, agent orchestration, model providers, tool execution, session persistence, configuration, and Git integration.
- Strict types and explicit interfaces at external boundaries.
- Local-first persistence using transparent, inspectable formats; introduce a database only when justified by demonstrated needs.
- Minimal dependencies and no speculative distributed architecture.

## 5. Quality contract

The repository must expose these stable commands through a tracked Makefile:

- `make install`
- `make build`
- `make typecheck`
- `make unit`
- `make integration`
- `make smoke`

Every behavior-changing pull request must include focused tests and terminal E2E evidence bound to the exact pushed PR head. A pull request must not merge when its required checks or E2E evidence fail.

## 6. Incremental roadmap

1. Bootstrap a distributable CLI with configuration, logging, and test infrastructure.
2. Deliver a read-only repository assistant with streaming output and search/read tools.
3. Add patch-based file mutation with approval and workspace boundaries.
4. Add command execution, verification policies, cancellation, and output limits.
5. Add persistent/resumable sessions and durable task checkpoints.
6. Add provider configuration and MCP tool integration.
7. Add Git-aware review and terminal E2E evidence.
8. Dogfood the CLI on its own repository, create bot-authored issues from observed failures, and iterate.

Each roadmap item must be decomposed into agent-ready vertical slices. Prefer small end-to-end capabilities over large horizontal framework work.

## 7. Acceptance criteria for the first usable release

- A clean machine with Node.js 22 can install and run `oh-my-code --help`.
- A user can open a small Git repository, ask a question, and receive a streamed answer grounded in repository files.
- With explicit approval, the agent can implement a small change, show the diff, run relevant verification, and summarize the result.
- A denied tool request does not mutate the repository.
- A killed session can resume from its last durable checkpoint without duplicating a completed mutation.
- Secrets are redacted from logs, event records, and E2E evidence.
- Unit, integration, smoke, typecheck, and build gates pass from documented commands.
- The product can dogfood at least one issue in its own repository through a branch and pull-request workflow.

## 8. Non-goals for the initial release

- IDE GUI extensions.
- A hosted multi-tenant control plane.
- Autonomous production deployment.
- Unbounded shell access by default.
- Copying another product's source, branding, private prompts, or proprietary protocol.
