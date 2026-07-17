#!/usr/bin/env node

const major = Number(process.versions.node.split('.')[0] ?? 0);
if (major < 22) {
  process.stderr.write(
    `oh-my-code requires Node.js 22 or later. Current: ${process.versions.node}\n`,
  );
  process.exit(1);
}

import { run, VERSION } from './app.js';
import {
  deleteSession,
  formatSession,
  listSessions,
  loadSession,
  SessionError,
} from './session.js';
import { launchTui } from './tui.js';

const args = process.argv.slice(2);

// List, inspect, resume, and delete durable sessions. Resume relaunches the
// interactive terminal seeded from the stored transcript.
async function runSessions(rest: readonly string[]): Promise<void> {
  const sub = rest[0] ?? 'list';
  const workspace = process.cwd();

  if (sub === 'list') {
    const summaries = listSessions(workspace);
    if (summaries.length === 0) {
      process.stdout.write('No sessions found.\n');
      return;
    }
    for (const summary of summaries) {
      const state = summary.readable
        ? `turns: ${summary.turns}  messages: ${summary.messages}  updated: ${summary.updatedAt}`
        : 'unreadable (delete to recover)';
      process.stdout.write(`${summary.id}  ${state}\n`);
    }
    return;
  }

  if (sub === 'show') {
    const id = rest[1];
    if (id === undefined) {
      process.stderr.write('Usage: oh-my-code sessions show <id>\n');
      process.exitCode = 2;
      return;
    }
    try {
      process.stdout.write(formatSession(loadSession(workspace, id)));
    } catch (error) {
      process.stderr.write(`${error instanceof SessionError ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === 'delete') {
    const id = rest[1];
    if (id === undefined) {
      process.stderr.write('Usage: oh-my-code sessions delete <id>\n');
      process.exitCode = 2;
      return;
    }
    try {
      const deleted = deleteSession(workspace, id);
      process.stdout.write(deleted ? `Deleted session ${id}.\n` : `Session ${id} not found.\n`);
      process.exitCode = deleted ? 0 : 1;
    } catch (error) {
      process.stderr.write(`${error instanceof SessionError ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
    return;
  }

  if (sub === 'resume') {
    const id = rest[1];
    if (id === undefined) {
      process.stderr.write('Usage: oh-my-code sessions resume <id>\n');
      process.exitCode = 2;
      return;
    }
    if (!process.stdout.isTTY) {
      process.stderr.write('Cannot resume a session without an interactive terminal.\n');
      process.exitCode = 2;
      return;
    }
    await launchTui({ version: VERSION, sessionId: id, resume: true });
    return;
  }

  process.stderr.write(`Unknown sessions command: ${sub}\n`);
  process.stderr.write('Usage: oh-my-code sessions [list | show <id> | resume <id> | delete <id>]\n');
  process.exitCode = 2;
}

if (args[0] === 'sessions') {
  await runSessions(args.slice(1));
} else if (args.length === 0 && process.stdout.isTTY) {
  await launchTui({ version: VERSION });
} else {
  const result = run(args);
  const stream = result.code === 0 ? process.stdout : process.stderr;
  stream.write(`${result.output}\n`);
  process.exitCode = result.code;
}
