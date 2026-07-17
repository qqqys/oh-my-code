import { spawnSync } from 'node:child_process';

// A single working-tree entry from `git status --porcelain`. The flags are
// decoded so callers can tell staged, unstaged, untracked, and conflicted
// changes apart without re-parsing Git's output.
export interface GitStatusEntry {
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitInspection {
  isRepo: boolean;
  detached: boolean;
  branch: string | null;
  entries: GitStatusEntry[];
}

export interface GitResult {
  ok: boolean;
  output: string;
}

const MAX_ENTRIES = 500;

// Unmerged (conflict) XY codes from git-status(1). Any of these means the path
// is in a conflicted state and must be resolved before a commit can succeed.
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function git(
  cwd: string,
  args: readonly string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// Read-only inspection of a repository: whether it is a repo, whether HEAD is
// detached, the current branch, and every dirty path. Never mutates the tree.
export function inspectRepo(cwd: string): GitInspection {
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    return { isRepo: false, detached: false, branch: null, entries: [] };
  }
  // A successful symbolic-ref means HEAD points at a branch; failure means the
  // working tree is in a detached-HEAD state.
  const symbolic = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const detached = symbolic.status !== 0;
  const branch = detached ? null : symbolic.stdout.trim() || null;

  const status = git(cwd, ['status', '--porcelain']);
  const entries: GitStatusEntry[] = [];
  if (status.status === 0) {
    for (const line of status.stdout.split('\n')) {
      if (line.length < 4) continue;
      const code = line.slice(0, 2);
      const x = code.charAt(0);
      const y = code.charAt(1);
      let path = line.slice(3);
      // Renames are reported as "old -> new"; the destination is what matters.
      const arrow = path.indexOf(' -> ');
      if (arrow !== -1) path = path.slice(arrow + 4);
      const untracked = code === '??';
      const conflicted = CONFLICT_CODES.has(code);
      const staged = x !== ' ' && x !== '?';
      const unstaged = y !== ' ' && y !== '?';
      if (entries.length >= MAX_ENTRIES) break;
      entries.push({ path, staged, unstaged, untracked, conflicted });
    }
  }
  return { isRepo: true, detached, branch, entries };
}

// Stage exactly the named paths (`git add -- <files>`), never `git add -A`, so a
// handoff can commit only the files it selected and leave everything else alone.
export function stageFiles(cwd: string, files: readonly string[]): GitResult {
  if (files.length === 0) return { ok: true, output: '' };
  const result = git(cwd, ['add', '--', ...files]);
  return { ok: result.status === 0, output: (result.stdout + result.stderr).trim() };
}

export function createBranch(cwd: string, name: string): GitResult {
  const result = git(cwd, ['switch', '-c', name]);
  return { ok: result.status === 0, output: (result.stdout + result.stderr).trim() };
}

// Create a commit with the given message. A non-zero exit (pre-commit hook
// failure, nothing staged, etc.) is reported through `ok: false` with Git's own
// output so the caller can surface a recoverable state instead of guessing.
export function commitRepo(cwd: string, message: string): GitResult {
  const result = git(cwd, ['commit', '-m', message]);
  return { ok: result.status === 0, output: (result.stdout + result.stderr).trim() };
}
