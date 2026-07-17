import { describe, expect, it } from 'vitest';

import {
  LOGO,
  renderScreen,
  type ApprovalCardInfo,
  type EditCardInfo,
  type StatusInfo,
} from '../src/tui.js';

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

const defaultStatus: StatusInfo = {
  model: 'none',
  connection: 'idle',
  streamingText: '',
  error: null,
  usage: { turns: 0, promptTokens: 0, completionTokens: 0 },
  canRetry: false,
  canRegenerate: false,
  canUndo: false,
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

  it('shows the repository label from status', () => {
    const status: StatusInfo = { ...defaultStatus, repository: 'main · 3 pkg' };
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', [], '', 0, status));
    expect(screen).toContain('Repository:');
    expect(screen).toContain('main · 3 pkg');
  });

  it('shows usage in the footer', () => {
    const status: StatusInfo = {
      ...defaultStatus,
      usage: { turns: 3, promptTokens: 20, completionTokens: 22 },
    };
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', [], '', 0, status));
    expect(screen).toContain('turns: 3');
    expect(screen).toContain('tokens: 42');
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

  it('shows tool calls with name and arguments', () => {
    const messages = [
      { role: 'tool' as const, text: 'app.ts\ncli.ts', toolName: 'list_files', toolArgs: 'path: src', truncated: false },
    ];
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', messages));
    expect(screen).toContain('list_files');
    expect(screen).toContain('path: src');
    expect(screen).toContain('app.ts');
  });

  it('shows a truncation indicator for truncated tool output', () => {
    const messages = [
      { role: 'tool' as const, text: 'line 1\nline 2', toolName: 'read_file', toolArgs: 'path: big.txt', truncated: true },
    ];
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', messages));
    expect(screen).toContain('truncated');
  });

  it('preserves multi-turn transcript order', () => {
    const messages = [
      { role: 'user' as const, text: 'First question' },
      { role: 'assistant' as const, text: 'First answer' },
      { role: 'user' as const, text: 'Second question' },
      { role: 'assistant' as const, text: 'Second answer' },
      { role: 'user' as const, text: 'Third question' },
    ];
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    const firstIdx = screen.indexOf('First question');
    const secondIdx = screen.indexOf('Second question');
    const thirdIdx = screen.indexOf('Third question');
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
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

  it('shows the retry hint when a recoverable error occurred', () => {
    const status: StatusInfo = {
      ...defaultStatus,
      connection: 'error',
      error: 'Transient error',
      canRetry: true,
    };
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', [], '', 0, status));
    expect(screen).toContain('Ctrl+R retry');
  });

  it('shows the regenerate hint when an assistant reply exists', () => {
    const messages = [{ role: 'assistant' as const, text: 'Reply' }];
    const status: StatusInfo = { ...defaultStatus, canRegenerate: true };
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', messages, '', 0, status));
    expect(screen).toContain('Ctrl+G regen');
  });

  it('does not show retry or regenerate hints by default', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0'));
    expect(screen).not.toContain('Ctrl+R retry');
    expect(screen).not.toContain('Ctrl+G regen');
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

  it('keeps the footer visible when the transcript overflows', () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: 'user' as const,
      text: `Message number ${i} with some extra text to fill the line`,
    }));
    const status: StatusInfo = { ...defaultStatus, usage: { turns: 5, promptTokens: 10, completionTokens: 12 } };
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', messages, '', 0, status));
    const lines = screen.split('\r\n');
    expect(lines.length).toBe(30);
    // Footer (usage + hints) must remain on-screen even with a long transcript
    expect(screen).toContain('turns: 5');
    expect(screen).toContain('Enter');
    // The earliest messages scroll off
    expect(screen).not.toContain('Message number 0 ');
    expect(screen).toContain('Message number 39');
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

describe('approval boundary rendering', () => {
  const approval: ApprovalCardInfo = {
    command: 'rm -rf tmp',
    cwd: '/repo',
    risk: 'high',
    scope: 'run this exact command in /repo',
    countdown: 5,
  };

  it('renders the approval card with command, directory, risk, and scope', () => {
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', [], '', 0, defaultStatus, approval));
    expect(screen).toContain('Approval required');
    expect(screen).toContain('rm -rf tmp');
    expect(screen).toContain('/repo');
    expect(screen).toContain('Risk:');
    expect(screen).toContain('high');
    expect(screen).toContain('run this exact command in /repo');
    expect(screen).toContain('auto-deny in 5s');
  });

  it('replaces the composer with approval actions while pending', () => {
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', [], '', 0, defaultStatus, approval));
    expect(screen).toContain('y allow once');
    expect(screen).toContain('n deny');
    expect(screen).not.toContain('Composer');
  });

  it('renders a successful command outcome', () => {
    const messages = [
      { role: 'tool' as const, text: 'hello', toolName: 'run_command', toolArgs: 'command: echo hello', outcome: 'ok' as const },
    ];
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    expect(screen).toContain('Command');
    expect(screen).toContain('hello');
  });

  it('renders a denied command distinctly', () => {
    const messages = [
      { role: 'tool' as const, text: 'Denied by user.', toolName: 'run_command', toolArgs: 'command: echo hi', outcome: 'denied' as const },
    ];
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    expect(screen).toContain('Command denied');
    expect(screen).toContain('Denied by user.');
  });

  it('renders a timed-out approval distinctly', () => {
    const messages = [
      { role: 'tool' as const, text: 'Approval window expired; command not run.', toolName: 'run_command', toolArgs: 'command: echo hi', outcome: 'timeout' as const },
    ];
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    expect(screen).toContain('Command timed out');
  });

  it('renders a non-zero exit distinctly', () => {
    const messages = [
      { role: 'tool' as const, text: 'boom', toolName: 'run_command', toolArgs: 'command: false', outcome: 'non-zero' as const },
    ];
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    expect(screen).toContain('Command failed');
  });

  it('renders a cancelled command distinctly', () => {
    const messages = [
      { role: 'tool' as const, text: 'Cancelled before running.', toolName: 'run_command', toolArgs: 'command: sleep 9', outcome: 'cancelled' as const },
    ];
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    expect(screen).toContain('Command cancelled');
  });

  it('flags truncated command output', () => {
    const messages = [
      { role: 'tool' as const, text: 'partial', toolName: 'run_command', toolArgs: 'command: seq 1 1000', outcome: 'ok' as const, truncated: true },
    ];
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    expect(screen).toContain('truncated');
  });
});

describe('edit boundary rendering', () => {
  const edit: EditCardInfo = {
    path: 'src/app.ts',
    diff: [
      { kind: 'del', text: 'const a = 1' },
      { kind: 'add', text: 'const a = 2' },
    ],
    added: 1,
    removed: 1,
  };

  it('renders the proposed-edit card with file, diff, and counts', () => {
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', [], '', 0, defaultStatus, null, edit));
    expect(screen).toContain('Edit proposed');
    expect(screen).toContain('src/app.ts');
    expect(screen).toContain('- const a = 1');
    expect(screen).toContain('+ const a = 2');
    expect(screen).toContain('+1');
    expect(screen).toContain('-1');
  });

  it('replaces the composer with edit actions while pending', () => {
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', [], '', 0, defaultStatus, null, edit));
    expect(screen).toContain('y accept');
    expect(screen).toContain('n reject');
    expect(screen).not.toContain('Composer');
  });

  it('renders an applied edit distinctly', () => {
    const messages = [
      { role: 'tool' as const, text: 'Applied edit to src/app.ts.', toolName: 'apply_edit', toolArgs: 'path: src/app.ts', editOutcome: 'applied' as const },
    ];
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    expect(screen).toContain('Edit applied');
  });

  it('renders a rejected edit distinctly', () => {
    const messages = [
      { role: 'tool' as const, text: 'Rejected by user; file unchanged.', toolName: 'apply_edit', toolArgs: 'path: src/app.ts', editOutcome: 'rejected' as const },
    ];
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    expect(screen).toContain('Edit rejected');
  });

  it('renders a reverted edit distinctly', () => {
    const messages = [
      { role: 'tool' as const, text: 'Reverted edit to src/app.ts.', toolName: 'apply_edit', toolArgs: 'path: src/app.ts', editOutcome: 'reverted' as const },
    ];
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    expect(screen).toContain('Edit reverted');
  });

  it('renders an edit conflict distinctly', () => {
    const messages = [
      { role: 'tool' as const, text: 'File changed; cannot apply edit.', toolName: 'apply_edit', toolArgs: 'path: src/app.ts', editOutcome: 'conflict' as const },
    ];
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    expect(screen).toContain('Edit conflict');
  });

  it('shows the undo hint when an edit is revertable', () => {
    const status: StatusInfo = { ...defaultStatus, canUndo: true };
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', [], '', 0, status));
    expect(screen).toContain('Ctrl+U undo');
  });
});
