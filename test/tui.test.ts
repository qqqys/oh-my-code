import { describe, expect, it } from 'vitest';

import { LOGO, renderScreen } from '../src/tui.js';

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

describe('TUI screen rendering', () => {
  it('renders the logo', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0'));
    for (const line of LOGO) {
      expect(screen).toContain(line);
    }
  });

  it('shows the version', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0'));
    expect(screen).toContain('v0.0.0');
  });

  it('shows the status card with model status', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0'));
    expect(screen).toContain('Status');
    expect(screen).toContain('Model:');
    expect(screen).toContain('not connected');
  });

  it('shows empty transcript placeholder', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0'));
    expect(screen).toContain('Transcript');
    expect(screen).toContain('No messages yet.');
  });

  it('shows submitted messages in the transcript', () => {
    const messages = [{ role: 'user' as const, text: 'Hello world' }];
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', messages));
    expect(screen).toContain('You');
    expect(screen).toContain('Hello world');
  });

  it('shows the composer area', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0'));
    expect(screen).toContain('Composer');
  });

  it('shows the composer input text', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', [], 'typing', 3));
    expect(screen).toContain('typing');
  });

  it('shows the footer with key hints', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0'));
    expect(screen).toContain('Enter');
    expect(screen).toContain('Ctrl+C');
  });

  it('respects the given dimensions', () => {
    const screen = renderScreen(120, 40, '1.2.3');
    const lines = screen.split('\r\n');
    expect(lines.length).toBe(40);
  });

  it('includes all five LOGO lines', () => {
    expect(LOGO).toHaveLength(5);
  });

  it('wraps long transcript messages', () => {
    const longText = 'a'.repeat(200);
    const messages = [{ role: 'user' as const, text: longText }];
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    expect(screen).toContain('aaaa');
  });

  it('renders Unicode composer input', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', [], '日本語', 2));
    expect(screen).toContain('日本語');
  });
});
