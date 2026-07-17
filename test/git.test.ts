import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitRepo, createBranch, inspectRepo, stageFiles } from '../src/git.js';

function git(dir: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oh-my-code-git-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'e2e@example.com']);
  git(dir, ['config', 'user.name', 'E2E Bot']);
  return dir;
}

describe('inspectRepo', () => {
  let dir: string;
  beforeEach(() => {
    dir = initRepo();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a non-repo directory', () => {
    const plain = mkdtempSync(join(tmpdir(), 'oh-my-code-plain-'));
    try {
      expect(inspectRepo(plain).isRepo).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('classifies staged, unstaged, and untracked changes', () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', 'base']);

    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, ['add', 'a.txt']); // staged
    writeFileSync(join(dir, 'b.txt'), 'bee\n');
    git(dir, ['add', 'b.txt']);
    writeFileSync(join(dir, 'b.txt'), 'bee2\n'); // staged + unstaged
    writeFileSync(join(dir, 'c.txt'), 'see\n'); // untracked

    const inspection = inspectRepo(dir);
    expect(inspection.isRepo).toBe(true);
    expect(inspection.detached).toBe(false);
    const byPath = new Map(inspection.entries.map((entry) => [entry.path, entry]));
    expect(byPath.get('a.txt')?.staged).toBe(true);
    expect(byPath.get('b.txt')?.staged).toBe(true);
    expect(byPath.get('b.txt')?.unstaged).toBe(true);
    expect(byPath.get('c.txt')?.untracked).toBe(true);
  });

  it('detects a detached HEAD', () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', 'base']);
    const sha = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['checkout', sha]);
    const inspection = inspectRepo(dir);
    expect(inspection.detached).toBe(true);
    expect(inspection.branch).toBeNull();
  });

  it('surfaces merge conflicts', () => {
    writeFileSync(join(dir, 'a.txt'), 'base\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', 'base']);
    const base = git(dir, ['symbolic-ref', '--short', 'HEAD']);
    git(dir, ['switch', '-c', 'feature']);
    writeFileSync(join(dir, 'a.txt'), 'feature\n');
    git(dir, ['commit', '-am', 'feature']);
    git(dir, ['switch', base]);
    writeFileSync(join(dir, 'a.txt'), 'main\n');
    git(dir, ['commit', '-am', 'main']);
    spawnSync('git', ['-C', dir, 'merge', 'feature'], { encoding: 'utf8' }); // expected to conflict
    const inspection = inspectRepo(dir);
    const conflict = inspection.entries.find((entry) => entry.path === 'a.txt');
    expect(conflict?.conflicted).toBe(true);
  });
});

describe('git mutations', () => {
  let dir: string;
  beforeEach(() => {
    dir = initRepo();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stages only the named files', () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    const result = stageFiles(dir, ['a.txt']);
    expect(result.ok).toBe(true);
    const byPath = new Map(inspectRepo(dir).entries.map((entry) => [entry.path, entry]));
    expect(byPath.get('a.txt')?.staged).toBe(true);
    expect(byPath.get('b.txt')?.staged).toBe(false);
  });

  it('commits staged files and fails closed when nothing is staged', () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    stageFiles(dir, ['a.txt']);
    const committed = commitRepo(dir, 'feat: add a');
    expect(committed.ok).toBe(true);
    expect(inspectRepo(dir).entries).toHaveLength(0);

    const empty = commitRepo(dir, 'feat: nothing');
    expect(empty.ok).toBe(false);
  });

  it('creates and switches to a new branch', () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', 'base']);
    const result = createBranch(dir, 'feature/handoff');
    expect(result.ok).toBe(true);
    expect(inspectRepo(dir).branch).toBe('feature/handoff');
  });
});
