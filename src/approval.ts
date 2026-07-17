import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function defaultApprovalPath(workspace: string): string {
  return join(workspace, '.omc', 'approvals.json');
}

export type Risk = 'low' | 'medium' | 'high';

export type ApprovalOutcome = 'allow-once' | 'allow-rule' | 'deny' | 'cancel' | 'timeout';

export interface ApprovalRequest {
  command: string;
  cwd: string;
  risk: Risk;
  scope: string;
}

export interface ApprovalRule {
  command: string;
  cwd: string;
}

const HIGH_RISK_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*f/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\s*\(\s*\)\s*\{/,
  />\s*\/dev\//,
  /\|\s*(?:sh|bash|zsh)\b/,
  /\bchmod\s+-R\b/,
  /\b(?:shutdown|reboot|halt|poweroff)\b/,
  /\bkill\s+-9\b/,
];

const WRITE_PATTERNS: readonly RegExp[] = [
  /\b(?:npm|pnpm|yarn)\s+(?:install|i|add)\b/,
  /\bpip\s+install\b/,
  /\bgit\s+(?:push|commit|merge|reset|rebase|checkout|switch)\b/,
  /\b(?:mv|cp|rm|rmdir|mkdir|touch|tee|chmod|chown|ln)\b/,
  /\bmake\b/,
  />/,
];

export function classifyRisk(command: string): Risk {
  if (HIGH_RISK_PATTERNS.some((pattern) => pattern.test(command))) return 'high';
  if (WRITE_PATTERNS.some((pattern) => pattern.test(command))) return 'medium';
  return 'low';
}

export function describeScope(cwd: string): string {
  return `run this exact command in ${cwd}`;
}

export function buildRequest(command: string, cwd: string): ApprovalRequest {
  return { command, cwd, risk: classifyRisk(command), scope: describeScope(cwd) };
}

export function isAllowed(outcome: ApprovalOutcome): boolean {
  return outcome === 'allow-once' || outcome === 'allow-rule';
}

function isRule(value: unknown): value is ApprovalRule {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as { command?: unknown }).command === 'string'
    && typeof (value as { cwd?: unknown }).cwd === 'string'
  );
}

// Persists approved commands as EXACT (command, cwd) pairs. Matching requires
// equality on both fields, so a stored rule can never broaden to a different
// command, a different directory, or a command prefix implicitly.
export class ApprovalStore {
  private constructor(
    private readonly path: string | null,
    private readonly entries: ApprovalRule[],
  ) {}

  static empty(): ApprovalStore {
    return new ApprovalStore(null, []);
  }

  static load(path: string): ApprovalStore {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const entries = Array.isArray(parsed) ? parsed.filter(isRule) : [];
      return new ApprovalStore(path, entries);
    } catch {
      return new ApprovalStore(path, []);
    }
  }

  matches(request: ApprovalRequest): boolean {
    return this.entries.some(
      (rule) => rule.command === request.command && rule.cwd === request.cwd,
    );
  }

  has(rule: ApprovalRule): boolean {
    return this.entries.some(
      (entry) => entry.command === rule.command && entry.cwd === rule.cwd,
    );
  }

  add(rule: ApprovalRule): void {
    if (this.has(rule)) return;
    this.entries.push({ command: rule.command, cwd: rule.cwd });
    if (this.path !== null) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.entries, null, 2) + '\n', 'utf8');
    }
  }

  list(): readonly ApprovalRule[] {
    return this.entries;
  }
}
