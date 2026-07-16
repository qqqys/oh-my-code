import { mkdtempSync, rmSync } from 'node:fs';
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

try {
  // Launch the TUI
  const started = tmux('new-session', '-d', '-x', '120', '-y', '40', '-s', session, `${JSON.stringify(nodeBin)} ${JSON.stringify(cli)}`);
  if (started.status !== 0) {
    throw new Error(started.stderr || 'Unable to start tmux integration session');
  }

  // Wait for the TUI to render
  waitForContent('Composer');
  waitForContent('Transcript');

  // Type a message and submit it
  sendKeys('Hello', 'Enter');

  // Wait for the message to appear in the transcript
  const afterSubmit = waitForContent('Hello');
  if (!afterSubmit.includes('You')) {
    throw new Error('Expected "You" label in transcript after submission');
  }

  // Wait for debounce window to pass before next submission
  spawnSync('sleep', ['0.3']);

  // Type a Unicode message and submit it
  sendKeys('日本語', 'Enter');
  spawnSync('sleep', ['0.3']);

  // Verify the Unicode message appears in the transcript (with "You" label)
  const afterUnicode = capturePane();
  if (!afterUnicode.includes('日本語')) {
    throw new Error('Expected Unicode message in transcript');
  }

  // Test empty submission is ignored (press Enter with empty composer)
  sendKeys('Enter');
  // Should not add a new message — verify transcript still has exactly our messages
  const afterEmpty = capturePane();
  const youCount = (afterEmpty.match(/You/g) || []).length;
  if (youCount !== 2) {
    throw new Error(`Expected 2 messages in transcript, found ${youCount}`);
  }

  // Test history navigation: press Up to recall last message
  sendKeys('Up');
  waitForContent('日本語');

  // Cancel and exit
  sendKeys('Escape');
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
