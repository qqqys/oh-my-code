import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'oh-my-code-integration-'));
const socket = join(temporaryDirectory, 'tmux.sock');
const session = `oh-my-code-${process.pid}`;
const cli = resolve('dist/cli.js');
const nodeBin = process.execPath;

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

function waitForOccurrences(expected, count, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = capturePane();
    if (content.split(expected).length - 1 >= count) {
      return content;
    }
    spawnSync('sleep', ['0.25']);
  }
  throw new Error(`Timed out waiting for ${count} occurrences of: ${expected}`);
}

try {
  // Launch the TUI with the test provider
  const launchCmd = `env OMC_PROVIDER=test ${JSON.stringify(nodeBin)} ${JSON.stringify(cli)}`;
  const started = tmux('new-session', '-d', '-x', '120', '-y', '50', '-s', session, launchCmd);
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

  // === Turn 1: normal message ===
  sendKeys('Hello', 'Enter');
  waitForContent('Hello');
  waitForContent('received your message');
  waitForContent('ready');

  // === Turn 2: recoverable failure + retry ===
  spawnSync('sleep', ['0.3']);
  sendKeys('please recover now', 'Enter');
  // The provider fails once with a recoverable error
  waitForContent('Simulated transient network error');
  waitForContent('Ctrl+R retry');
  // Retry the failed turn (no duplicate user message)
  sendKeys('C-r');
  // After retry, the assistant responds
  waitForContent('ready');
  const afterRetry = capturePane();
  // The user message "please recover now" must appear exactly once (no duplication)
  const recoverCount = (afterRetry.match(/please recover now/g) || []).length;
  if (recoverCount !== 1) {
    throw new Error(`Expected 1 occurrence of retried user message, found ${recoverCount}`);
  }

  // === Turn 3: another normal message ===
  spawnSync('sleep', ['0.3']);
  sendKeys('Third question', 'Enter');
  waitForContent('Third question');
  waitForContent('ready');

  // Verify usage reflects three completed turns
  const finalScreen = waitForContent('turns: 3');

  // Verify multi-turn transcript order
  const firstIdx = finalScreen.indexOf('Hello');
  const secondIdx = finalScreen.indexOf('please recover now');
  const thirdIdx = finalScreen.indexOf('Third question');
  if (!(firstIdx < secondIdx && secondIdx < thirdIdx)) {
    throw new Error('Transcript order is incorrect across three turns');
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
}
