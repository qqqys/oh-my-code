import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PolicyEngine, PolicyStore, type PolicyRule } from '../src/policy.js';

const action = { command: 'git push', cwd: '/repo' };

describe('PolicyEngine precedence', () => {
  it('lets a deny from any scope win', () => {
    const engine = new PolicyEngine(
      [{ ...action, decision: 'deny' }],
      [{ ...action, decision: 'allow' }],
      [],
    );
    expect(engine.decide(action)).toEqual({ decision: 'deny', reason: 'denied by user policy' });
  });

  it('caps a project allow at the user ceiling', () => {
    const engine = new PolicyEngine(
      [{ ...action, decision: 'ask' }],
      [{ ...action, decision: 'allow' }],
      [],
    );
    const outcome = engine.decide(action);
    expect(outcome.decision).toBe('ask');
    expect(outcome.reason).toContain('capped by user policy');
  });

  it('cannot broaden past an explicit user deny via the project scope', () => {
    const engine = new PolicyEngine(
      [{ ...action, decision: 'deny' }],
      [{ ...action, decision: 'allow' }],
      [{ ...action, decision: 'allow' }],
    );
    expect(engine.decide(action).decision).toBe('deny');
  });

  it('applies a temporary override over the project rule', () => {
    const engine = new PolicyEngine(
      [],
      [{ ...action, decision: 'deny' }],
      [{ ...action, decision: 'allow' }],
    );
    // temporary allow is overridden by the project deny (deny always wins)
    expect(engine.decide(action).decision).toBe('deny');
  });

  it('honours a temporary override when no deny is present', () => {
    const engine = new PolicyEngine(
      [{ ...action, decision: 'allow' }],
      [{ ...action, decision: 'allow' }],
      [{ ...action, decision: 'ask' }],
    );
    const outcome = engine.decide(action);
    expect(outcome.decision).toBe('ask');
    expect(outcome.reason).toContain('temporary override');
  });

  it('defaults to ask when no rule matches', () => {
    const engine = new PolicyEngine([], [], []);
    expect(engine.decide(action)).toEqual({
      decision: 'ask',
      reason: 'no matching rule; defaults to ask',
    });
  });

  it('matches on exact command and cwd only', () => {
    const engine = new PolicyEngine([{ ...action, decision: 'allow' }], [], []);
    expect(engine.decide({ command: 'git push --force', cwd: '/repo' }).decision).toBe('ask');
    expect(engine.decide({ command: 'git push', cwd: '/other' }).decision).toBe('ask');
  });
});

describe('PolicyStore', () => {
  let directory: string;
  let userPath: string;
  let projectPath: string;
  let auditPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'oh-my-code-policy-'));
    userPath = join(directory, 'user.json');
    projectPath = join(directory, 'project.json');
    auditPath = join(directory, 'audit.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('sets, lists, and revokes rules per scope', () => {
    const store = PolicyStore.empty();
    store.set('user', { ...action, decision: 'deny' });
    store.set('project', { ...action, decision: 'allow' });
    expect(store.list('user')).toHaveLength(1);
    expect(store.list('project')).toHaveLength(1);

    expect(store.revoke('user', action.command, action.cwd)).toBe(true);
    expect(store.list('user')).toHaveLength(0);
    expect(store.revoke('user', action.command, action.cwd)).toBe(false);
  });

  it('upserts an identical rule instead of duplicating it', () => {
    const store = PolicyStore.empty();
    store.set('project', { ...action, decision: 'allow' });
    store.set('project', { ...action, decision: 'ask' });
    const rules = store.list('project');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.decision).toBe('ask');
  });

  it('resolves conflicts through the engine with the user ceiling', () => {
    const store = PolicyStore.empty();
    store.set('user', { ...action, decision: 'ask' });
    store.set('project', { ...action, decision: 'allow' });
    expect(store.decide(action).decision).toBe('ask');
  });

  it('persists user and project rules across reloads', () => {
    const first = PolicyStore.load({ user: userPath, project: projectPath, audit: auditPath });
    first.set('user', { ...action, decision: 'deny' });
    first.set('project', { ...action, decision: 'allow' });
    expect(readFileSync(userPath, 'utf8')).toContain('git push');

    const reloaded = PolicyStore.load({ user: userPath, project: projectPath, audit: auditPath });
    expect(reloaded.list('user')).toHaveLength(1);
    expect(reloaded.list('project')).toHaveLength(1);
    expect(reloaded.decide(action).decision).toBe('deny');
  });

  it('keeps temporary overrides out of persisted files', () => {
    const store = PolicyStore.load({ user: userPath, project: projectPath, audit: auditPath });
    store.set('temporary', { ...action, decision: 'deny' });
    const reloaded = PolicyStore.load({ user: userPath, project: projectPath, audit: auditPath });
    expect(reloaded.list('temporary')).toHaveLength(0);
  });

  it('records an audit trail of decisions and mutations', () => {
    const store = PolicyStore.empty();
    store.set('user', { ...action, decision: 'deny' });
    store.decide(action);
    store.revoke('user', action.command, action.cwd);
    const entries = store.audit();
    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain('set');
    expect(actions).toContain('decide');
    expect(actions).toContain('revoke');
  });
});
