# Implementation instructions

Build Oh My Code as a real, independently designed product. Use competitor research to learn product expectations, not to copy source code, branding, private prompts, or undocumented proprietary behavior.

Work through small vertical slices. Each slice must leave the repository buildable and testable, include user-visible acceptance criteria, and produce a focused commit. Avoid empty scaffolding commits, speculative abstractions, and fake tests.

Start with the smallest tracer bullet: an installable CLI that accepts one prompt, calls a configurable OpenAI-compatible model, streams the response, and can read a file through a validated read-only tool. Expand mutation, command execution, sessions, MCP, Git workflows, and autonomy only after the preceding slice is verified.

Keep the default experience safe. Autonomous/yolo behavior must require explicit configuration. Treat repository boundaries, command approvals, secret redaction, durable idempotency, and cancellation as product behavior, not documentation-only promises.

Use Node.js 22+, TypeScript strict mode, deterministic tests, and a tracked Makefile implementing all six product contract targets. CLI E2E verification must run in a real tmux session and publish evidence for the exact PR head. Do not merge without green checks and a valid PASS receipt.

Continuously dogfood the current CLI against its own repository. Record real failures and usability gaps as bot-authored issues, decompose them into agent-ready subtasks, and resolve them through the normal branch, PR, review, E2E, merge, and post-merge dogfood lifecycle.
