import { inspectRepo, type GitStatusEntry } from './git.js';

export interface HandoffChange {
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface HandoffSummary {
  isRepo: boolean;
  detached: boolean;
  branch: string | null;
  agentOwned: HandoffChange[];
  preExisting: HandoffChange[];
  conflicted: HandoffChange[];
  proposal: string;
}

function toChange(entry: GitStatusEntry): HandoffChange {
  return {
    path: entry.path,
    staged: entry.staged,
    unstaged: entry.unstaged,
    untracked: entry.untracked,
    conflicted: entry.conflicted,
  };
}

// Partition the working tree into agent-owned changes (files this session
// edited) and pre-existing changes (dirty files the agent never touched), so a
// handoff can stage only the agent's own work without sweeping in unrelated
// files. Conflicted entries are surfaced separately because they block a commit.
export function summarizeHandoff(cwd: string, agentTouched: ReadonlySet<string>): HandoffSummary {
  const inspection = inspectRepo(cwd);
  const agentOwned: HandoffChange[] = [];
  const preExisting: HandoffChange[] = [];
  const conflicted: HandoffChange[] = [];
  for (const entry of inspection.entries) {
    const change = toChange(entry);
    if (entry.conflicted) {
      conflicted.push(change);
    } else if (agentTouched.has(entry.path)) {
      agentOwned.push(change);
    } else {
      preExisting.push(change);
    }
  }
  return {
    isRepo: inspection.isRepo,
    detached: inspection.detached,
    branch: inspection.branch,
    agentOwned,
    preExisting,
    conflicted,
    proposal: proposeCommitMessage(agentOwned, inspection.branch),
  };
}

function inferCommitType(paths: readonly string[]): string {
  if (paths.length === 0) return 'chore';
  const isDoc = (p: string): boolean => /\.md$/i.test(p);
  const isTest = (p: string): boolean =>
    /(^|\/)(test|tests)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(p);
  const isSrc = (p: string): boolean => /(^|\/)src\//.test(p);
  if (paths.every(isDoc)) return 'docs';
  if (paths.every(isTest)) return 'test';
  if (paths.some(isSrc)) return 'feat';
  return 'chore';
}

// Draft a conventional-commit message for the agent-owned files. It is a
// proposal the operator reviews before committing, never an automatic message.
export function proposeCommitMessage(
  agentOwned: readonly HandoffChange[],
  branch: string | null,
): string {
  const paths = agentOwned.map((change) => change.path);
  if (paths.length === 0) return '';
  const type = inferCommitType(paths);
  const scope = branch !== null && branch.length > 0 ? `(${branch})` : '';
  const subject = `${type}${scope}: handoff ${paths.length} changed file${paths.length === 1 ? '' : 's'}`;
  const body = paths.map((path) => `- ${path}`).join('\n');
  return `${subject}\n\n${body}`;
}

function changeLabel(change: HandoffChange): string {
  if (change.untracked) return 'untracked';
  const parts: string[] = [];
  if (change.staged) parts.push('staged');
  if (change.unstaged) parts.push('modified');
  return parts.length > 0 ? parts.join('+') : 'changed';
}

export function formatHandoffSummary(summary: HandoffSummary): string {
  if (!summary.isRepo) {
    return 'Git handoff: not a Git repository.';
  }
  const lines: string[] = [];
  if (summary.detached) {
    lines.push('Git handoff: DETACHED HEAD — create a branch before committing.');
  } else {
    lines.push(`Git handoff for branch: ${summary.branch ?? 'unknown'}`);
  }
  lines.push('');

  lines.push(`Agent-owned changes (${summary.agentOwned.length}):`);
  if (summary.agentOwned.length === 0) {
    lines.push('  (none — no files edited this session are dirty)');
  } else {
    for (const change of summary.agentOwned) {
      lines.push(`  ${changeLabel(change)}  ${change.path}`);
    }
  }
  lines.push('');

  lines.push(`Pre-existing changes — NOT staged by /handoff (${summary.preExisting.length}):`);
  if (summary.preExisting.length === 0) {
    lines.push('  (none)');
  } else {
    for (const change of summary.preExisting) {
      lines.push(`  ${changeLabel(change)}  ${change.path}`);
    }
  }

  if (summary.conflicted.length > 0) {
    lines.push('');
    lines.push(`Conflicts — resolve before committing (${summary.conflicted.length}):`);
    for (const change of summary.conflicted) {
      lines.push(`  ${change.path}`);
    }
  }

  lines.push('');
  if (summary.agentOwned.length === 0) {
    lines.push('Nothing to hand off. Edit files, then re-run /handoff.');
  } else if (summary.detached || summary.conflicted.length > 0) {
    lines.push('Resolve the above before /handoff commit.');
  } else {
    lines.push('Proposed commit message:');
    for (const line of summary.proposal.split('\n')) {
      lines.push(`  ${line}`);
    }
    lines.push('');
    lines.push('Run /handoff commit to stage and commit only the agent-owned files.');
  }
  return lines.join('\n');
}
