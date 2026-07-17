import { afterEach, describe, expect, it } from 'vitest';

import { fullTheme, monoTheme } from '../src/theme.js';
import {
  LOGO,
  renderScreen,
  setActiveTheme,
  type ApprovalCardInfo,
  type EditCardInfo,
  type StatusInfo,
} from '../src/tui.js';

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

// The visible width of a rendered line, ignoring ANSI escape sequences.
function visibleWidth(line: string): number {
  return stripAnsi(line).length;
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
    const screen = stripAnsi(renderScreen(120, 36, '0.0.0'));
    for (const line of LOGO) {
      expect(screen).toContain(line);
    }
  });

  it('shows the version', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0'));
    expect(screen).toContain('v0.0.0');
  });

  it('shows the compact session panel with model status', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0'));
    expect(screen).toContain('Oh My Code');
    expect(screen).toContain('none');
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
    expect(screen).toContain('streaming');
  });

  it('shows the repository label from status', () => {
    const status: StatusInfo = { ...defaultStatus, repository: 'main · 3 pkg' };
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0', [], '', 0, status));
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

  it('shows a quiet first-run canvas with one contextual tip', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0'));
    expect(screen).not.toContain('Transcript');
    expect(screen).not.toContain('Ready for your next task');
    expect(screen).toContain('Tips: use @path');
  });

  it('pairs the product identity and session card on wide terminals', () => {
    const status: StatusInfo = {
      ...defaultStatus,
      model: 'qwen3.8-max',
      connection: 'done',
      repository: 'main · 1 pkg',
    };
    const screen = stripAnsi(renderScreen(120, 36, '0.0.0', [], '', 0, status));
    const firstFive = screen.split('\r\n').slice(0, 5).join('\n');
    expect(firstFive).toContain(LOGO[0]);
    expect(firstFive).toContain('Oh My Code');
    expect(firstFive).toContain('qwen3.8-max');
    expect(firstFive).toContain('main · 1 pkg');
  });

  it('anchors the composer directly above the footer on an empty tall screen', () => {
    const lines = stripAnsi(renderScreen(120, 36, '0.0.0')).split('\r\n');
    const askRow = lines.findIndex((line) => line.includes('Type your message'));
    const usageRow = lines.findIndex((line) => line.includes('turns: 0'));
    expect(askRow).toBeGreaterThan(20);
    expect(usageRow - askRow).toBeLessThanOrEqual(4);
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

  it('shows the framed input area', () => {
    const screen = stripAnsi(renderScreen(80, 30, '0.0.0'));
    expect(screen).toContain('❯');
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

describe('transcript block rendering', () => {
  it('splits an assistant message into Markdown, code, and reasoning blocks', () => {
    const messages = [
      { role: 'assistant' as const, text: '## Heading\n\n- a point\n```ts\nconst a = 1;\n```\na plain closer' },
    ];
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    expect(screen).toContain('Markdown');
    expect(screen).toContain('Code');
    expect(screen).toContain('[ts]');
    expect(screen).toContain('const a = 1;');
    expect(screen).toContain('Reasoning');
  });

  it('renders an applied edit as a diff block with +/- markers', () => {
    const messages = [
      {
        role: 'tool' as const,
        text: 'Applied edit to src/app.ts.',
        toolName: 'apply_edit',
        toolArgs: 'path: src/app.ts',
        editOutcome: 'applied' as const,
        diff: [
          { kind: 'del' as const, text: 'const a = 1' },
          { kind: 'add' as const, text: 'const a = 2' },
        ],
      },
    ];
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    expect(screen).toContain('Edit applied');
    expect(screen).toContain('- const a = 1');
    expect(screen).toContain('+ const a = 2');
  });

  it('collapses a selected block to a one-line marker', () => {
    const messages = [{ role: 'assistant' as const, text: '## Title\n\n- first\n- second' }];
    const screen = stripAnsi(
      renderScreen(80, 40, '0.0.0', messages, '', 0, defaultStatus, null, null, {
        selectedBlock: 0,
        collapsed: new Set([0]),
      }),
    );
    expect(screen).toContain('Markdown');
    expect(screen).toContain('collapsed');
    expect(screen).not.toContain('first');
  });

  it('shows a transient status message in the footer', () => {
    const status: StatusInfo = { ...defaultStatus, statusMessage: 'Copied block to clipboard' };
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', [], '', 0, status));
    expect(screen).toContain('Copied block to clipboard');
  });

  it('advertises block navigation in the footer hints', () => {
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0'));
    expect(screen).toContain('Tab nav');
  });

  it('reveals fold/copy shortcuts only while a block is selected', () => {
    const messages = [{ role: 'assistant' as const, text: '## Title\n\n- a point' }];
    const idle = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    expect(idle).not.toContain('Ctrl+E fold');
    expect(idle).not.toContain('Ctrl+Y copy');
    const navigating = stripAnsi(
      renderScreen(80, 40, '0.0.0', messages, '', 0, defaultStatus, null, null, {
        selectedBlock: 0,
        collapsed: new Set(),
      }),
    );
    expect(navigating).toContain('Ctrl+E fold');
    expect(navigating).toContain('Ctrl+Y copy');
  });
});

describe('responsive layout', () => {
  // A representative long transcript so the body would overflow small panes.
  const longTranscript = Array.from({ length: 30 }, (_, i) => ({
    role: 'user' as const,
    text: `Message number ${i} with enough text to matter when the pane is small`,
  }));

  it('keeps the composer and footer on-screen at the minimum size', () => {
    const screen = stripAnsi(renderScreen(60, 12, '0.0.0', longTranscript));
    const lines = screen.split('\r\n');
    expect(lines.length).toBe(12);
    expect(screen).toContain('Type your message');
    expect(screen).toContain('Enter');
    expect(screen).toContain('Ctrl+C');
  });

  it('drops the ASCII logo for a compact title on a short terminal', () => {
    const screen = stripAnsi(renderScreen(80, 12, '0.0.0'));
    expect(screen).toContain('Oh My Code');
    expect(screen).not.toContain(LOGO[0]);
  });

  it('keeps the full logo on a wide, tall terminal', () => {
    const screen = stripAnsi(renderScreen(120, 40, '0.0.0'));
    for (const line of LOGO) {
      expect(screen).toContain(line);
    }
  });

  it('collapses the status card to a single line when short', () => {
    const status: StatusInfo = { ...defaultStatus, repository: 'main · 3 pkg' };
    const screen = stripAnsi(renderScreen(80, 12, '0.0.0', [], '', 0, status));
    expect(screen).toContain('none');
    expect(screen).toContain('main · 3 pkg');
    expect(screen).not.toContain('Repository:');
  });

  it('wraps footer hints so every shortcut stays visible when narrow', () => {
    const screen = stripAnsi(renderScreen(40, 30, '0.0.0'));
    expect(screen).toContain('Enter');
    expect(screen).toContain('Tab nav');
    expect(screen).toContain('Ctrl+C');
    expect(screen.split('\r\n').length).toBe(30);
  });

  it('never emits a line wider than the terminal at any size', () => {
    const cases: Array<[number, number]> = [
      [40, 30],
      [60, 12],
      [80, 24],
      [120, 40],
    ];
    for (const [width, height] of cases) {
      const screen = renderScreen(width, height, '0.0.0', longTranscript, 'some input text', 4);
      const lines = screen.split('\r\n');
      expect(lines.length).toBe(height);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('theme-aware rendering', () => {
  // The renderer holds an active theme in module state; restore the identity
  // theme after each case so it cannot leak into other tests.
  afterEach(() => {
    setActiveTheme(fullTheme);
  });

  const richStatus: StatusInfo = {
    ...defaultStatus,
    connection: 'streaming',
    streamingText: 'partial response',
    error: 'Simulated transient network error',
  };

  it('renders the same meaning under the reduced-color theme', () => {
    const messages = [
      { role: 'assistant' as const, text: '## Heading\n```ts\nconst a = 1;\n```\na closer' },
    ];
    setActiveTheme(monoTheme);
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages, '', 0, richStatus));
    // Every meaning is carried by a glyph or label, so the no-hue render keeps them.
    expect(screen).toContain('streaming');
    expect(screen).toContain('Error');
    expect(screen).toContain('Markdown');
    expect(screen).toContain('Code');
    expect(screen).toContain('Reasoning');
  });

  it('emits no hue codes under the reduced-color theme', () => {
    setActiveTheme(monoTheme);
    const raw = renderScreen(80, 40, '0.0.0', [], '', 0, richStatus);
    // Hue families (30-37 / 90-97) must be absent; intensity/structure remain.
    for (const code of ['31', '32', '33', '34', '35', '36', '37', '90']) {
      expect(raw).not.toContain(`\x1b[${code}m`);
    }
  });

  it('uses hue codes under the full-color identity theme', () => {
    setActiveTheme(fullTheme);
    const raw = renderScreen(80, 40, '0.0.0', [], '', 0, richStatus);
    expect(raw).toContain('\x1b[36m');
  });
});

describe('model command rendering', () => {
  it('renders /model output as a labeled Model block, not a raw tool', () => {
    const messages = [
      {
        role: 'tool' as const,
        text: 'Active profile: test\nAvailable profiles:\n- test (test:test-model) [streaming, tools]  (active)',
        toolName: 'model',
        toolArgs: 'list',
        truncated: false,
      },
    ];
    const screen = stripAnsi(renderScreen(80, 40, '0.0.0', messages));
    expect(screen).toContain('Model (list)');
    expect(screen).toContain('Active profile: test');
    // It is a local notice, not a generic tool invocation.
    expect(screen).not.toContain('Tool model');
  });
});
