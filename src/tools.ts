import { basename, join, relative, resolve, sep } from 'node:path';
import { readFileSync, readdirSync, type Dirent } from 'node:fs';

export interface ToolCall {
  name: string;
  args: Record<string, string>;
}

export interface ToolResult {
  name: string;
  output: string;
  truncated: boolean;
  error: string | null;
}

const MAX_ENTRIES = 200;
const MAX_OUTPUT_BYTES = 8192;
const MAX_LINES = 200;
const MAX_MATCHES = 50;
const MAX_FILES_SCAN = 500;

const PROTECTED_DIRS = new Set([
  '.git',
  'node_modules',
  '.qwen',
  '.local',
  '.autonomy',
  'dist',
  'coverage',
  'artifacts',
]);

const SECRET_PATTERNS = [
  /\.env$/,
  /\.env\./,
  /\.key$/,
  /\.pem$/,
  /\.secret$/,
  /credentials/i,
];

function relativePath(workspace: string, fullPath: string): string {
  return relative(resolve(workspace), fullPath);
}

function resolveSafePath(workspace: string, inputPath: string): string | null {
  const normalizedWorkspace = resolve(workspace);
  const resolved = resolve(normalizedWorkspace, inputPath);
  if (resolved !== normalizedWorkspace && !resolved.startsWith(normalizedWorkspace + sep)) {
    return null;
  }
  return resolved;
}

function isProtectedPath(fullPath: string, workspace: string): boolean {
  const parts = relativePath(workspace, fullPath).split(sep);
  return parts.some((part) => PROTECTED_DIRS.has(part));
}

function isSecretPath(fullPath: string): boolean {
  const base = basename(fullPath);
  return SECRET_PATTERNS.some((pattern) => pattern.test(base));
}

function isBinary(content: Buffer): boolean {
  return content.includes(0);
}

function collectFiles(dir: string, workspace: string): string[] {
  const files: string[] = [];
  function walk(current: string): void {
    if (files.length >= MAX_FILES_SCAN) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_FILES_SCAN) return;
      const fullPath = join(current, entry.name);
      if (isProtectedPath(fullPath, workspace)) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  walk(dir);
  return files;
}

function listFiles(args: Record<string, string>, workspace: string): ToolResult {
  const inputPath = args.path ?? '.';
  const resolved = resolveSafePath(workspace, inputPath);
  if (resolved === null) {
    return { name: 'list_files', output: '', truncated: false, error: `Path escapes the workspace: ${inputPath}` };
  }
  if (isProtectedPath(resolved, workspace)) {
    return { name: 'list_files', output: '', truncated: false, error: `Path is protected: ${inputPath}` };
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(resolved, { withFileTypes: true });
  } catch {
    return { name: 'list_files', output: '', truncated: false, error: `Cannot list path: ${inputPath}` };
  }
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  let truncated = false;
  for (let i = 0; i < sorted.length; i++) {
    if (i >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const entry = sorted[i];
    if (entry === undefined) continue;
    if (entry.name.startsWith('.')) continue;
    lines.push(entry.name + (entry.isDirectory() ? '/' : ''));
  }
  return { name: 'list_files', output: lines.join('\n'), truncated, error: null };
}

function readFile(args: Record<string, string>, workspace: string): ToolResult {
  const inputPath = args.path ?? '';
  if (inputPath.length === 0) {
    return { name: 'read_file', output: '', truncated: false, error: 'No path provided.' };
  }
  const resolved = resolveSafePath(workspace, inputPath);
  if (resolved === null) {
    return { name: 'read_file', output: '', truncated: false, error: `Path escapes the workspace: ${inputPath}` };
  }
  if (isProtectedPath(resolved, workspace)) {
    return { name: 'read_file', output: '', truncated: false, error: `Path is protected: ${inputPath}` };
  }
  if (isSecretPath(resolved)) {
    return { name: 'read_file', output: '', truncated: false, error: `Path may contain secrets: ${inputPath}` };
  }
  let content: Buffer;
  try {
    content = readFileSync(resolved);
  } catch {
    return { name: 'read_file', output: '', truncated: false, error: `Cannot read path: ${inputPath}` };
  }
  if (isBinary(content)) {
    return { name: 'read_file', output: `[binary file omitted: ${content.length} bytes]`, truncated: false, error: null };
  }
  const text = content.toString('utf8');
  const lines = text.split('\n');
  let output = text;
  let truncated = false;
  if (lines.length > MAX_LINES) {
    output = lines.slice(0, MAX_LINES).join('\n');
    truncated = true;
  }
  if (output.length > MAX_OUTPUT_BYTES) {
    output = output.slice(0, MAX_OUTPUT_BYTES);
    truncated = true;
  }
  return { name: 'read_file', output, truncated, error: null };
}

function searchContent(args: Record<string, string>, workspace: string): ToolResult {
  const pattern = args.pattern ?? '';
  if (pattern.length === 0) {
    return { name: 'search_content', output: '', truncated: false, error: 'No search pattern provided.' };
  }
  const inputPath = args.path ?? '.';
  const resolved = resolveSafePath(workspace, inputPath);
  if (resolved === null) {
    return { name: 'search_content', output: '', truncated: false, error: `Path escapes the workspace: ${inputPath}` };
  }
  const files = collectFiles(resolved, workspace);
  const matches: string[] = [];
  let truncated = false;
  for (const filePath of files) {
    if (matches.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    if (isSecretPath(filePath)) continue;
    let content: Buffer;
    try {
      content = readFileSync(filePath);
    } catch {
      continue;
    }
    if (isBinary(content)) continue;
    const lines = content.toString('utf8').split('\n');
    const rel = relativePath(workspace, filePath);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line !== undefined && line.includes(pattern)) {
        matches.push(`${rel}:${i + 1}: ${line.trim()}`);
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
      }
    }
  }
  return { name: 'search_content', output: matches.join('\n'), truncated, error: null };
}

export function executeTool(call: ToolCall, workspace: string): ToolResult {
  switch (call.name) {
    case 'list_files':
      return listFiles(call.args, workspace);
    case 'read_file':
      return readFile(call.args, workspace);
    case 'search_content':
      return searchContent(call.args, workspace);
    default:
      return { name: call.name, output: '', truncated: false, error: `Unknown tool: ${call.name}` };
  }
}

export const TOOL_NAMES = ['list_files', 'read_file', 'search_content'] as const;
