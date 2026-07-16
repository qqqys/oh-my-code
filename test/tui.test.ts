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

  it('shows the transcript area', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0'));
    expect(screen).toContain('Transcript');
    expect(screen).toContain('No messages yet.');
  });

  it('shows the composer area', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0'));
    expect(screen).toContain('Composer');
    expect(screen).toContain('Type a message or command');
  });

  it('shows the footer with exit hint', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0'));
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
});
