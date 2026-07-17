import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

// Repository context is gathered from real files on disk — never from
// assumptions — so the agent can orient before coding. Discovery is strictly
// read-only: the only subprocess calls are `git rev-parse` and `git status`,
// which never mutate the working tree.

export interface InstructionFile {
  /** Path relative to the root, e.g. `AGENTS.md` or `packages/api/AGENTS.md`. */
  path: string;
  /** Subtree the instruction governs: `.` for the root, `packages/api` when nested. */
  scope: string;
  /** The instruction file name, e.g. `AGENTS.md`. */
  kind: string;
}

export interface PackageInfo {
  /** Directory containing the manifest, relative to the root (`.` for the root). */
  path: string;
  name: string;
  manifest: string;
  scripts: string[];
}

export interface GitState {
  isRepo: boolean;
  branch: string | null;
  modified: string[];
  untracked: string[];
}

export interface RepoContext {
  root: string;
  instructions: InstructionFile[];
  packages: PackageInfo[];
  buildTools: string[];
  testCommands: string[];
  git: GitState;
}

const INSTRUCTION_NAMES = ['AGENTS.md', 'QWEN.md', 'CLAUDE.md', 'GEMINI.md', 'README.md'];

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.qwen',
  '.local',
  '.autonomy',
  '.omc',
  'artifacts',
  'vendor',
  'target',
  '__pycache__',
]);

const TEST_TARGETS = ['test', 'unit', 'integration', 'smoke', 'e2e', 'check'];

const MAX_DIRS = 4000;
const MAX_INSTRUCTIONS = 50;
const MAX_PACKAGES = 100;
const MAX_GIT_ENTRIES = 100;

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

// Walk every non-hidden, non-skipped directory beneath the root. The root is
// returned separately by callers so its own manifests/instructions are included.
function walkSubdirs(root: string): string[] {
  const dirs: string[] = [];
  let count = 0;
  function walk(current: string): void {
    if (count >= MAX_DIRS) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = join(current, entry.name);
      count += 1;
      dirs.push(full);
      if (count >= MAX_DIRS) return;
      walk(full);
    }
  }
  walk(root);
  return dirs;
}

export function discoverInstructions(root: string): InstructionFile[] {
  const result: InstructionFile[] = [];
  for (const dir of [root, ...walkSubdirs(root)]) {
    for (const kind of INSTRUCTION_NAMES) {
      if (result.length >= MAX_INSTRUCTIONS) return result;
      if (!existsSync(join(dir, kind))) continue;
      const scope = toPosix(relative(root, dir)) || '.';
      const path = scope === '.' ? kind : `${scope}/${kind}`;
      result.push({ path, scope, kind });
    }
  }
  return result;
}

// Resolve which instructions govern a target path: the root instruction plus
// every nested instruction whose scope is an ancestor of (or equal to) the
// target. This is how nested guidance is applied according to scope.
export function resolveInstructions(
  instructions: readonly InstructionFile[],
  targetPath: string,
): InstructionFile[] {
  const target = toPosix(targetPath).replace(/^\.\//, '');
  return instructions.filter((instruction) => {
    if (instruction.scope === '.') return true;
    const scope = toPosix(instruction.scope);
    return target === scope || target.startsWith(`${scope}/`);
  });
}

export function discoverPackages(root: string): PackageInfo[] {
  const result: PackageInfo[] = [];
  for (const dir of [root, ...walkSubdirs(root)]) {
    if (result.length >= MAX_PACKAGES) break;
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const rel = toPosix(relative(root, dir)) || '.';
    let name: string | undefined;
    let scripts: string[] = [];
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: unknown;
        scripts?: unknown;
      };
      if (typeof parsed.name === 'string') name = parsed.name;
      if (parsed.scripts !== null && typeof parsed.scripts === 'object') {
        scripts = Object.keys(parsed.scripts as Record<string, unknown>);
      }
    } catch {
      // An unreadable or invalid manifest still counts as a package; fall back
      // to the directory name so the package is reported by location.
    }
    if (name === undefined) name = rel === '.' ? basename(root) : basename(rel);
    result.push({ path: rel, name, manifest: 'package.json', scripts });
  }
  return result;
}

