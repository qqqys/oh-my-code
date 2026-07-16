# Oh My Code

Oh My Code is an open-source, repository-aware code agent CLI for macOS and Linux. It is designed around a polished terminal interface, explicit tool permissions, durable sessions, verifiable coding loops, and Dynamic Workflow orchestration.

The repository is currently at its foundation milestone. Product work is organized as small, independently deliverable GitHub Issues, beginning with the first branded TUI slice.

## Requirements

- Node.js 22 or newer
- npm
- tmux for integration and terminal E2E verification

## Development

```bash
make install
make build
make typecheck
make unit
make integration
make smoke
```

The six Make targets are the stable verification contract used locally, in CI, and by the autonomous development runtime.

## Delivery contract

Every behavior-changing pull request must link an agent-ready Issue, keep the branch focused, pass the six verification targets, and publish tmux E2E evidence bound to the exact PR head commit. Required evidence consists of a timeline, a plain transcript, the ANSI terminal capture, a readable terminal image, and a report containing the tested commit SHA.

Generated evidence is published separately so product branches remain clean.

## Security

The default experience is repository-bounded and approval-driven. Autonomous execution must be enabled explicitly. See [SECURITY.md](SECURITY.md) for reporting guidance.
