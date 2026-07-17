import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// A tool permission decision. `deny` blocks outright, `ask` defers to the
// interactive approval boundary, and `allow` runs without asking.
export type PolicyDecision = 'allow' | 'ask' | 'deny';

// Where a rule comes from. `user` is the operator's global policy, `project` is
// the repository's own policy, and `temporary` is a session-only override.
export type PolicyScope = 'user' | 'project' | 'temporary';

export interface PolicyRule {
  command: string;
  cwd: string;
  decision: PolicyDecision;
}

export interface PolicyAction {
  command: string;
  cwd: string;
}

export interface PolicyOutcome {
  decision: PolicyDecision;
  reason: string;
}

export interface PolicyAuditEntry {
  at: string;
  scope: PolicyScope | 'engine';
  command: string;
  cwd: string;
  decision: PolicyDecision;
  action: 'decide' | 'set' | 'revoke';
}

export interface PolicyPaths {
  user: string | null;
  project: string | null;
  audit: string | null;
}

// Restrictiveness ordering: deny is strongest, allow weakest. The effective
// decision is never more permissive than the user policy, so a project can never
// silently grant itself broader permissions than the user allows.
const RESTRICTIVENESS: Readonly<Record<PolicyDecision, number>> = { deny: 0, ask: 1, allow: 2 };

const MAX_AUDIT_ENTRIES = 200;

function moreRestrictive(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return RESTRICTIVENESS[a] <= RESTRICTIVENESS[b] ? a : b;
}

function findRule(rules: readonly PolicyRule[], action: PolicyAction): PolicyRule | undefined {
  return rules.find((rule) => rule.command === action.command && rule.cwd === action.cwd);
}

// Pure precedence resolver over the three scopes. Deny wins across every scope;
// otherwise the most specific scope (temporary > project > user) sets the base
// decision, which is then clamped to the user policy as a ceiling. With no
// matching rule the decision defaults to ask.
export class PolicyEngine {
  constructor(
    private readonly user: readonly PolicyRule[],
    private readonly project: readonly PolicyRule[],
    private readonly temporary: readonly PolicyRule[],
  ) {}

  decide(action: PolicyAction): PolicyOutcome {
    const userRule = findRule(this.user, action);
    const projectRule = findRule(this.project, action);
    const tempRule = findRule(this.temporary, action);

    if (userRule?.decision === 'deny') {
      return { decision: 'deny', reason: 'denied by user policy' };
    }
    if (projectRule?.decision === 'deny') {
      return { decision: 'deny', reason: 'denied by project policy' };
    }
    if (tempRule?.decision === 'deny') {
      return { decision: 'deny', reason: 'denied by temporary override' };
    }

    // The user policy is the ceiling: nothing below it may broaden past it.
    const ceiling: PolicyDecision = userRule?.decision ?? 'ask';
    const base: PolicyDecision = tempRule?.decision ?? projectRule?.decision ?? ceiling;
    const decision = moreRestrictive(base, ceiling);

    let reason: string;
    if (tempRule !== undefined) {
      reason =
        decision === tempRule.decision
          ? `temporary override: ${decision}`
          : `temporary override ${tempRule.decision} capped by user policy: ${decision}`;
    } else if (projectRule !== undefined) {
      reason =
        decision === projectRule.decision
          ? `project policy: ${decision}`
          : `project ${projectRule.decision} capped by user policy: ${decision}`;
    } else if (userRule !== undefined) {
      reason = `user policy: ${decision}`;
    } else {
      reason = `no matching rule; defaults to ${decision}`;
    }
    return { decision, reason };
  }
}

function isDecision(value: unknown): value is PolicyDecision {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

function isRule(value: unknown): value is PolicyRule {
  const v = value as { command?: unknown; cwd?: unknown; decision?: unknown };
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof v.command === 'string' &&
    typeof v.cwd === 'string' &&
    isDecision(v.decision)
  );
}

function isAuditEntry(value: unknown): value is PolicyAuditEntry {
  const v = value as Record<string, unknown>;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof v.at === 'string' &&
    typeof v.command === 'string' &&
    typeof v.cwd === 'string' &&
    isDecision(v.decision)
  );
}

function readRules(path: string | null): PolicyRule[] {
  if (path === null) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(isRule) : [];
  } catch {
    return [];
  }
}

