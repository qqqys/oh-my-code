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
  const started = tmux('new-session', '-d', '-x', '120', '-y', '160', '-s', session, launchCmd);
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

  // Verify usage reflects all eight completed turns (footer stays pinned on-screen)
  const finalScreen = waitForContent('turns: 8');

  // The command and edit paths must each be visible in the transcript.
  for (const token of [
    'hello-allow',
    'Command denied',
    'Command timed out',
    'Edit applied',
    'Edit rejected',
    'Edit reverted',
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
}
