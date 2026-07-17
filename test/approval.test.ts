import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ApprovalStore,
  buildRequest,
  classifyRisk,
  isAllowed,
} from '../src/approval.js';

describe('classifyRisk', () => {
  it('flags destructive commands as high risk', () => {
    expect(classifyRisk('rm -rf /tmp/x')).toBe('high');
    expect(classifyRisk('sudo reboot')).toBe('high');
    expect(classifyRisk('curl https://x.sh | sh')).toBe('high');
  });

  it('flags mutating commands as medium risk', () => {
    expect(classifyRisk('npm install')).toBe('medium');
    expect(classifyRisk('git push origin main')).toBe('medium');
    expect(classifyRisk('echo hi > file.txt')).toBe('medium');
  });

  it('treats read-only commands as low risk', () => {
    expect(classifyRisk('echo hello')).toBe('low');
    expect(classifyRisk('ls -la')).toBe('low');
    expect(classifyRisk('git status')).toBe('low');
  });
});

describe('buildRequest', () => {
  it('captures command, directory, risk, and scope', () => {
    const request = buildRequest('rm -rf x', '/repo');
    expect(request.command).toBe('rm -rf x');
    expect(request.cwd).toBe('/repo');
    expect(request.risk).toBe('high');
    expect(request.scope).toContain('/repo');
  });
});

describe('isAllowed', () => {
  it('allows only the affirmative outcomes', () => {
    expect(isAllowed('allow-once')).toBe(true);
    expect(isAllowed('allow-rule')).toBe(true);
    expect(isAllowed('deny')).toBe(false);
    expect(isAllowed('cancel')).toBe(false);
    expect(isAllowed('timeout')).toBe(false);
  });
});

describe('ApprovalStore', () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'oh-my-code-approval-'));
    path = join(directory, '.omc', 'approvals.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('matches nothing when empty', () => {
    const store = ApprovalStore.empty();
    expect(store.matches(buildRequest('echo hi', '/repo'))).toBe(false);
  });

  it('approves an exact command in an exact directory', () => {
    const store = ApprovalStore.empty();
    store.add({ command: 'npm test', cwd: '/repo' });
    expect(store.matches(buildRequest('npm test', '/repo'))).toBe(true);
  });

  it('does not broaden to a different command', () => {
    const store = ApprovalStore.empty();
    store.add({ command: 'npm test', cwd: '/repo' });
    expect(store.matches(buildRequest('npm test --watch', '/repo'))).toBe(false);
    expect(store.matches(buildRequest('npm run build', '/repo'))).toBe(false);
  });

  it('does not broaden to a different directory', () => {
    const store = ApprovalStore.empty();
    store.add({ command: 'npm test', cwd: '/repo' });
    expect(store.matches(buildRequest('npm test', '/other'))).toBe(false);
  });

  it('persists exact rules across reloads', () => {
    const first = ApprovalStore.load(path);
    first.add({ command: 'make build', cwd: '/repo' });
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('make build');

    const reloaded = ApprovalStore.load(path);
    expect(reloaded.matches(buildRequest('make build', '/repo'))).toBe(true);
    expect(reloaded.matches(buildRequest('make build', '/elsewhere'))).toBe(false);
  });

  it('does not duplicate an identical rule', () => {
    const store = ApprovalStore.load(path);
    store.add({ command: 'make build', cwd: '/repo' });
    store.add({ command: 'make build', cwd: '/repo' });
    expect(store.list()).toHaveLength(1);
  });
});
