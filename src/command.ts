import { spawn } from 'node:child_process';

export type CommandStatus = 'ok' | 'non-zero' | 'timeout' | 'cancelled';

export interface CommandOutcome {
  status: CommandStatus;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  durationMs: number;
}

export interface RunCommandOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  shell?: string;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 8192;

// Execute a shell command with a hard wall-clock timeout and bounded output.
// The outcome distinguishes success, non-zero exit, timeout, and cancellation
// so the approval boundary can render each case distinctly.
export function runCommand(options: RunCommandOptions): Promise<CommandOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const shell = options.shell ?? '/bin/sh';
  const started = Date.now();

  return new Promise<CommandOutcome>((resolve) => {
    const child = spawn(shell, ['-c', options.command], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    // The shell may fork the command instead of exec'ing it, leaving a
    // grandchild (e.g. `sleep`) that keeps the output pipe open after the shell
    // dies, so `close` would not fire until that orphan exits. Spawn into a
    // dedicated process group so signalling -pid terminates the whole tree.
    const killTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    let output = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const append = (chunk: Buffer): void => {
      if (truncated) return;
      const text = chunk.toString('utf8');
      const remaining = maxBytes - bytes;
      if (text.length >= remaining) {
        output += text.slice(0, Math.max(0, remaining));
        bytes = maxBytes;
        truncated = true;
      } else {
        output += text;
        bytes += text.length;
      }
    };

    const finish = (status: CommandStatus, exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, exitCode, output, truncated, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGKILL');
    }, timeoutMs);

    const signal = options.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        cancelled = true;
        killTree('SIGKILL');
      } else {
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
            killTree('SIGTERM');
          },
          { once: true },
        );
      }
    }

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    child.on('error', (error: Error) => {
      if (output.length === 0) output = error.message;
      finish('non-zero', null);
    });

    child.on('close', (code: number | null) => {
      if (timedOut) {
        finish('timeout', code);
      } else if (cancelled) {
        finish('cancelled', code);
      } else if (code === 0) {
        finish('ok', 0);
      } else {
        finish('non-zero', code);
      }
    });
  });
}
