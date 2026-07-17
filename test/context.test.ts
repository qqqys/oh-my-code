import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverContext,
  discoverGitState,
  discoverInstructions,
  discoverPackages,
  detectBuildTools,
  formatContextSummary,
  inferTestCommands,
  resolveInstructions,
} from '../src/context.js';

const created: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

// A multi-package repository with nested instructions and real build tooling.
function makeFixture(): string {
  const root = makeDir('omc-ctx-');
  mkdirSync(join(root, 'packages/api'), { recursive: true });
  mkdirSync(join(root, 'packages/web'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), '# root instructions\n');
  writeFileSync(join(root, 'packages/api/AGENTS.md'), '# api instructions\n');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', scripts: { build: 'tsc', test: 'vitest run' } }),
  );
  writeFileSync(
    join(root, 'packages/api/package.json'),
    JSON.stringify({ name: 'api', scripts: { test: 'vitest run' } }),
  );
  writeFileSync(
    join(root, 'packages/web/package.json'),
    JSON.stringify({ name: 'web', scripts: { build: 'tsc', test: 'vitest run' } }),
  );
  writeFileSync(
    join(root, 'Makefile'),
    'build:\n\ttsc\nunit:\n\tvitest run\nintegration:\n\tnode scripts/integration.mjs\n',
  );
  writeFileSync(join(root, 'tsconfig.json'), '{}\n');
  return root;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('discoverInstructions', () => {
  it('finds root and nested instructions with their scopes', () => {
    const root = makeFixture();
    const instructions = discoverInstructions(root);
    const byPath = new Map(instructions.map((i) => [i.path, i.scope]));
    expect(byPath.get('AGENTS.md')).toBe('.');
    expect(byPath.get('packages/api/AGENTS.md')).toBe('packages/api');
    // The web package has no instruction file of its own.
    expect(byPath.has('packages/web/AGENTS.md')).toBe(false);
  });
});

describe('resolveInstructions', () => {
  it('applies nested instructions only within their scope', () => {
    const root = makeFixture();
    const instructions = discoverInstructions(root);

    const forApi = resolveInstructions(instructions, 'packages/api/src/handler.ts').map((i) => i.path);
    expect(forApi).toContain('AGENTS.md');
    expect(forApi).toContain('packages/api/AGENTS.md');

    const forWeb = resolveInstructions(instructions, 'packages/web/index.ts').map((i) => i.path);
    expect(forWeb).toContain('AGENTS.md');
    expect(forWeb).not.toContain('packages/api/AGENTS.md');
  });
});

describe('discoverPackages', () => {
  it('identifies every package with its name and scripts', () => {
    const root = makeFixture();
    const packages = discoverPackages(root);
    expect(packages.map((p) => p.name).sort()).toEqual(['api', 'fixture-root', 'web']);
    const rootPkg = packages.find((p) => p.path === '.');
    expect(rootPkg?.scripts).toContain('build');
    expect(rootPkg?.scripts).toContain('test');
  });
});

describe('detectBuildTools', () => {
  it('derives tools from real files at the root', () => {
    const root = makeFixture();
    expect(detectBuildTools(root)).toEqual(expect.arrayContaining(['make', 'tsc', 'npm']));
  });
});

describe('inferTestCommands', () => {
  it('collects focused test commands from the Makefile and package scripts', () => {
    const root = makeFixture();
    const packages = discoverPackages(root);
    const commands = inferTestCommands(root, packages);
    expect(commands).toContain('make unit');
    expect(commands).toContain('make integration');
    expect(commands).toContain('npm test');
    expect(commands).toContain('npm test --prefix packages/api');
  });
});

describe('discoverGitState', () => {
  it('reports a non-repository directory', () => {
    const dir = makeDir('omc-nogit-');
    const state = discoverGitState(dir);
    expect(state.isRepo).toBe(false);
    expect(state.branch).toBeNull();
  });

  it('reports modified and untracked work without touching it', () => {
    const dir = makeDir('omc-git-');
    const init = spawnSync('git', ['-C', dir, 'init']);
    if (init.status !== 0) {
      throw new Error('git init failed: ' + init.stderr);
    }
    spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
    spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test User']);
    writeFileSync(join(dir, 'committed.txt'), 'a\n');
    spawnSync('git', ['-C', dir, 'add', '.']);
    const commit = spawnSync('git', ['-C', dir, 'commit', '-m', 'init']);
    if (commit.status !== 0) {
      throw new Error('git commit failed: ' + commit.stderr);
    }
    writeFileSync(join(dir, 'committed.txt'), 'b\n');
    writeFileSync(join(dir, 'untracked.txt'), 'c\n');

    const state = discoverGitState(dir);
    expect(state.isRepo).toBe(true);
    expect(typeof state.branch).toBe('string');
    expect(state.modified).toContain('committed.txt');
    expect(state.untracked).toContain('untracked.txt');
  });
});

describe('formatContextSummary', () => {
  it('renders a concise, evidence-based summary', () => {
    const root = makeFixture();
    const summary = formatContextSummary(discoverContext(root));
    expect(summary).toContain('Instructions (resolved by scope)');
    expect(summary).toContain('packages/api/AGENTS.md  (scope: packages/api)');
    expect(summary).toContain('Packages:');
    expect(summary).toContain('fixture-root');
    expect(summary).toContain('Build tools:');
    expect(summary).toContain('Focused test commands:');
    expect(summary).toContain('make unit');
  });
});
