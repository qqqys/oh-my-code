import { describe, expect, it } from 'vitest';

import { ComposerState } from '../src/composer.js';

describe('ComposerState', () => {
  it('inserts ASCII text at the cursor', () => {
    const composer = new ComposerState();
    composer.insert('hello');
    expect(composer.input).toBe('hello');
    expect(composer.cursorPosition).toBe(5);
  });

  it('inserts Unicode text correctly', () => {
    const composer = new ComposerState();
    composer.insert('日本語');
    expect(composer.input).toBe('日本語');
    expect(composer.cursorPosition).toBe(3);
  });

  it('inserts emoji (surrogate pairs) correctly', () => {
    const composer = new ComposerState();
    composer.insert('👋🌍');
    expect(composer.input).toBe('👋🌍');
    expect(composer.cursorPosition).toBe(2);
  });

  it('inserts at cursor position', () => {
    const composer = new ComposerState();
    composer.insert('ac');
    composer.moveLeft();
    composer.insert('b');
    expect(composer.input).toBe('abc');
    expect(composer.cursorPosition).toBe(2);
  });

  it('handles backspace', () => {
    const composer = new ComposerState();
    composer.insert('abc');
    composer.backspace();
    expect(composer.input).toBe('ab');
    expect(composer.cursorPosition).toBe(2);
  });

  it('does not backspace at start', () => {
    const composer = new ComposerState();
    composer.backspace();
    expect(composer.input).toBe('');
    expect(composer.cursorPosition).toBe(0);
  });

  it('handles delete forward', () => {
    const composer = new ComposerState();
    composer.insert('abc');
    composer.moveToStart();
    composer.deleteForward();
    expect(composer.input).toBe('bc');
    expect(composer.cursorPosition).toBe(0);
  });

  it('moves cursor left and right', () => {
    const composer = new ComposerState();
    composer.insert('abc');
    composer.moveLeft();
    expect(composer.cursorPosition).toBe(2);
    composer.moveLeft();
    expect(composer.cursorPosition).toBe(1);
    composer.moveRight();
    expect(composer.cursorPosition).toBe(2);
  });

  it('moves to start and end', () => {
    const composer = new ComposerState();
    composer.insert('hello');
    composer.moveToStart();
    expect(composer.cursorPosition).toBe(0);
    composer.moveToEnd();
    expect(composer.cursorPosition).toBe(5);
  });

  it('submits non-empty input', () => {
    const composer = new ComposerState();
    composer.insert('hello world');
    const submitted = composer.submit(1000);
    expect(submitted).toBe(true);
    expect(composer.messages).toHaveLength(1);
    expect(composer.messages[0]).toEqual({ role: 'user', text: 'hello world' });
    expect(composer.input).toBe('');
    expect(composer.cursorPosition).toBe(0);
  });

  it('ignores empty submissions', () => {
    const composer = new ComposerState();
    composer.insert('   ');
    const submitted = composer.submit(1000);
    expect(submitted).toBe(false);
    expect(composer.messages).toHaveLength(0);
  });

  it('prevents rapid duplicate submissions', () => {
    const composer = new ComposerState();
    composer.insert('first');
    composer.submit(1000);
    composer.insert('second');
    const second = composer.submit(1100); // within 200ms debounce
    expect(second).toBe(false);
    expect(composer.messages).toHaveLength(1);
  });

  it('allows submissions after debounce window', () => {
    const composer = new ComposerState();
    composer.insert('first');
    composer.submit(1000);
    composer.insert('second');
    const second = composer.submit(1300); // after 200ms
    expect(second).toBe(true);
    expect(composer.messages).toHaveLength(2);
  });

  it('navigates history up and down', () => {
    const composer = new ComposerState();
    composer.insert('first');
    composer.submit(1000);
    composer.insert('second');
    composer.submit(1300);

    composer.historyUp();
    expect(composer.input).toBe('second');
    composer.historyUp();
    expect(composer.input).toBe('first');
    composer.historyDown();
    expect(composer.input).toBe('second');
    composer.historyDown();
    expect(composer.input).toBe('');
  });

  it('preserves draft when navigating history', () => {
    const composer = new ComposerState();
    composer.insert('first');
    composer.submit(1000);
    composer.insert('draft');
    composer.historyUp();
    expect(composer.input).toBe('first');
    composer.historyDown();
    expect(composer.input).toBe('draft');
  });

  it('cancels current input', () => {
    const composer = new ComposerState();
    composer.insert('some text');
    composer.cancel();
    expect(composer.input).toBe('');
    expect(composer.cursorPosition).toBe(0);
  });

  it('handles multiline input', () => {
    const composer = new ComposerState();
    composer.insert('line1\nline2');
    expect(composer.input).toBe('line1\nline2');
    expect(composer.cursorPosition).toBe(11);
  });

  it('reports isEmpty correctly', () => {
    const composer = new ComposerState();
    expect(composer.isEmpty).toBe(true);
    composer.insert('x');
    expect(composer.isEmpty).toBe(false);
  });
});
