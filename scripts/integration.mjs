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
  const captured = tmux('capture-pane', '-p', '-t', session, '-S', '-');
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
  const started = tmux('new-session', '-d', '-x', '120', '-y', '40', '-s', session, launchCmd);
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

  // Type a message and submit it
  sendKeys('Hello', 'Enter');

  // Wait for the user message to appear in the transcript
  const afterSubmit = waitForContent('Hello');
  if (!afterSubmit.includes('You')) {
    throw new Error('Expected "You" label in transcript after submission');
  }

  // Wait for streaming to start and the assistant response to appear
  waitForContent('Assistant');
  waitForContent('received your message');

  // Wait for streaming to complete (connection returns to ready)
  waitForContent('ready');

  // Verify the assistant message is finalized in the transcript
  const afterStream = capturePane();
  if (!afterStream.includes('received your message')) {
    throw new Error('Expected assistant response in transcript');
  }

  // Verify the session is still usable: submit a second message
  spawnSync('sleep', ['0.3']);
  sendKeys('Second message', 'Enter');
  waitForContent('Second message');
  // The assistant should respond again
  const afterSecond = waitForOccurrences('received your message', 2);
  // Should have two user messages now
  const youCount = (afterSecond.match(/You/g) || []).length;
  if (youCount < 2) {
    throw new Error(`Expected at least 2 user messages, found ${youCount}`);
  }

  // Preserve the verified TUI itself for PR evidence before the tmux session exits.
  const evidenceDirectory = resolve('artifacts/e2e');
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(join(evidenceDirectory, 'oh-my-code.tmux.txt'), afterSecond, 'utf8');

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
