import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'oh-my-code-integration-'));
const socket = join(temporaryDirectory, 'tmux.sock');
const session = `oh-my-code-${process.pid}`;
const signal = `${session}-done`;
const cli = resolve('dist/cli.js');

function tmux(...args) {
  return spawnSync('tmux', ['-S', socket, ...args], {
    encoding: 'utf8',
  });
}

try {
  const command = `node ${JSON.stringify(cli)} --help; tmux -S ${JSON.stringify(socket)} wait-for -S ${JSON.stringify(signal)}; tmux -S ${JSON.stringify(socket)} wait-for ${JSON.stringify(`${signal}-release`)}`;
  const started = tmux('new-session', '-d', '-s', session, command);
  if (started.status !== 0) {
    throw new Error(started.stderr || 'Unable to start tmux integration session');
  }

  const waited = tmux('wait-for', signal);
  if (waited.status !== 0) {
    throw new Error(waited.stderr || 'tmux integration session did not finish');
  }

  const captured = tmux('capture-pane', '-p', '-t', session, '-S', '-');
  if (captured.status !== 0 || !captured.stdout.includes('Oh My Code')) {
    throw new Error(captured.stderr || 'Expected CLI output was not captured');
  }

  process.stdout.write(captured.stdout);
} finally {
  tmux('kill-server');
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
