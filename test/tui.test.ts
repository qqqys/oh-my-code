import { describe, expect, it } from 'vitest';

import { LOGO, renderScreen, type StatusInfo } from '../src/tui.js';

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

const defaultStatus: StatusInfo = {
  model: 'none',
  connection: 'idle',
  streamingText: '',
  error: null,
};

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

  it('shows the model identity from status', () => {
    const status: StatusInfo = { ...defaultStatus, model: 'test:test-model (key set)' };
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', [], '', 0, status));
    expect(screen).toContain('test:test-model');
  });

  it('shows connection state', () => {
    const status: StatusInfo = { ...defaultStatus, connection: 'streaming' };
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', [], '', 0, status));
    expect(screen).toContain('Connection:');
    expect(screen).toContain('streaming');
  });

  it('shows empty transcript placeholder', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0'));
    expect(screen).toContain('Transcript');
    expect(screen).toContain('No messages yet.');
  });

  it('shows submitted user messages in the transcript', () => {
    const messages = [{ role: 'user' as const, text: 'Hello world' }];
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', messages));
    expect(screen).toContain('You');
    expect(screen).toContain('Hello world');
  });

  it('shows assistant messages in the transcript', () => {
    const messages = [{ role: 'assistant' as const, text: 'Assistant reply' }];
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', messages));
    expect(screen).toContain('Assistant');
    expect(screen).toContain('Assistant reply');
  });

  it('shows streaming assistant text', () => {
    const status: StatusInfo = { ...defaultStatus, streamingText: 'partial response' };
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', [], '', 0, status));
    expect(screen).toContain('partial response');
    expect(screen).toContain('streaming');
  });

  it('shows error messages', () => {
    const status: StatusInfo = { ...defaultStatus, error: 'Configuration invalid' };
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', [], '', 0, status));
    expect(screen).toContain('Error');
    expect(screen).toContain('Configuration invalid');
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
