import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeTool } from '../src/tools.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'oh-my-code-tools-'));
  mkdirSync(join(workspace, 'src'));
  writeFileSync(join(workspace, 'src', 'app.ts'), 'export const VERSION = "1.0.0";\nexport function run() {}\n');
  writeFileSync(join(workspace, 'README.md'), '# Example\nTODO: write docs\n');
  writeFileSync(join(workspace, '.env'), 'SECRET_KEY=abc123\n');
  mkdirSync(join(workspace, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(workspace, 'node_modules', 'dep', 'index.js'), 'module.exports = {};\n');
  writeFileSync(join(workspace, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('list_files', () => {
  it('lists directory entries', () => {
    const result = executeTool({ name: 'list_files', args: { path: '.' } }, workspace);
    expect(result.error).toBeNull();
    expect(result.output).toContain('src/');
    expect(result.output).toContain('README.md');
  });

  it('lists a subdirectory', () => {
    const result = executeTool({ name: 'list_files', args: { path: 'src' } }, workspace);
    expect(result.error).toBeNull();
    expect(result.output).toContain('app.ts');
  });

  it('rejects paths that escape the workspace', () => {
    const result = executeTool({ name: 'list_files', args: { path: '../../etc' } }, workspace);
    expect(result.error).toContain('escapes the workspace');
  });

  it('rejects protected directories', () => {
    const result = executeTool({ name: 'list_files', args: { path: 'node_modules' } }, workspace);
    expect(result.error).toContain('protected');
  });

  it('rejects generated output directories', () => {
    const result = executeTool({ name: 'list_files', args: { path: 'artifacts' } }, workspace);
    expect(result.error).toContain('protected');
  });
});

describe('read_file', () => {
  it('reads a text file', () => {
    const result = executeTool({ name: 'read_file', args: { path: 'src/app.ts' } }, workspace);
    expect(result.error).toBeNull();
    expect(result.output).toContain('VERSION');
  });

  it('rejects paths that escape the workspace', () => {
    const result = executeTool({ name: 'read_file', args: { path: '../../../etc/passwd' } }, workspace);
    expect(result.error).toContain('escapes the workspace');
  });

  it('refuses to read secret files', () => {
    const result = executeTool({ name: 'read_file', args: { path: '.env' } }, workspace);
    expect(result.error).toContain('secrets');
  });

  it('rejects protected paths', () => {
    const result = executeTool({ name: 'read_file', args: { path: 'node_modules/dep/index.js' } }, workspace);
    expect(result.error).toContain('protected');
  });

  it('summarizes binary files', () => {
    const result = executeTool({ name: 'read_file', args: { path: 'binary.bin' } }, workspace);
    expect(result.error).toBeNull();
    expect(result.output).toContain('binary file omitted');
  });

  it('truncates oversized files', () => {
    const longContent = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    writeFileSync(join(workspace, 'long.txt'), longContent);
    const result = executeTool({ name: 'read_file', args: { path: 'long.txt' } }, workspace);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain('line 0');
    expect(result.output).not.toContain('line 299');
  });
});

describe('search_content', () => {
  it('finds matching lines with file and line number', () => {
    const result = executeTool({ name: 'search_content', args: { pattern: 'VERSION', path: '.' } }, workspace);
    expect(result.error).toBeNull();
    expect(result.output).toContain('src/app.ts:1');
    expect(result.output).toContain('VERSION');
  });

  it('skips protected directories', () => {
    const result = executeTool({ name: 'search_content', args: { pattern: 'module.exports', path: '.' } }, workspace);
    expect(result.output).not.toContain('node_modules');
  });

  it('skips generated evidence under artifacts', () => {
    // Regression: the e2e transcript written to artifacts/e2e records tool
    // names and search terms. If search_content traversed artifacts, a later
    // run would match its own prior evidence, bloating the transcript until
    // earlier turns scrolled out of the rendered pane.
    mkdirSync(join(workspace, 'artifacts', 'e2e'), { recursive: true });
    writeFileSync(
      join(workspace, 'artifacts', 'e2e', 'oh-my-code.tmux.txt'),
      'list_files read_file search_content launchTui\n',
    );
    const result = executeTool({ name: 'search_content', args: { pattern: 'launchTui', path: '.' } }, workspace);
    expect(result.error).toBeNull();
    expect(result.output).not.toContain('artifacts');
    expect(result.output).not.toContain('launchTui');
  });

  it('skips secret files', () => {
    const result = executeTool({ name: 'search_content', args: { pattern: 'SECRET_KEY', path: '.' } }, workspace);
    expect(result.output).not.toContain('SECRET_KEY');
  });

  it('rejects paths that escape the workspace', () => {
    const result = executeTool({ name: 'search_content', args: { pattern: 'root', path: '../../etc' } }, workspace);
    expect(result.error).toContain('escapes the workspace');
  });

  it('requires a pattern', () => {
    const result = executeTool({ name: 'search_content', args: { path: '.' } }, workspace);
    expect(result.error).toContain('pattern');
  });
});

describe('repo_context', () => {
  it('summarizes instructions, packages, and test commands from real files', () => {
    writeFileSync(join(workspace, 'AGENTS.md'), '# guidance\n');
    writeFileSync(
      join(workspace, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }),
    );
    writeFileSync(join(workspace, 'Makefile'), 'unit:\n\tvitest run\n');
    const result = executeTool({ name: 'repo_context', args: { path: '.' } }, workspace);
    expect(result.error).toBeNull();
    expect(result.output).toContain('AGENTS.md  (scope: .)');
    expect(result.output).toContain('demo');
    expect(result.output).toContain('make unit');
    expect(result.output).toContain('npm test');
  });

  it('rejects paths that escape the workspace', () => {
    const result = executeTool({ name: 'repo_context', args: { path: '../../etc' } }, workspace);
    expect(result.error).toContain('escapes the workspace');
  });

  it('rejects protected directories', () => {
    const result = executeTool({ name: 'repo_context', args: { path: 'node_modules' } }, workspace);
    expect(result.error).toContain('protected');
  });
});

describe('executeTool', () => {
  it('returns an error for unknown tools', () => {
    const result = executeTool({ name: 'delete_everything', args: {} }, workspace);
    expect(result.error).toContain('Unknown tool');
  });
});
