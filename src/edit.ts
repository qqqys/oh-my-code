import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { isProtectedPath, isSecretPath, resolveSafePath } from './tools.js';

export type EditStatus = 'applied' | 'rejected' | 'reverted' | 'conflict' | 'error';

export type DiffKind = 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export interface EditRequest {
  path: string;
  oldString: string;
  newString: string;
}

// A fully described edit: the absolute target, the exact substitution, and the
// file content immediately before and after the change. beforeContent/afterContent
// let the renderer and revert reason about the operation without re-reading.
export interface EditOperation {
  path: string;
  relativePath: string;
  oldString: string;
  newString: string;
  beforeContent: string;
  afterContent: string;
}

export interface EditPrepared {
  operation: EditOperation;
  diff: DiffLine[];
  added: number;
  removed: number;
}

export interface EditFailure {
  status: 'conflict' | 'error';
  error: string;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// Trim common leading and trailing lines so the rendered diff shows only the
// changed region, reading like a conventional unified diff.
export function diffLines(oldString: string, newString: string): DiffLine[] {
  const oldLines = oldString.split('\n');
  const newLines = newString.split('\n');

  let start = 0;
  while (
    start < oldLines.length
    && start < newLines.length
    && oldLines[start] === newLines[start]
  ) {
    start += 1;
  }

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const diff: DiffLine[] = [];
  for (let i = start; i < oldEnd; i++) {
    diff.push({ kind: 'del', text: oldLines[i] ?? '' });
  }
  for (let i = start; i < newEnd; i++) {
    diff.push({ kind: 'add', text: newLines[i] ?? '' });
  }
  return diff;
}

export function countChanges(diff: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff) {
    if (line.kind === 'add') added += 1;
    else if (line.kind === 'del') removed += 1;
  }
  return { added, removed };
}

// Resolve and validate the target, then verify the expected pre-edit content is
// present exactly once. Performs no write. The unique-match requirement is the
// pre-edit guard: a missing or ambiguous match fails closed instead of guessing.
export function prepareEdit(request: EditRequest, workspace: string): EditPrepared | EditFailure {
  const resolved = resolveSafePath(workspace, request.path);
  if (resolved === null) {
    return { status: 'error', error: `Path escapes the workspace: ${request.path}` };
  }
  if (isProtectedPath(resolved, workspace)) {
    return { status: 'error', error: `Path is protected: ${request.path}` };
  }
  if (isSecretPath(resolved)) {
    return { status: 'error', error: `Path may contain secrets: ${request.path}` };
  }
  if (request.oldString.length === 0) {
    return { status: 'error', error: 'No pre-edit content specified.' };
  }
  if (request.oldString === request.newString) {
    return { status: 'error', error: 'Old and new content are identical.' };
  }

  let content: string;
  try {
    content = readFileSync(resolved, 'utf8');
  } catch {
    return { status: 'error', error: `Cannot read path: ${request.path}` };
  }

  const occurrences = countOccurrences(content, request.oldString);
  if (occurrences === 0) {
    return { status: 'conflict', error: 'Expected pre-edit content not found.' };
  }
  if (occurrences > 1) {
    return {
      status: 'conflict',
      error: `Expected pre-edit content is ambiguous (${occurrences} matches).`,
    };
  }

  const afterContent = content.replace(request.oldString, request.newString);
  const operation: EditOperation = {
    path: resolved,
    relativePath: relative(resolve(workspace), resolved),
    oldString: request.oldString,
    newString: request.newString,
    beforeContent: content,
    afterContent,
  };
  const diff = diffLines(request.oldString, request.newString);
  return { operation, diff, ...countChanges(diff) };
}

// Apply a prepared edit. Re-validates against the file's CURRENT content so a
// concurrent change fails closed instead of overwriting unrelated user work:
// the substitution only proceeds when the expected content still matches once.
export function commitEdit(
  operation: EditOperation,
): { status: 'applied'; operation: EditOperation } | EditFailure {
  let current: string;
  try {
    current = readFileSync(operation.path, 'utf8');
  } catch {
    return { status: 'conflict', error: 'File changed; cannot apply edit.' };
  }
  if (countOccurrences(current, operation.oldString) !== 1) {
    return {
      status: 'conflict',
      error: 'File changed; expected pre-edit content no longer matches uniquely.',
    };
  }
  const afterContent = current.replace(operation.oldString, operation.newString);
  writeFileSync(operation.path, afterContent, 'utf8');
  return {
    status: 'applied',
    operation: { ...operation, beforeContent: current, afterContent },
  };
}

// Revert a previously applied edit by reversing only this operation's
// substitution. Fails closed when the edited content is not uniquely present,
// so unrelated changes made after the edit are never disturbed.
export function revertEdit(operation: EditOperation): { status: 'reverted' } | EditFailure {
  let current: string;
  try {
    current = readFileSync(operation.path, 'utf8');
  } catch {
    return { status: 'conflict', error: 'File changed; cannot revert.' };
  }
  if (countOccurrences(current, operation.newString) !== 1) {
    return { status: 'conflict', error: 'Cannot revert; edited content not uniquely present.' };
  }
  const reverted = current.replace(operation.newString, operation.oldString);
  writeFileSync(operation.path, reverted, 'utf8');
  return { status: 'reverted' };
}
