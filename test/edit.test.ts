import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitEdit, countChanges, diffLines, prepareEdit, revertEdit } from '../src/edit.js';

describe('diffLines', () => {
  it('shows only the changed region with common context trimmed', () => {
    const diff = diffLines('a\nb\nc', 'a\nB\nc');
    expect(diff).toEqual([
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
    ]);
    expect(countChanges(diff)).toEqual({ added: 1, removed: 1 });
  });

  it('reports a pure addition', () => {
    const diff = diffLines('a', 'a\nb');
    expect(diff).toEqual([{ kind: 'add', text: 'b' }]);
    expect(countChanges(diff)).toEqual({ added: 1, removed: 0 });
  });

  it('reports a pure deletion', () => {
    const diff = diffLines('a\nb', 'a');
    expect(diff).toEqual([{ kind: 'del', text: 'b' }]);
    expect(countChanges(diff)).toEqual({ added: 0, removed: 1 });
  });
});

describe('prepareEdit', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'oh-my-code-edit-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function write(relativePath: string, content: string): void {
    writeFileSync(join(directory, relativePath), content, 'utf8');
  }

  it('prepares an edit when the pre-edit content matches once', () => {
    write('a.txt', 'alpha\nbeta\ngamma\n');
    const prepared = prepareEdit(
      { path: 'a.txt', oldString: 'beta', newString: 'BETA' },
      directory,
    );
    expect('operation' in prepared).toBe(true);
    if ('operation' in prepared) {
      expect(prepared.operation.afterContent).toBe('alpha\nBETA\ngamma\n');
      expect(prepared.added).toBe(1);
      expect(prepared.removed).toBe(1);
    }
  });

  it('does not write during preparation', () => {
    write('a.txt', 'beta');
    prepareEdit({ path: 'a.txt', oldString: 'beta', newString: 'BETA' }, directory);
    expect(readFileSync(join(directory, 'a.txt'), 'utf8')).toBe('beta');
  });

  it('fails closed when the pre-edit content is absent', () => {
    write('a.txt', 'alpha');
    const result = prepareEdit(
      { path: 'a.txt', oldString: 'missing', newString: 'x' },
      directory,
    );
    expect('status' in result && result.status).toBe('conflict');
  });

  it('fails closed when the pre-edit content is ambiguous', () => {
    write('a.txt', 'dup\ndup\n');
    const result = prepareEdit({ path: 'a.txt', oldString: 'dup', newString: 'x' }, directory);
    expect('status' in result && result.status).toBe('conflict');
  });

  it('rejects paths that escape the workspace', () => {
    const result = prepareEdit(
      { path: '../escape.txt', oldString: 'a', newString: 'b' },
      directory,
    );
    expect('status' in result && result.status).toBe('error');
  });

  it('rejects protected paths', () => {
    mkdirSync(join(directory, '.omc'), { recursive: true });
    write('.omc/x.txt', 'a');
    const result = prepareEdit({ path: '.omc/x.txt', oldString: 'a', newString: 'b' }, directory);
    expect('status' in result && result.status).toBe('error');
  });

  it('rejects secret paths', () => {
    write('.env', 'SECRET=a');
    const result = prepareEdit(
      { path: '.env', oldString: 'SECRET=a', newString: 'SECRET=b' },
      directory,
    );
    expect('status' in result && result.status).toBe('error');
  });

  it('rejects a no-op edit', () => {
    write('a.txt', 'same');
    const result = prepareEdit({ path: 'a.txt', oldString: 'same', newString: 'same' }, directory);
    expect('status' in result && result.status).toBe('error');
  });
});

describe('commitEdit', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'oh-my-code-commit-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('applies the edit to disk', () => {
    writeFileSync(join(directory, 'a.txt'), 'beta', 'utf8');
    const prepared = prepareEdit(
      { path: 'a.txt', oldString: 'beta', newString: 'BETA' },
      directory,
    );
    if (!('operation' in prepared)) throw new Error('expected prepared edit');
    const committed = commitEdit(prepared.operation);
    expect(committed.status).toBe('applied');
    expect(readFileSync(join(directory, 'a.txt'), 'utf8')).toBe('BETA');
  });

  it('fails closed when the file changed before commit', () => {
    writeFileSync(join(directory, 'a.txt'), 'beta', 'utf8');
    const prepared = prepareEdit(
      { path: 'a.txt', oldString: 'beta', newString: 'BETA' },
      directory,
    );
    if (!('operation' in prepared)) throw new Error('expected prepared edit');
    // A concurrent change removes the expected pre-edit content.
    writeFileSync(join(directory, 'a.txt'), 'changed by user', 'utf8');
    const committed = commitEdit(prepared.operation);
    expect(committed.status).toBe('conflict');
    expect(readFileSync(join(directory, 'a.txt'), 'utf8')).toBe('changed by user');
  });
});

describe('revertEdit', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'oh-my-code-revert-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('reverses only the applied substitution and preserves unrelated changes', () => {
    writeFileSync(join(directory, 'a.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
    const prepared = prepareEdit(
      { path: 'a.txt', oldString: 'beta', newString: 'BETA' },
      directory,
    );
    if (!('operation' in prepared)) throw new Error('expected prepared edit');
    const committed = commitEdit(prepared.operation);
    if (committed.status !== 'applied') throw new Error('expected applied edit');

    // An unrelated edit lands elsewhere after our apply.
    writeFileSync(join(directory, 'a.txt'), 'alpha\nBETA\nGAMMA\n', 'utf8');

    const reverted = revertEdit(committed.operation);
    expect(reverted.status).toBe('reverted');
    // beta is restored; the unrelated GAMMA change is left intact.
    expect(readFileSync(join(directory, 'a.txt'), 'utf8')).toBe('alpha\nbeta\nGAMMA\n');
  });

  it('fails closed when the edited content is no longer uniquely present', () => {
    writeFileSync(join(directory, 'a.txt'), 'beta', 'utf8');
    const prepared = prepareEdit(
      { path: 'a.txt', oldString: 'beta', newString: 'BETA' },
      directory,
    );
    if (!('operation' in prepared)) throw new Error('expected prepared edit');
    const committed = commitEdit(prepared.operation);
    if (committed.status !== 'applied') throw new Error('expected applied edit');

    // The edited token now appears twice, so a targeted revert is ambiguous.
    writeFileSync(join(directory, 'a.txt'), 'BETA BETA', 'utf8');
    const reverted = revertEdit(committed.operation);
    expect(reverted.status).toBe('conflict');
    expect(readFileSync(join(directory, 'a.txt'), 'utf8')).toBe('BETA BETA');
  });
});
