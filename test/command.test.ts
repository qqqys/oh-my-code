import { describe, expect, it } from 'vitest';

import { runCommand } from '../src/command.js';

describe('runCommand', () => {
  it('reports success with captured output', async () => {
    const outcome = await runCommand({ command: 'echo hello', cwd: process.cwd(), timeoutMs: 5000 });
    expect(outcome.status).toBe('ok');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output.trim()).toBe('hello');
    expect(outcome.truncated).toBe(false);
  });

  it('reports a non-zero exit distinctly', async () => {
    const outcome = await runCommand({ command: 'exit 3', cwd: process.cwd(), timeoutMs: 5000 });
    expect(outcome.status).toBe('non-zero');
    expect(outcome.exitCode).toBe(3);
  });

  it('combines stdout and stderr', async () => {
    const outcome = await runCommand({
      command: 'echo out; echo err 1>&2',
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(outcome.output).toContain('out');
    expect(outcome.output).toContain('err');
  });

  it('reports a timeout and kills the process', async () => {
    const outcome = await runCommand({ command: 'sleep 5', cwd: process.cwd(), timeoutMs: 100 });
    expect(outcome.status).toBe('timeout');
  });

  it('reports cancellation via abort signal', async () => {
    const controller = new AbortController();
    const pending = runCommand({
      command: 'sleep 5',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const outcome = await pending;
    expect(outcome.status).toBe('cancelled');
  });

  it('bounds output and flags truncation', async () => {
    const outcome = await runCommand({
      command: 'seq 1 100000',
      cwd: process.cwd(),
      timeoutMs: 5000,
      maxBytes: 64,
    });
    expect(outcome.truncated).toBe(true);
    expect(outcome.output.length).toBeLessThanOrEqual(64);
  });
});
