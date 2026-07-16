import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cli = resolve('dist/cli.js');

describe('CLI entry point', () => {
  it('shows help with --help', () => {
    const result = spawnSync(process.execPath, [cli, '--help'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Oh My Code');
    expect(result.stdout).toContain('--version');
  });

  it('shows version with --version', () => {
    const result = spawnSync(process.execPath, [cli, '--version'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('0.0.0');
  });

  it('exits with error for unknown options', () => {
    const result = spawnSync(process.execPath, [cli, '--bogus'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown option: --bogus');
  });

  it('shows help when no arguments are provided in non-TTY mode', () => {
    const result = spawnSync(process.execPath, [cli], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Oh My Code');
    expect(result.stdout).toContain('Usage:');
  });

  it('rejects unsupported Node.js runtime', () => {
    const directory = mkdtempSync(join(tmpdir(), 'oh-my-code-runtime-'));
    const preload = join(directory, 'preload.cjs');
    writeFileSync(
      preload,
      "Object.defineProperty(process.versions, 'node', { value: '18.0.0', configurable: true });\n",
      'utf8',
    );
    const script = join(directory, 'entry.mjs');
    writeFileSync(
      script,
      `await import(${JSON.stringify(cli)});\n`,
      'utf8',
    );

    const result = spawnSync(
      process.execPath,
      ['--require', preload, script],
      { encoding: 'utf8', timeout: 10_000 },
    );

    rmSync(directory, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires Node.js 22');
  });
});
