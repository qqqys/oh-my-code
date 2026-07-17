import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'oh-my-code-integration-'));
const socket = join(temporaryDirectory, 'tmux.sock');
const session = `oh-my-code-${process.pid}`;
const cli = resolve('dist/cli.js');
const nodeBin = process.execPath;

// A throwaway file the edit turns act on. It lives in the workspace so the edit
// tool accepts it, and is removed in the finally block so the tree stays clean.
const fixturePath = resolve('omc-e2e-fixture.txt');
const fixtureOriginal = 'alpha\nbeta\ngamma\n';

// A multi-package repository the context turn inspects. It is its own Git repo
// (nested inside the workspace) so repository-context discovery can report
// uncommitted and untracked work without touching the outer repo. Removed in the
// finally block.
const repoFixturePath = resolve('omc-e2e-repo');

function buildRepoFixture() {
  rmSync(repoFixturePath, { recursive: true, force: true });
  mkdirSync(join(repoFixturePath, 'packages', 'api'), { recursive: true });
  mkdirSync(join(repoFixturePath, 'packages', 'web'), { recursive: true });
  writeFileSync(join(repoFixturePath, 'AGENTS.md'), '# Fixture repository guidance\n');
  writeFileSync(join(repoFixturePath, 'packages', 'api', 'AGENTS.md'), '# API package guidance\n');
  writeFileSync(
    join(repoFixturePath, 'package.json'),
    JSON.stringify({ name: 'fixture-root', scripts: { build: 'tsc', test: 'vitest run' } }) + '\n',
  );
  writeFileSync(
    join(repoFixturePath, 'packages', 'api', 'package.json'),
    JSON.stringify({ name: 'api', scripts: { test: 'vitest run' } }) + '\n',
  );
  writeFileSync(
    join(repoFixturePath, 'packages', 'web', 'package.json'),
    JSON.stringify({ name: 'web', scripts: { build: 'tsc', test: 'vitest run' } }) + '\n',
  );
  writeFileSync(
    join(repoFixturePath, 'Makefile'),
    'build:\n\ttsc\nunit:\n\tvitest run\nintegration:\n\tnode scripts/integration.mjs\n',
  );
  writeFileSync(join(repoFixturePath, 'tsconfig.json'), '{}\n');
  writeFileSync(join(repoFixturePath, 'packages', 'api', 'tracked.txt'), 'original\n');

  function git(...args) {
    return spawnSync('git', ['-C', repoFixturePath, ...args], { encoding: 'utf8' });
  }
  if (git('init').status !== 0) throw new Error('fixture git init failed');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E Bot');
  git('add', '.');
  const commit = git('commit', '-m', 'fixture initial');
  if (commit.status !== 0) throw new Error('fixture commit failed: ' + commit.stderr);

  // Leave uncommitted (modified) tracked work and a new untracked file so the
  // context summary has real Git state to report.
  writeFileSync(join(repoFixturePath, 'packages', 'api', 'tracked.txt'), 'changed\n');
  writeFileSync(join(repoFixturePath, 'notes.txt'), 'untracked work\n');
}

function tmux(...args) {
  return spawnSync('tmux', ['-S', socket, ...args], {
    encoding: 'utf8',
  });
}

function capturePane() {
  // Capture only the visible pane (not scrollback) so stale frames from the
  // full-screen TUI redraw do not produce false-positive matches.
  const captured = tmux('capture-pane', '-p', '-t', session);
  if (captured.status !== 0) {
    throw new Error(captured.stderr || 'Failed to capture tmux pane');
  }
  return captured.stdout;
}

function sendKeys(...keys) {
  for (const key of keys) {
    const result = tmux('send-keys', '-t', session, key);
    if (result.status !== 0) {
      throw new Error(result.stderr || `Failed to send key: ${key}`);
    }
  }
}

function waitForContent(expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = capturePane();
    if (content.includes(expected)) {
      return content;
    }
    spawnSync('sleep', ['0.25']);
  }
  throw new Error(`Timed out waiting for content: ${expected}`);
}

