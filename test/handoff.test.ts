import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  formatHandoffSummary,
  proposeCommitMessage,
  summarizeHandoff,
  type HandoffChange,
  type HandoffSummary,
} from '../src/handoff.js';

function git(dir: string, args: readonly string[]): void {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

const change = (path: string): HandoffChange => ({
  path,
  staged: false,
  unstaged: true,
  untracked: false,
  conflicted: false,
});

const summary = (overrides: Partial<HandoffSummary>): HandoffSummary => ({
  isRepo: true,
  detached: false,
  branch: 'main',
  agentOwned: [],
  preExisting: [],
  conflicted: [],
  proposal: '',
  ...overrides,
});

describe('proposeCommitMessage', () => {
  it('infers docs, test, feat, and chore types', () => {
    expect(proposeCommitMessage([change('README.md')], 'main')).toMatch(
      /^docs\(main\): handoff 1 changed file/,
    );
    expect(proposeCommitMessage([change('test/foo.test.ts')], null)).toMatch(/^test: handoff/);
    expect(proposeCommitMessage([change('src/foo.ts')], null)).toMatch(/^feat: handoff/);
    expect(proposeCommitMessage([change('Makefile')], null)).toMatch(/^chore: handoff/);
  });

  it('lists every changed file in the body', () => {
    const message = proposeCommitMessage([change('src/a.ts'), change('src/b.ts')], 'main');
    expect(message).toContain('- src/a.ts');
    expect(message).toContain('- src/b.ts');
    expect(message).toContain('handoff 2 changed files');
  });

  it('returns an empty string with no files', () => {
    expect(proposeCommitMessage([], 'main')).toBe('');
  });
});

describe('formatHandoffSummary', () => {
  it('reports a non-repo directory', () => {
    expect(formatHandoffSummary(summary({ isRepo: false }))).toContain('not a Git repository');
  });

  it('warns on a detached HEAD', () => {
    const text = formatHandoffSummary(summary({ detached: true, branch: null, agentOwned: [change('a')] }));
    expect(text).toContain('DETACHED HEAD');
  });

  it('surfaces conflicts and blocks the commit', () => {
    const text = formatHandoffSummary(summary({ agentOwned: [change('a')], conflicted: [change('b')] }));
    expect(text).toContain('Conflicts');
    expect(text).toContain('Resolve the above before /handoff commit');
  });

  it('shows nothing to hand off on a clean tree', () => {
    expect(formatHandoffSummary(summary({}))).toContain('Nothing to hand off');
  });
});

describe('summarizeHandoff', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oh-my-code-handoff-'));
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'e2e@example.com']);
    git(dir, ['config', 'user.name', 'E2E Bot']);
    writeFileSync(join(dir, 'base.txt'), 'base\n');
    git(dir, ['add', 'base.txt']);
    git(dir, ['commit', '-m', 'base']);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('partitions agent-owned from pre-existing changes', () => {
    writeFileSync(join(dir, 'agent.txt'), 'agent\n');
    writeFileSync(join(dir, 'user.txt'), 'user\n');
    const result = summarizeHandoff(dir, new Set(['agent.txt']));
    expect(result.agentOwned.map((c) => c.path)).toEqual(['agent.txt']);
    expect(result.preExisting.map((c) => c.path)).toEqual(['user.txt']);
    expect(result.proposal).toContain('agent.txt');
  });

  it('reports a clean tree as nothing to hand off', () => {
    const result = summarizeHandoff(dir, new Set());
    expect(result.agentOwned).toHaveLength(0);
    expect(result.preExisting).toHaveLength(0);
  });

  it('formats a dirty tree with the proposal and pre-existing warning', () => {
    writeFileSync(join(dir, 'agent.txt'), 'agent\n');
    writeFileSync(join(dir, 'user.txt'), 'user\n');
    const text = formatHandoffSummary(summarizeHandoff(dir, new Set(['agent.txt'])));
    expect(text).toContain('Agent-owned changes (1)');
    expect(text).toContain('Pre-existing changes');
    expect(text).toContain('user.txt');
    expect(text).toContain('/handoff commit');
  });
});