function writeRules(path: string | null, rules: readonly PolicyRule[]): void {
  if (path === null) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rules, null, 2) + '\n', 'utf8');
}

function readAudit(path: string | null): PolicyAuditEntry[] {
  if (path === null) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(isAuditEntry) : [];
  } catch {
    return [];
  }
}

// Loads and persists user- and project-scoped rules, holds session-only
// temporary overrides, and records every decision and mutation to an audit
// trail. Rules match on exact (command, cwd); there is no globbing or prefix
// matching, so a policy can never broaden a command it does not name exactly.
export class PolicyStore {
  private user: PolicyRule[] = [];
  private project: PolicyRule[] = [];
  private temporary: PolicyRule[] = [];
  private auditLog: PolicyAuditEntry[] = [];

  private constructor(private readonly paths: PolicyPaths) {}

  static empty(): PolicyStore {
    return new PolicyStore({ user: null, project: null, audit: null });
  }

  static load(paths: PolicyPaths): PolicyStore {
    const store = new PolicyStore(paths);
    store.user = readRules(paths.user);
    store.project = readRules(paths.project);
    store.auditLog = readAudit(paths.audit);
    return store;
  }

  engine(): PolicyEngine {
    return new PolicyEngine(this.user, this.project, this.temporary);
  }

  decide(action: PolicyAction): PolicyOutcome {
    const outcome = this.engine().decide(action);
    this.record({
      at: new Date().toISOString(),
      scope: 'engine',
      command: action.command,
      cwd: action.cwd,
      decision: outcome.decision,
      action: 'decide',
    });
    return outcome;
  }

  list(scope: PolicyScope): readonly PolicyRule[] {
    return this.rulesFor(scope).slice();
  }

  set(scope: PolicyScope, rule: PolicyRule): void {
    const rules = this.rulesFor(scope);
    const index = rules.findIndex((r) => r.command === rule.command && r.cwd === rule.cwd);
    if (index >= 0) rules[index] = rule;
    else rules.push(rule);
    this.persist(scope);
    this.record({
      at: new Date().toISOString(),
      scope,
      command: rule.command,
      cwd: rule.cwd,
      decision: rule.decision,
      action: 'set',
    });
  }

  revoke(scope: PolicyScope, command: string, cwd: string): boolean {
    const rules = this.rulesFor(scope);
    const index = rules.findIndex((r) => r.command === command && r.cwd === cwd);
    if (index < 0) return false;
    const removed = rules[index];
    if (removed === undefined) return false;
    rules.splice(index, 1);
    this.persist(scope);
    this.record({
      at: new Date().toISOString(),
      scope,
      command,
      cwd,
      decision: removed.decision,
      action: 'revoke',
    });
    return true;
  }

  audit(): readonly PolicyAuditEntry[] {
    return this.auditLog.slice();
  }

  private rulesFor(scope: PolicyScope): PolicyRule[] {
    if (scope === 'user') return this.user;
    if (scope === 'project') return this.project;
    return this.temporary;
  }

  private persist(scope: PolicyScope): void {
    if (scope === 'user') writeRules(this.paths.user, this.user);
    else if (scope === 'project') writeRules(this.paths.project, this.project);
    // Temporary overrides live only for the session and are never written down.
  }

  private record(entry: PolicyAuditEntry): void {
    this.auditLog.push(entry);
    if (this.auditLog.length > MAX_AUDIT_ENTRIES) {
      this.auditLog = this.auditLog.slice(this.auditLog.length - MAX_AUDIT_ENTRIES);
    }
    if (this.paths.audit !== null) {
      mkdirSync(dirname(this.paths.audit), { recursive: true });
      writeFileSync(this.paths.audit, JSON.stringify(this.auditLog, null, 2) + '\n', 'utf8');
    }
  }
}

// Default policy locations, overridable via environment so tests and E2E runs
// can point every scope at a throwaway directory instead of the operator's real
// home or repository.
export function defaultPolicyPaths(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
): PolicyPaths {
  return {
    user: env.OMC_USER_POLICY_PATH ?? join(homedir(), '.omc', 'policies.json'),
    project: env.OMC_PROJECT_POLICY_PATH ?? join(workspace, '.omc', 'policies.json'),
    audit: env.OMC_POLICY_AUDIT_PATH ?? join(workspace, '.omc', 'policy-audit.json'),
  };
}