try {
  // Launch the TUI with the test provider. The pane is tall enough to hold the
  // full multi-turn transcript so the final capture shows every tool in action;
  // a shorter pane would scroll the earlier turns off-screen.
  const launchCmd = `env OMC_PROVIDER=test OMC_APPROVAL_TIMEOUT_MS=2000 ${JSON.stringify(nodeBin)} ${JSON.stringify(cli)}`;
  const started = tmux('new-session', '-d', '-x', '120', '-y', '260', '-s', session, launchCmd);
  if (started.status !== 0) {
    throw new Error(started.stderr || 'Unable to start tmux integration session');
  }

  // Wait for the TUI to render
  waitForContent('Composer');
  waitForContent('Transcript');

  // Verify model identity and connection state are shown
  const initial = capturePane();
  if (!initial.includes('Model:')) {
    throw new Error('Expected Model: in status card');
  }
  if (!initial.includes('Connection:')) {
    throw new Error('Expected Connection: in status card');
  }

  // === Turn 1: list files (repository discovery) ===
  sendKeys('list files in src', 'Enter');
  // The agent invokes the list_files tool and its result appears in the transcript
  waitForContent('list_files');
  waitForContent('app.ts');
  waitForContent('ready');

  // === Turn 2: read a file ===
  spawnSync('sleep', ['0.3']);
  sendKeys('read tsconfig.build.json', 'Enter');
  waitForContent('read_file');
  // The file content is shown in the transcript
  waitForContent('outDir');
  waitForContent('ready');

  // === Turn 3: search repository content ===
  spawnSync('sleep', ['0.3']);
  sendKeys('search for launchTui', 'Enter');
  waitForContent('search_content');
  // A matching file is reported with its path
  waitForContent('src/tui.ts');
  waitForContent('ready');

  // === Turn 4: run a command through the approval boundary (allow once) ===
  spawnSync('sleep', ['0.3']);
  sendKeys('run echo hello-allow', 'Enter');
  // The approval card blocks execution until a decision is recorded
  waitForContent('Approval required');
  waitForContent('Risk:');
  sendKeys('y');
  waitForContent('hello-allow');
  waitForContent('ready');

  // === Turn 5: deny a command ===
  spawnSync('sleep', ['0.3']);
  sendKeys('run echo hello-deny', 'Enter');
  waitForContent('Approval required');
  sendKeys('n');
  waitForContent('Command denied');
  waitForContent('ready');

  // === Turn 6: let the approval window time out ===
  spawnSync('sleep', ['0.3']);
  sendKeys('run echo hello-timeout', 'Enter');
  waitForContent('Approval required');
  // No decision is sent; the approval auto-denies after the timeout
  waitForContent('Command timed out');
  waitForContent('ready');

  // === Turn 7: apply a scoped edit through the diff review boundary ===
  writeFileSync(fixturePath, fixtureOriginal, 'utf8');
  spawnSync('sleep', ['0.3']);
  sendKeys('edit omc-e2e-fixture.txt :: beta :: BETA', 'Enter');
  // The diff card blocks until a decision is recorded; nothing is written yet.
  waitForContent('Edit proposed');
  waitForContent('+ BETA');
  sendKeys('y');
  waitForContent('Edit applied');
  waitForContent('ready');
  if (!readFileSync(fixturePath, 'utf8').includes('BETA')) {
    throw new Error('Accepted edit was not written to disk');
  }

  // === Turn 8: reject an edit; the file must stay untouched ===
  spawnSync('sleep', ['0.3']);
  sendKeys('edit omc-e2e-fixture.txt :: gamma :: GAMMA', 'Enter');
  waitForContent('Edit proposed');
  sendKeys('n');
  waitForContent('Edit rejected');
  waitForContent('ready');
  const afterReject = readFileSync(fixturePath, 'utf8');
  if (afterReject.includes('GAMMA')) {
    throw new Error('Rejected edit must not modify the file');
  }
  if (!afterReject.includes('BETA')) {
    throw new Error('Previously applied edit should still be present');
  }

  // === Revert: undo only the applied edit (Ctrl+U) ===
  spawnSync('sleep', ['0.3']);
  sendKeys('C-u');
  waitForContent('Edit reverted');
  waitForContent('ready');
  // Revert restores the original content, leaving no trace of the applied edit.
  if (readFileSync(fixturePath, 'utf8') !== fixtureOriginal) {
    throw new Error('Revert did not restore the original file content');
  }

  // === Turn 9: build repository context from a multi-package fixture ===
  buildRepoFixture();
  spawnSync('sleep', ['0.3']);
  sendKeys('show repository context in omc-e2e-repo', 'Enter');
  waitForContent('repo_context');
  // Nested instructions are resolved according to scope.
  waitForContent('packages/api/AGENTS.md');
  waitForContent('scope: packages/api');
  // The summary identifies every package from real manifests.
  waitForContent('fixture-root');
  waitForContent('packages/web');
  // Focused test commands derived from real build tooling.
  waitForContent('make unit');
  // Uncommitted and untracked user work is reported.
  waitForContent('untracked: notes.txt');
  waitForContent('modified: packages/api/tracked.txt');
  waitForContent('ready');
  // Discovery is read-only: the working tree is exactly as left.
  if (readFileSync(join(repoFixturePath, 'packages', 'api', 'tracked.txt'), 'utf8') !== 'changed\n') {
    throw new Error('repo_context modified tracked work');
  }
  if (readFileSync(join(repoFixturePath, 'notes.txt'), 'utf8') !== 'untracked work\n') {
    throw new Error('repo_context modified untracked work');
  }

  // === Turn 10: a complete coding loop whose verification passes ===
  // The fixture file is back to its original content after the turn-8 revert.
  spawnSync('sleep', ['0.3']);
  sendKeys('complete omc-e2e-fixture.txt :: beta :: BETA :: grep BETA omc-e2e-fixture.txt', 'Enter');
  // The loop inspects the target file, then proposes the scoped edit.
  waitForContent('read_file');
  waitForContent('Edit proposed');
  sendKeys('y');
  waitForContent('Edit applied');
  // Focused verification runs through the approval boundary and passes.
  waitForContent('Approval required');
  sendKeys('y');
  waitForContent('Coding loop complete');
  waitForContent('Changes:');
  waitForContent('Tests:');
  waitForContent('Next (user-owned):');
  waitForContent('ready');
  if (!readFileSync(fixturePath, 'utf8').includes('BETA')) {
    throw new Error('Loop edit was not written to disk');
  }

  // === Turn 11: a complete coding loop whose verification fails (blocked) ===
  spawnSync('sleep', ['0.3']);
  sendKeys('complete omc-e2e-fixture.txt :: gamma :: GAMMA :: grep MISSING omc-e2e-fixture.txt', 'Enter');
  waitForContent('read_file');
  waitForContent('Edit proposed');
  sendKeys('y');
  waitForContent('Edit applied');
  waitForContent('Approval required');
  sendKeys('y');
  // Verification finds no match, so the loop reports a clear blocked result
  // instead of claiming success.
  waitForContent('Coding loop blocked');
  waitForContent('Remaining risks:');
  waitForContent('ready');

  // Verify usage reflects all eleven completed turns (footer stays pinned on-screen)
  const finalScreen = waitForContent('turns: 11');

  // The command, edit, and coding-loop paths must each be visible in the transcript.
  for (const token of [
    'hello-allow',
    'Command denied',
    'Command timed out',
    'Edit applied',
    'Edit rejected',
    'Edit reverted',
    'Coding loop complete',
    'Coding loop blocked',
  ]) {
    if (!finalScreen.includes(token)) {
      throw new Error(`Expected ${token} in final transcript`);
    }
  }

  // Preserve the verified TUI itself for PR evidence before the tmux session exits.
  const evidenceDirectory = resolve('artifacts/e2e');
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(join(evidenceDirectory, 'oh-my-code.tmux.txt'), finalScreen, 'utf8');

  // Exit
  sendKeys('C-c');

  // Verify the session ended cleanly
  spawnSync('sleep', ['0.5']);
  const hasSession = tmux('has-session', '-t', session);
  if (hasSession.status === 0) {
    throw new Error('TUI did not exit after Ctrl+C');
  }

  process.stdout.write('integration: ok\n');
} finally {
  tmux('kill-server');
  rmSync(temporaryDirectory, { recursive: true, force: true });
  rmSync(fixturePath, { force: true });
  rmSync(repoFixturePath, { recursive: true, force: true });
}