export function discoverGitState(root: string): GitState {
  const inside = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    return { isRepo: false, branch: null, modified: [], untracked: [] };
  }
  const branchOut = spawnSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  });
  const branchText = branchOut.status === 0 ? branchOut.stdout.trim() : '';
  const branch = branchText.length > 0 ? branchText : null;

  const status = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' });
  const modified: string[] = [];
  const untracked: string[] = [];
  if (status.status === 0) {
    for (const line of status.stdout.split('\n')) {
      if (line.length < 4) continue;
      const flags = line.slice(0, 2);
      const file = line.slice(3);
      if (flags === '??') {
        if (untracked.length < MAX_GIT_ENTRIES) untracked.push(file);
      } else if (modified.length < MAX_GIT_ENTRIES) {
        modified.push(file);
      }
    }
  }
  return { isRepo: true, branch, modified, untracked };
}

export function detectBuildTools(root: string): string[] {
  const tools: string[] = [];
  if (existsSync(join(root, 'Makefile')) || existsSync(join(root, 'makefile'))) {
    tools.push('make');
  }
  if (existsSync(join(root, 'tsconfig.json'))) tools.push('tsc');
  if (existsSync(join(root, 'package.json'))) tools.push('npm');
  if (existsSync(join(root, 'Cargo.toml'))) tools.push('cargo');
  if (existsSync(join(root, 'go.mod'))) tools.push('go');
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'setup.py'))) {
    tools.push('python');
  }
  return tools;
}

function parseMakeTargets(content: string): Set<string> {
  const targets = new Set<string>();
  const pattern = /^([A-Za-z0-9_.-]+):/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const name = match[1];
    if (name !== undefined && name !== '.PHONY') targets.add(name);
  }
  return targets;
}

function readMakefile(root: string): string | null {
  for (const name of ['Makefile', 'makefile']) {
    const path = join(root, name);
    if (existsSync(path)) {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function inferTestCommands(root: string, packages: readonly PackageInfo[]): string[] {
  const commands: string[] = [];
  const makefile = readMakefile(root);
  if (makefile !== null) {
    const targets = parseMakeTargets(makefile);
    for (const target of TEST_TARGETS) {
      if (targets.has(target)) commands.push(`make ${target}`);
    }
  }
  for (const pkg of packages) {
    if (pkg.scripts.includes('test')) {
      commands.push(pkg.path === '.' ? 'npm test' : `npm test --prefix ${pkg.path}`);
    }
  }
  return commands;
}

export function discoverContext(root: string): RepoContext {
  const abs = resolve(root);
  const instructions = discoverInstructions(abs);
  const packages = discoverPackages(abs);
  return {
    root: abs,
    instructions,
    packages,
    buildTools: detectBuildTools(abs),
    testCommands: inferTestCommands(abs, packages),
    git: discoverGitState(abs),
  };
}

export function formatContextSummary(context: RepoContext): string {
  const lines: string[] = [];
  lines.push(`Repository context for ${context.root}`);
  lines.push('');

  lines.push('Instructions (resolved by scope):');
  if (context.instructions.length === 0) {
    lines.push('  (none found)');
  } else {
    for (const instruction of context.instructions) {
      lines.push(`  - ${instruction.path}  (scope: ${instruction.scope})`);
    }
  }
  lines.push('');

  lines.push('Packages:');
  if (context.packages.length === 0) {
    lines.push('  (none found)');
  } else {
    for (const pkg of context.packages) {
      const scripts = pkg.scripts.length > 0 ? `scripts: ${pkg.scripts.join(', ')}` : 'no scripts';
      lines.push(`  - ${pkg.path}  ${pkg.name}  [${pkg.manifest}]  ${scripts}`);
    }
  }
  lines.push('');

  lines.push(
    `Build tools: ${context.buildTools.length > 0 ? context.buildTools.join(', ') : 'none detected'}`,
  );
  lines.push('');

  lines.push('Focused test commands:');
  if (context.testCommands.length === 0) {
    lines.push('  (none detected)');
  } else {
    for (const command of context.testCommands) {
      lines.push(`  - ${command}`);
    }
  }
  lines.push('');

  const git = context.git;
  if (!git.isRepo) {
    lines.push('Git: not a repository');
  } else {
    lines.push(
      `Git: branch ${git.branch ?? 'detached'}  ·  ${git.modified.length} modified  ·  ${git.untracked.length} untracked  (read-only)`,
    );
    if (git.modified.length > 0) {
      lines.push(`  modified: ${git.modified.join(', ')}`);
    }
    if (git.untracked.length > 0) {
      lines.push(`  untracked: ${git.untracked.join(', ')}`);
    }
  }

  return lines.join('\n');
}
